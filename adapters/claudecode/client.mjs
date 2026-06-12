export const CLAUDE_CODE_SAFE_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Skill'
])

export const CLAUDE_CODE_DENIED_TOOLS = Object.freeze([
  'Bash',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'TodoWrite',
  'mcp__*'
])

function clean(value) {
  return `${value ?? ''}`.trim()
}

function normalizeSettingSources(value = '') {
  const normalized = clean(value).toLowerCase()
  if (!normalized || normalized === 'none') {
    return undefined
  }
  if (normalized === 'all') {
    return undefined
  }
  return normalized
    .split(',')
    .map((item) => clean(item).toLowerCase())
    .filter((item) => item === 'user' || item === 'project' || item === 'local')
}

function toolMatches(pattern = '', toolName = '') {
  const normalizedPattern = clean(pattern)
  const normalizedTool = clean(toolName)
  if (!normalizedPattern || !normalizedTool) {
    return false
  }
  if (normalizedPattern.endsWith('*')) {
    return normalizedTool.startsWith(normalizedPattern.slice(0, -1))
  }
  return normalizedPattern === normalizedTool
}

export function buildClaudeCodeSafeOptions({
  claudeCommand = 'claude',
  cwd = '',
  model = '',
  timeoutMs = 180000,
  maxTurns = 3,
  settingSources = 'none',
  resume = '',
  persistSession = true,
  includePartialMessages = false,
  outputFormat = null
} = {}) {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), Math.max(1000, timeoutMs))
  timeout.unref?.()

  const disallowedTools = [...CLAUDE_CODE_DENIED_TOOLS]
  const options = {
    abortController,
    cwd: clean(cwd) || process.cwd(),
    pathToClaudeCodeExecutable: clean(claudeCommand) || 'claude',
    permissionMode: 'dontAsk',
    extraArgs: {
      'safe-mode': null
    },
    tools: [...CLAUDE_CODE_SAFE_TOOLS],
    allowedTools: [...CLAUDE_CODE_SAFE_TOOLS],
    disallowedTools,
    canUseTool: async (toolName) => {
      if (disallowedTools.some((pattern) => toolMatches(pattern, toolName))) {
        return {
          behavior: 'deny',
          message: `AgentSquared Claude Code adapter denied ${clean(toolName) || 'this tool'} in safe read-only mode.`
        }
      }
      if (!CLAUDE_CODE_SAFE_TOOLS.includes(clean(toolName))) {
        return {
          behavior: 'deny',
          message: `AgentSquared Claude Code adapter only allows safe read-only tools by default.`
        }
      }
      return { behavior: 'allow' }
    },
    maxTurns: Math.max(1, Number.parseInt(`${maxTurns ?? 3}`, 10) || 3),
    persistSession: Boolean(persistSession),
    includePartialMessages: Boolean(includePartialMessages),
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agentsquared-cli'
    }
  }
  if (clean(model)) {
    options.model = clean(model)
  }
  const normalizedSettingSources = normalizeSettingSources(settingSources)
  if (normalizedSettingSources !== undefined) {
    options.settingSources = normalizedSettingSources
  }
  if (clean(resume)) {
    options.resume = clean(resume)
  }
  if (outputFormat) {
    options.outputFormat = outputFormat
  }
  return { options, clearTimeout: () => clearTimeout(timeout) }
}

function textFromContent(content) {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return part
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        return part.text
      }
      if (typeof part?.text === 'string') {
        return part.text
      }
      return ''
    }).filter(Boolean).join('')
  }
  return ''
}

function deltaFromStreamEvent(event = null) {
  if (event?.type === 'content_block_delta') {
    return `${event?.delta?.text ?? ''}`
  }
  if (event?.type === 'message_delta') {
    return `${event?.delta?.text ?? ''}`
  }
  return ''
}

export function extractClaudeCodeUsage(resultMessage = null) {
  const usage = resultMessage?.usage
  if (!usage || typeof usage !== 'object') {
    return null
  }
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0
  return {
    runtime: 'claudecode',
    usageMode: 'four_tier',
    accurate: true,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens
  }
}

export class ClaudeCodeClient {
  constructor({
    claudeCommand = 'claude',
    cwd = '',
    model = '',
    timeoutMs = 180000,
    maxTurns = 3,
    settingSources = 'none',
    queryImpl = null
  } = {}) {
    this.claudeCommand = clean(claudeCommand) || 'claude'
    this.cwd = clean(cwd) || process.cwd()
    this.model = clean(model)
    this.timeoutMs = Math.max(1000, timeoutMs)
    this.maxTurns = Math.max(1, maxTurns)
    this.settingSources = clean(settingSources) || 'none'
    this.queryImpl = queryImpl
  }

  async query(prompt, {
    resume = '',
    persistSession = true,
    includePartialMessages = false,
    emitDelta = null,
    outputFormat = null
  } = {}) {
    const queryFunction = this.queryImpl || (await import('@anthropic-ai/claude-agent-sdk')).query
    const safeOptions = buildClaudeCodeSafeOptions({
      claudeCommand: this.claudeCommand,
      cwd: this.cwd,
      model: this.model,
      timeoutMs: this.timeoutMs,
      maxTurns: this.maxTurns,
      settingSources: this.settingSources,
      resume,
      persistSession,
      includePartialMessages,
      outputFormat
    })

    let assistantText = ''
    let resultText = ''
    let sessionId = clean(resume)
    let resultMessage = null
    try {
      for await (const message of queryFunction({
        prompt,
        options: safeOptions.options
      })) {
        sessionId = clean(message?.session_id) || sessionId
        if (message?.type === 'assistant') {
          assistantText += textFromContent(message?.message?.content)
        } else if (message?.type === 'stream_event') {
          const delta = deltaFromStreamEvent(message?.event)
          if (delta && typeof emitDelta === 'function') {
            await emitDelta(delta)
          }
        } else if (message?.type === 'result') {
          resultMessage = message
          resultText = clean(message?.structured_output ? JSON.stringify(message.structured_output) : message?.result)
        }
      }
    } finally {
      safeOptions.clearTimeout()
    }
    return {
      text: resultText || assistantText,
      assistantText,
      resultText,
      sessionId,
      resultMessage,
      usage: extractClaudeCodeUsage(resultMessage)
    }
  }
}
