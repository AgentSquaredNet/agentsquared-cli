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
