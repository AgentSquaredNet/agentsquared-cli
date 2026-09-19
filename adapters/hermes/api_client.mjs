import { randomUUID } from 'node:crypto'
import { buildHermesApiBase } from './common.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export async function fetchHermesJson(apiBase, pathname, {
  method = 'GET',
  apiKey = '',
  body = null,
  timeoutMs = 10000,
  extraHeaders = {}
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs))
  try {
    const headers = { ...extraHeaders }
    if (clean(apiKey)) {
      headers.Authorization = `Bearer ${clean(apiKey)}`
    }
    if (body != null) {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`${apiBase.replace(/\/$/, '')}${pathname}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
    const sessionId = response.headers.get('x-hermes-session-id') || response.headers.get('X-Hermes-Session-Id') || ''
    return {
      ok: response.ok,
      status: response.status,
      payload,
      sessionId
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseSseFrame(frame = '') {
  const lines = `${frame}`.split(/\r?\n/)
  let event = ''
  const dataLines = []
  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue
    }
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator).trim() : line.trim()
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : ''
    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      dataLines.push(value)
    }
  }
  const dataText = dataLines.join('\n')
  if (!dataText || dataText === '[DONE]') {
    return { event, data: dataText }
  }
  try {
    return { event, data: JSON.parse(dataText) }
  } catch {
    return { event, data: dataText }
  }
}

export async function fetchHermesSse(apiBase, pathname, {
  method = 'POST',
  apiKey = '',
  body = null,
  timeoutMs = 180000,
  onEvent = null,
  extraHeaders = {}
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs))
  try {
    const headers = { ...extraHeaders, Accept: 'text/event-stream' }
    if (clean(apiKey)) {
      headers.Authorization = `Bearer ${clean(apiKey)}`
    }
    if (body != null) {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`${apiBase.replace(/\/$/, '')}${pathname}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const sessionId = response.headers.get('x-hermes-session-id') || response.headers.get('X-Hermes-Session-Id') || ''
    if (!response.ok) {
      const text = await response.text()
      let payload = text
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        // keep raw text
      }
      return { ok: false, status: response.status, payload, sessionId }
    }
    if (!response.body?.getReader) {
      throw new Error('Hermes API server did not return a readable SSE body.')
    }
    const reader = response.body.getReader()
    try {
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.search(/\r?\n\r?\n/)
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/)
        buffer = buffer.slice(boundary + (match?.[0]?.length || 2))
        const parsed = parseSseFrame(frame)
        if (parsed.data !== '') {
          await onEvent?.(parsed)
        }
        boundary = buffer.search(/\r?\n\r?\n/)
      }
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail) {
      await onEvent?.(parseSseFrame(tail))
    }
    return { ok: true, status: response.status, sessionId }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  } finally {
    clearTimeout(timeout)
  }
}

export function extractHermesResponseText(payload = null) {
  const output = Array.isArray(payload?.output) ? payload.output : []
  const message = output.findLast?.((item) => item?.type === 'message')
    ?? [...output].reverse().find((item) => item?.type === 'message')
  const content = Array.isArray(message?.content) ? message.content : []
  const textBlock = content.find((item) => item?.type === 'output_text' && clean(item?.text))
  return clean(textBlock?.text)
}

export function extractHermesRuntimeUsage(payload = null) {
  if (payload == null) {
    return null
  }
  const session = payload.session
    ?? (payload.object === 'hermes.session' ? payload : null)
    ?? (payload.input_tokens != null || payload.inputTokens != null ? payload : null)
  const usage = session
    ? {
        input_tokens: session.input_tokens ?? session.inputTokens,
        output_tokens: session.output_tokens ?? session.outputTokens,
        cache_creation_input_tokens: session.cache_write_tokens ?? session.cacheWriteTokens,
        cache_read_input_tokens: session.cache_read_tokens ?? session.cacheReadTokens
      }
    : (payload?.usage ?? payload?.response?.usage ?? payload?.metadata?.usage)

  const input = Number.parseInt(`${usage?.input_tokens ?? usage?.inputTokens ?? ''}`, 10)
  const output = Number.parseInt(`${usage?.output_tokens ?? usage?.outputTokens ?? ''}`, 10)
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return null
  }
  const cacheCreation = Number.parseInt(`${
    usage?.cache_creation_input_tokens ?? 
    usage?.cacheCreationInputTokens ?? 
    usage?.prompt_tokens_details?.cache_creation_input_tokens ?? 
    ''
  }`, 10)
  const cacheRead = Number.parseInt(`${
    usage?.cache_read_input_tokens ?? 
    usage?.cacheReadInputTokens ?? 
    usage?.prompt_tokens_details?.cached_tokens ?? 
    usage?.promptTokensDetails?.cachedTokens ?? 
    ''
  }`, 10)

  const hasCache = Number.isFinite(cacheCreation) || Number.isFinite(cacheRead)

  return {
    runtime: 'hermes',
    usageMode: hasCache ? 'four_tier' : 'two_tier',
    accurate: true,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: Number.isFinite(cacheCreation) ? cacheCreation : null,
    cacheReadInputTokens: Number.isFinite(cacheRead) ? cacheRead : null
  }
}

