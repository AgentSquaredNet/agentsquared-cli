import { spawn } from 'node:child_process'

import { buildHermesProcessEnv } from './common.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function parseJsonText(value = '') {
  const text = clean(value)
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function mcpContentText(result = null) {
  const content = Array.isArray(result?.content) ? result.content : []
  return clean(content.map((item) => clean(item?.text)).filter(Boolean).join('\n'))
}

function parseToolPayload(result = null) {
  return parseJsonText(mcpContentText(result)) ?? result
}

function extractTools(payload = null) {
  if (Array.isArray(payload?.tools)) {
    return payload.tools
  }
  if (Array.isArray(payload?.result?.tools)) {
    return payload.result.tools
  }
  return []
}

function internalConversationPlatform(platform = '') {
  return new Set(['', 'api', 'api_server', 'cli', 'local', 'tool', 'webhook'])
    .has(clean(platform).toLowerCase())
}

function normalizeMcpError(error = null) {
  const message = clean(error?.message || error)
  const code = clean(error?.code)
  return [message, code].filter(Boolean).join('; ') || 'hermes-mcp-error'
}

class HermesMcpClient {
  constructor({
    command = 'hermes',
    hermesHome = '',
    timeoutMs = 30000
  } = {}) {
    this.command = clean(command) || 'hermes'
    this.hermesHome = clean(hermesHome)
    this.timeoutMs = Math.max(500, Number.parseInt(`${timeoutMs}`, 10) || 30000)
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stderr = ''
    this.closed = false
    this.child = null
  }

  start() {
    if (this.child) {
      return
    }
    this.child = spawn(this.command, ['mcp', 'serve'], {
      env: buildHermesProcessEnv({ hermesHome: this.hermesHome }),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stdout.on('data', (chunk) => this.#handleData(chunk))
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString()
    })
    this.child.on('error', (error) => this.#rejectAll(error))
    this.child.on('close', (code, signal) => {
      this.closed = true
      this.#rejectAll(new Error(`Hermes MCP server exited with code ${code ?? ''}${signal ? ` signal ${signal}` : ''}`))
    })
  }

  async initialize() {
    this.start()
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'agentsquared-cli',
        version: '1.6.1'
      }
    })
    this.notify('notifications/initialized', {})
  }

  async listTools() {
    const result = await this.request('tools/list', {})
    return extractTools(result)
  }

  async callTool(name, args = {}) {
    return this.request('tools/call', {
      name,
      arguments: args
    })
  }

  notify(method, params = {}) {
    this.#write({
      jsonrpc: '2.0',
      method,
      params
    })
  }

  request(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new Error('Hermes MCP server is closed'))
    }
    const id = this.nextId
    this.nextId += 1
    this.#write({
      jsonrpc: '2.0',
      id,
      method,
      params
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Hermes MCP request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  close() {
    this.closed = true
    try {
      this.child?.kill('SIGTERM')
    } catch {
      // best effort
    }
    this.#rejectAll(new Error('Hermes MCP client closed'))
  }

  #write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #handleData(chunk) {
    this.buffer += chunk.toString('utf8')
    while (true) {
      const lineEnd = this.buffer.indexOf('\n')
      if (lineEnd < 0) {
        return
      }
      const raw = clean(this.buffer.slice(0, lineEnd))
      this.buffer = this.buffer.slice(lineEnd + 1)
      if (!raw) {
        continue
      }
      let message = null
      try {
        message = JSON.parse(raw)
      } catch {
        continue
      }
      if (message?.id == null) {
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) {
        continue
      }
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(normalizeMcpError(message.error)))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  #rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}

export async function withHermesMcpClient({
  command = 'hermes',
  hermesHome = '',
  timeoutMs = 30000
} = {}, fn) {
  const client = new HermesMcpClient({ command, hermesHome, timeoutMs })
  try {
    await client.initialize()
    return await fn(client)
  } finally {
    client.close()
  }
}

