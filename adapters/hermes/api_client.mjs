import { buildHermesApiBase } from './common.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export async function fetchHermesJson(apiBase, pathname, {
  method = 'GET',
  apiKey = '',
  body = null,
  timeoutMs = 10000
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs))
  try {
    const headers = {}
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
    return {
      ok: response.ok,
      status: response.status,
      payload
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
  onEvent = null
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs))
  try {
    const headers = { Accept: 'text/event-stream' }
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
    if (!response.ok) {
      const text = await response.text()
      let payload = text
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        // keep raw text
      }
      return { ok: false, status: response.status, payload }
    }
    if (!response.body?.getReader) {
      throw new Error('Hermes API server did not return a readable SSE body.')
    }
    const reader = response.body.getReader()
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
    const tail = buffer.trim()
    if (tail) {
      await onEvent?.(parseSseFrame(tail))
    }
    return { ok: true, status: response.status }
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
    if (capabilities.payload?.features?.responses_api !== true) {
      return {
        ok: false,
        apiBase: resolvedBase,
        reason: 'capabilities-responses-api-missing',
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
  store = false
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

export async function postHermesResponseStream({
  apiBase = '',
  envVars = {},
  input = '',
  instructions = '',
  conversation = '',
  timeoutMs = 180000,
  store = false,
  onTextDelta = null
} = {}) {
  const resolvedBase = buildHermesApiBase({ apiBase, envVars })
  let completedPayload = null
  let failedPayload = null
  let accumulatedText = ''
  const response = await fetchHermesSse(resolvedBase, '/v1/responses', {
    method: 'POST',
    apiKey: clean(envVars.API_SERVER_KEY),
    timeoutMs,
    body: {
      input,
      instructions,
      conversation: clean(conversation) || undefined,
      store: Boolean(store),
      stream: true
    },
    onEvent: async ({ event, data }) => {
      const type = clean(data?.type || event)
      if (type === 'response.output_text.delta') {
        const delta = `${data?.delta ?? ''}`
        if (delta) {
          accumulatedText += delta
          await onTextDelta?.(delta)
        }
        return
      }
      if (type === 'response.completed') {
        completedPayload = data?.response ?? data
        return
      }
      if (type === 'response.failed') {
        failedPayload = data?.response ?? data
      }
    }
  })
  if (!response.ok) {
    const detail = clean(response?.payload?.error?.message || response?.payload?.message || response?.payload)
    throw new Error(detail || `Hermes API server stream request failed with status ${response.status}`)
  }
  if (failedPayload) {
    const detail = clean(failedPayload?.error?.message || failedPayload?.message)
    throw new Error(detail || 'Hermes API server stream failed.')
  }
  if (completedPayload) {
    return completedPayload
  }
  return {
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: accumulatedText }]
    }]
  }
}