export function hermesResponseToolCalls(payload = null) {
  const output = Array.isArray(payload?.output) ? payload.output : []
  return output
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({
      name: clean(item?.name),
      arguments: item?.arguments ?? null,
      callId: clean(item?.call_id)
    }))
}

export async function checkHermesApiServerHealth({
  apiBase = '',
  envVars = {},
  timeoutMs = 5000
} = {}) {
  const resolvedBase = buildHermesApiBase({ apiBase, envVars })
  try {
    const health = await fetchHermesJson(resolvedBase, '/health', { timeoutMs })
    if (!health.ok || clean(health?.payload?.status).toLowerCase() !== 'ok') {
      return {
        ok: false,
        apiBase: resolvedBase,
        reason: health.ok ? 'health-not-ok' : `health-http-${health.status}`,
        health
      }
    }
    const models = await fetchHermesJson(resolvedBase, '/v1/models', {
      timeoutMs,
      apiKey: clean(envVars.API_SERVER_KEY)
    })
    if (!models.ok) {
      return {
        ok: false,
        apiBase: resolvedBase,
        reason: `models-http-${models.status}`,
        health,
        models
      }
    }
    const capabilities = await fetchHermesJson(resolvedBase, '/v1/capabilities', {
      timeoutMs,
      apiKey: clean(envVars.API_SERVER_KEY)
    })
    if (!capabilities.ok) {
      return {
        ok: false,
        apiBase: resolvedBase,
        reason: `capabilities-http-${capabilities.status}`,
        health,
        models,
        capabilities
      }
    }
    if (['responses_api', 'run_status', 'run_events_sse', 'run_stop'].some((key) => capabilities.payload?.features?.[key] !== true)) {
      return {
        ok: false,
        apiBase: resolvedBase,
        reason: 'capabilities-responses-or-runs-missing',
        health,
        models,
        capabilities
      }
    }
    return {
      ok: true,
      apiBase: resolvedBase,
      health,
      models,
      capabilities
    }
  } catch (error) {
    return {
      ok: false,
      apiBase: resolvedBase,
      reason: clean(error?.name) === 'AbortError' ? 'timeout' : (clean(error?.message) || 'api-server-unreachable'),
      error: clean(error?.message) || 'api-server-unreachable'
    }
  }
}

export async function postHermesResponse({
  apiBase = '',
  envVars = {},
  input = '',
  instructions = '',
  conversation = '',
  timeoutMs = 180000,
  store = false,
  onSessionId = null
} = {}) {
  const resolvedBase = buildHermesApiBase({ apiBase, envVars })
  const response = await fetchHermesJson(resolvedBase, '/v1/responses', {
    method: 'POST',
    apiKey: clean(envVars.API_SERVER_KEY),
    timeoutMs,
    body: {
      input,
      instructions,
      conversation: clean(conversation) || undefined,
      // AgentSquared supplies explicit conversation context itself. Avoid
      // chaining Hermes API responses, because tool traces from a previous
      // local turn can otherwise bleed into the next structured turn.
      store: Boolean(store)
    }
  })
  if (response.sessionId && typeof onSessionId === 'function') {
    onSessionId(response.sessionId)
  }
  if (!response.ok) {
    const detail = clean(response?.payload?.error?.message || response?.payload?.message || response?.payload)
    throw new Error(detail || `Hermes API server request failed with status ${response.status}`)
  }
  const toolCalls = hermesResponseToolCalls(response.payload)
  if (toolCalls.length > 0) {
    const error = new Error('Hermes API server returned tool calls during AgentSquared execution. Configure Hermes platform_toolsets.api_server to no_mcp so AgentSquared runs through the public API without host tools.')
    error.code = 'hermes-api-server-tools-not-isolated'
    error.toolCalls = toolCalls
    throw error
  }
  return response.payload
}

