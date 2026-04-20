import { requestJson } from '../transport/http_json.mjs'

const DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:46357'

async function gatewayGet(gatewayBase, path, options = {}) {
  return requestJson(`${gatewayBase}${path}`, {
    method: 'GET',
    preferNodeHttp: true,
    ...options
  })
}

async function gatewayPost(gatewayBase, path, payload, options = {}) {
  return requestJson(`${gatewayBase}${path}`, {
    method: 'POST',
    payload,
    preferNodeHttp: true,
    ...options
  })
}

export async function gatewayHealth(gatewayBase = DEFAULT_GATEWAY_BASE) {
  return gatewayGet(gatewayBase, '/health')
}

export async function gatewayConnect(gatewayBase = DEFAULT_GATEWAY_BASE, payload, options = {}) {
  return gatewayPost(gatewayBase, '/connect', payload, options)
}

export async function gatewayConnectJob(gatewayBase = DEFAULT_GATEWAY_BASE, payload, options = {}) {
  return gatewayPost(gatewayBase, '/connect-jobs', payload, options)
}

export async function gatewayInboxIndex(gatewayBase = DEFAULT_GATEWAY_BASE) {
  return gatewayGet(gatewayBase, '/inbox/index')
}

export async function gatewayConversationShow(gatewayBase = DEFAULT_GATEWAY_BASE, conversationId = '') {
  return gatewayGet(gatewayBase, `/conversations/show?conversationId=${encodeURIComponent(conversationId)}`)
}

export async function gatewayOwnerNotification(gatewayBase = DEFAULT_GATEWAY_BASE, payload, options = {}) {
  return gatewayPost(gatewayBase, '/owner/notifications', payload, options)
}
