import { buildHermesApiBase } from './common.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

async function fetchHermesJson(apiBase, pathname, {
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
    return {
      ok: true,
      apiBase: resolvedBase,
      health,
      models
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
  timeoutMs = 180000
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
      store: true
    }
  })
  if (!response.ok) {
    const detail = clean(response?.payload?.error?.message || response?.payload?.message || response?.payload)
    throw new Error(detail || `Hermes API server request failed with status ${response.status}`)
  }
  return response.payload
}