export function hermesRunInput(input) {
  if (!Array.isArray(input)) return input
  // Runs forwards content to run_conversation; it does not perform Responses
  // input_image conversion. The native conversation uses chat content parts.
  return input.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.map(part => {
      if (part.type === 'input_text') return { type: 'text', text: part.text }
      if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } }
      return part
    }) : message.content }))
}

export async function postHermesResponseStream({
  apiBase = '',
  envVars = {},
  input = '',
  instructions = '',
  conversation = '',
  timeoutMs = 180000,
  store = false,
  onTextDelta = null,
  onSessionId = null
} = {}) {
  const resolvedBase = buildHermesApiBase({ apiBase, envVars })
  const apiKey = clean(envVars.API_SERVER_KEY)
  const startedAt = Date.now()
  const remaining = () => Math.max(250, timeoutMs - (Date.now() - startedAt))
  const started = await fetchHermesJson(resolvedBase, '/v1/runs', {
    method: 'POST', apiKey, timeoutMs: remaining(),
    extraHeaders: { 'Idempotency-Key': randomUUID(), ...(conversation ? { 'X-Hermes-Session-Key': conversation } : {}) },
    body: { input: hermesRunInput(input), instructions }
  })
  const runId = started.payload?.run_id
  if (!started.ok || !runId) throw new Error(`Hermes run creation failed (HTTP ${started.status})`)
  const route = `/v1/runs/${encodeURIComponent(runId)}`
  let terminal = null
  try {
    // Reconnecting subscribes to the same run; never repeat run creation.
    try {
      const stream = await fetchHermesSse(resolvedBase, `${route}/events`, {
        method: 'GET', apiKey, timeoutMs: remaining(),
        onEvent: async ({ event, data }) => {
          const type = data?.event || event
          if (type === 'message.delta') await onTextDelta?.(`${data.delta ?? ''}`)
          if (type === 'approval.request') {
            await fetchHermesJson(resolvedBase, `${route}/approval`, {
              method: 'POST', apiKey, timeoutMs: remaining(),
              body: { request_id: data.request_id, choice: 'deny' }
            })
          }
          if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) terminal = data
        }
      })
      if (!stream.ok && stream.status !== 404) throw new Error(`Hermes events failed (HTTP ${stream.status})`)
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) throw error
      // Read authoritative status after transport loss instead of claiming completion.
    }
    while (Date.now() - startedAt < timeoutMs) {
      const status = await fetchHermesJson(resolvedBase, route, { apiKey, timeoutMs: remaining() })
      if (!status.ok) throw new Error(`Hermes run status failed (HTTP ${status.status})`)
      const value = status.payload
      if (value.session_id) onSessionId?.(value.session_id)
      if (value.status === 'completed') {
        return { output: [{ type: 'message', content: [{ type: 'output_text', text: value.output ?? terminal?.output ?? '' }] }], usage: value.usage ?? terminal?.usage }
      }
      if (['failed', 'cancelled'].includes(value.status)) throw new Error(`Hermes run ${value.status}${value.error ? `: ${value.error}` : ''}`)
      await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining())))
    }
    throw new Error('Hermes run timed out')
  } catch (error) {
    try {
      const stopped = await fetchHermesJson(resolvedBase, `${route}/stop`, { method: 'POST', apiKey, body: {}, timeoutMs: 10000 })
      if (!stopped.ok) error.message += `; run cancellation unconfirmed (HTTP ${stopped.status})`
    } catch { error.message += '; run cancellation unconfirmed' }
    throw error
  }
}

export async function getHermesSessionInfo(apiBase, envVars, sessionId) {
  const resolvedBase = buildHermesApiBase({ apiBase, envVars })
  const response = await fetchHermesJson(resolvedBase, `/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    apiKey: clean(envVars.API_SERVER_KEY),
    timeoutMs: 10000
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch Hermes session info: ${response.status} ${clean(response.payload?.error?.message || response.payload)}`)
  }
  return response.payload
}