export async function probeHermesMcp({
  command = 'hermes',
  hermesHome = '',
  timeoutMs = 10000
} = {}) {
  try {
    return await withHermesMcpClient({ command, hermesHome, timeoutMs }, async (client) => {
      const tools = await client.listTools()
      const toolNames = tools.map((tool) => clean(tool?.name)).filter(Boolean)
      for (const required of ['conversations_list', 'conversation_get', 'messages_send', 'channels_list']) {
        if (!toolNames.includes(required)) {
          return {
            ok: false,
            reason: `missing-tool-${required}`,
            tools: toolNames
          }
        }
      }
      return {
        ok: true,
        tools: toolNames
      }
    })
  } catch (error) {
    return {
      ok: false,
      reason: normalizeMcpError(error),
      error: clean(error?.message)
    }
  }
}

function routeFromConversationDetail(detail = null) {
  const platform = clean(detail?.platform).toLowerCase()
  const chatId = clean(detail?.chat_id)
  if (platform && chatId && !internalConversationPlatform(platform)) {
    return {
      target: `${platform}:${chatId}`,
      source: 'hermes-mcp-conversation',
      sessionId: clean(detail?.session_key || detail?.session_id),
      sessionSource: platform
    }
  }
  return { target: '', source: 'none' }
}

function routeFromChannel(channel = null) {
  const target = clean(channel?.target)
  if (!target) {
    return { target: '', source: 'none' }
  }
  return {
    target,
    source: 'hermes-mcp-channel-directory',
    sessionSource: clean(channel?.platform).toLowerCase()
  }
}

export async function resolveHermesOwnerTargetViaMcp({
  command = 'hermes',
  hermesHome = '',
  timeoutMs = 30000
} = {}) {
  return withHermesMcpClient({ command, hermesHome, timeoutMs }, async (client) => {
    const conversationsResult = await client.callTool('conversations_list', { limit: 100 })
    const conversationsPayload = parseToolPayload(conversationsResult)
    const conversations = Array.isArray(conversationsPayload?.conversations)
      ? conversationsPayload.conversations
      : []

    for (const conversation of conversations) {
      const platform = clean(conversation?.platform).toLowerCase()
      const sessionKey = clean(conversation?.session_key)
      if (internalConversationPlatform(platform) || !sessionKey) {
        continue
      }
      const detailResult = await client.callTool('conversation_get', { session_key: sessionKey })
      const route = routeFromConversationDetail(parseToolPayload(detailResult))
      if (route.target) {
        return route
      }
    }

    const channelsResult = await client.callTool('channels_list', {})
    const channelsPayload = parseToolPayload(channelsResult)
    const channels = Array.isArray(channelsPayload?.channels) ? channelsPayload.channels : []
    const first = channels
      .map((channel) => routeFromChannel(channel))
      .find((route) => route.target)
    return first || { target: '', source: 'none' }
  })
}

export async function sendHermesOwnerMessageViaMcp({
  command = 'hermes',
  hermesHome = '',
  target = '',
  message = '',
  timeoutMs = 30000
} = {}) {
  const resolvedTarget = clean(target)
  const resolvedMessage = clean(message)
  if (!resolvedTarget || !resolvedMessage) {
    return {
      delivered: false,
      attempted: false,
      reason: !resolvedTarget ? 'owner-route-not-found' : 'empty-owner-report'
    }
  }
  try {
    return await withHermesMcpClient({ command, hermesHome, timeoutMs }, async (client) => {
      const result = await client.callTool('messages_send', {
        target: resolvedTarget,
        message: resolvedMessage
      })
      const payload = parseToolPayload(result)
      if (payload?.error) {
        return {
          delivered: false,
          attempted: true,
          reason: clean(payload.error) || 'send-message-failed',
          payload
        }
      }
      return {
        delivered: true,
        attempted: true,
        payload
      }
    })
  } catch (error) {
    return {
      delivered: false,
      attempted: true,
      reason: normalizeMcpError(error)
    }
  }
}
