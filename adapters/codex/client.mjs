import { spawn } from 'node:child_process'
import readline from 'node:readline'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export function resolveCodexThreadId(value = null) {
  if (typeof value === 'string') {
    return clean(value)
  }
  return clean(
    value?.id
    || value?.threadId
    || value?.thread?.id
    || value?.thread?.threadId
  )
}

export class CodexClient {
  constructor({
    codexPath = '/Applications/Codex.app/Contents/Resources/codex',
    timeoutMs = 180000,
    configOverrides = {
      sandbox_mode: '"read-only"',
      approval_policy: '"never"'
    }
  } = {}) {
    this.codexPath = clean(codexPath) || '/Applications/Codex.app/Contents/Resources/codex'
    this.timeoutMs = Math.max(1000, timeoutMs)
    this.configOverrides = configOverrides && typeof configOverrides === 'object'
      ? Object.entries(configOverrides)
        .map(([key, value]) => [clean(key), clean(value)])
        .filter(([key, value]) => key && value)
      : []
    this.child = null
    this.rl = null
    this.requestId = 0
    this.pending = new Map()
    this.eventListeners = new Set()
    this.connected = false
    this.closed = false
  }

  async connect() {
    if (this.connected && this.child) {
      return
    }

    this.closed = false
    
    // Explicitly pass process.env to preserve http_proxy/https_proxy settings
    const childEnv = {
      ...process.env
    }

    try {
      const args = [
        'app-server',
        ...this.configOverrides.flatMap(([key, value]) => ['--config', `${key}=${value}`]),
        '--listen',
        'stdio://'
      ]
      this.child = spawn(this.codexPath, args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: childEnv
      })
    } catch (error) {
      throw new Error(`Failed to spawn Codex binary at ${this.codexPath}: ${error.message}`)
    }

    this.rl = readline.createInterface({
      input: this.child.stdout,
      output: this.child.stdin,
      terminal: false
    })

    this.rl.on('line', (line) => {
      this.#handleMessage(line)
    })

    this.child.on('close', (code) => {
      this.connected = false
      const error = new Error(`Codex app-server exited with code ${code ?? 'unknown'}`)
      this.#rejectAllPending(error)
    })

    this.child.on('error', (error) => {
      this.connected = false
      this.#rejectAllPending(error)
    })

    // Perform handshake
    await this.#handshake()
    this.connected = true
  }

  #rejectAllPending(error) {
    if (this.pending.size === 0) {
      return
    }
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  #handleMessage(line) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }

    if (parsed.error) {
      const errPayload = parsed.error
      const message = clean(errPayload.message) || 'Codex RPC error'
      const error = new Error(message)
      error.code = errPayload.code
      error.data = errPayload.data
      
      if (parsed.id !== undefined && parsed.id !== null) {
        const pending = this.pending.get(parsed.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(parsed.id)
          pending.reject(error)
        }
      }
      return
    }

    // 1. Response match
    if (parsed.id !== undefined && parsed.id !== null) {
      const pending = this.pending.get(parsed.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(parsed.id)
        pending.resolve(parsed.result ?? null)
      }
      return
    }

    // 2. Notification dispatch
    if (parsed.method) {
      for (const listener of this.eventListeners) {
        try {
          listener(parsed)
        } catch {
          // ignore observer failure
        }
      }
    }
  }

  async #sendRequest(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('Codex sub-process is not active or stdin is closed.')
    }

    this.requestId += 1
    const id = this.requestId

    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex RPC request ${method} (id=${id}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }) + '\n')
    })

    return result
  }

  async #sendNotification(method, params = {}) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('Codex sub-process is not active or stdin is closed.')
    }

    this.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    }) + '\n')
  }

  async #handshake() {
    const handshakeTimeout = 15000
    const hello = await this.#sendRequest('initialize', {
      clientInfo: {
        name: 'AgentSquaredCodexClient',
        version: '1.6.15'
      },
      capabilities: {}
    }, handshakeTimeout)

    await this.#sendNotification('initialized', {})
    return hello
  }

  onEvent(listener) {
    if (typeof listener !== 'function') {
      return () => {}
    }
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  async threadList(limit = 20) {
    return this.#sendRequest('thread/list', { limit })
  }

  async threadStart(options = {}) {
    const params = {}
    if (options?.ephemeral === true) {
      params.ephemeral = true
    }
    return this.#sendRequest('thread/start', params)
  }

  async threadResume(threadId) {
    return this.#sendRequest('thread/resume', { threadId: clean(threadId) })
  }

  async threadNameSet(threadId, name) {
    return this.#sendRequest('thread/name/set', {
      threadId: clean(threadId),
      name: clean(name)
    })
  }

  async turnStart(threadId, promptText) {
    return this.#sendRequest('turn/start', {
      threadId: clean(threadId),
      input: [
        {
          type: 'text',
          text: promptText
        }
      ]
    })
  }

  async smokeTurn({
    prompt = 'Reply with exactly: OK',
    timeoutMs = 45000
  } = {}) {
    const thread = await this.threadStart({ ephemeral: true })
    const threadId = resolveCodexThreadId(thread)
    if (!threadId) {
      throw new Error('Codex thread/start did not return a thread id.')
    }

    let text = ''
    let unsubscribe = () => {}
    let timer = null
    let settled = false
    function cleanup() {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe()
    }
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Codex smoke turn timed out after ${timeoutMs}ms`))
      }, Math.max(1000, timeoutMs))

      unsubscribe = this.onEvent((event) => {
        if (event.method === 'item/agentMessage/delta') {
          text += event.params?.delta || event.params?.contentDelta || ''
        }
        if (event.method === 'turn/completed') {
          cleanup()
          const status = clean(event.params?.turn?.status)
          if (status === 'failed') {
            reject(new Error(event.params?.turn?.error?.message || 'Codex smoke turn failed'))
          } else {
            resolve({ threadId, text })
          }
        }
      })
    })

    try {
      await this.turnStart(threadId, prompt)
      return await completed
    } catch (error) {
      cleanup()
      throw error
    }
  }

  async close() {
    if (this.closed) {
      return
    }
    this.closed = true
    this.connected = false

    if (this.rl) {
      try {
        this.rl.close()
      } catch {
        // ignore
      }
    }

    const child = this.child
    this.child = null

    if (child) {
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          resolve(true)
        }, 1000)

        child.once('exit', () => {
          clearTimeout(killTimer)
          resolve(true)
        })

        try {
          child.kill('SIGTERM')
        } catch {
          clearTimeout(killTimer)
          resolve(true)
        }
      })
    }
    this.#rejectAllPending(new Error('CodexClient connection closed explicitly.'))
  }
}
