#!/usr/bin/env node

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'
import { fileURLToPath } from 'node:url'

import { parseArgs, parseList, requireArg } from '../shared/primitives.mjs'
import { agentSquaredAgentIdForWire } from '../shared/agent_id.mjs'
import { getBindingDocument, getFriendDirectory } from '../transport/relay_http.mjs'
import { loadRuntimeKeyBundle } from '../runtime/keys.mjs'
import { DEFAULT_LISTEN_ADDRS, buildRelayListenAddrs, createNode, directListenAddrs, relayReservationAddrs } from '../transport/libp2p.mjs'
import { attachInboundRouter, currentTransport, openDirectPeerSession, publishGatewayPresence } from '../transport/peer_session.mjs'
import { assertGatewayStateFresh, currentRuntimeRevision, defaultGatewayStateFile, readGatewayState, writeGatewayState } from './state.mjs'
import { createGatewayRuntimeState } from './runtime_state.mjs'
import { chooseInboundSkill, createAgentRouter, DEFAULT_ROUTER_DEFAULT_SKILL, DEFAULT_ROUTER_SKILLS, resolveMailboxKey } from '../routing/agent_router.mjs'
import { createLocalRuntimeExecutor, createOwnerNotifier } from '../runtime/executor.mjs'
import { createInboxStore } from './inbox.mjs'
import { createLiveConversationStore } from '../conversation/store.mjs'
import { defaultInboxDir, defaultOpenClawStateDir, defaultPeerKeyFile as defaultPeerKeyFileFromLayout } from '../shared/paths.mjs'
import { SUPPORTED_HOST_RUNTIMES, detectHostRuntimeEnvironment } from '../../adapters/index.mjs'
import { resolveOpenClawAgentSelection } from '../../adapters/openclaw/detect.mjs'
import { buildStandardRuntimeOwnerLines, buildStandardRuntimeReport, currentRuntimeMetadata } from '../runtime/report.mjs'
import { buildSenderBaseReport, buildSenderFailureReport, inferOwnerFacingLanguage, normalizeConversationSummary, peerResponseText } from '../conversation/templates.mjs'
import { normalizeConversationControl, shouldContinueConversation } from '../conversation/policy.mjs'
import { scrubOutboundText } from '../runtime/safety.mjs'

const __filename = fileURLToPath(import.meta.url)

const DEFAULT_GATEWAY_HOST = '127.0.0.1'
const DEFAULT_GATEWAY_PORT = 0
const DEFAULT_PRESENCE_REFRESH_MS = 30 * 60 * 1000
const DEFAULT_HEALTH_CHECK_MS = 15 * 1000
const DEFAULT_RELAY_CONTROL_CHECK_MS = 5 * 60 * 1000
const DEFAULT_TRANSPORT_CHECK_TIMEOUT_MS = 1500
const DEFAULT_RECOVERY_IDLE_WAIT_MS = 3000
const DEFAULT_FAILURES_BEFORE_RECOVER = 2
const DEFAULT_ROUTER_WAIT_MS = 30000

function clean(value) {
  return `${value ?? ''}`.trim()
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nowISO() {
  return new Date().toISOString()
}

const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5
}

function normalizeLogLevel(value = '', fallback = 'warn') {
  const normalized = clean(value).toLowerCase()
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized) ? normalized : fallback
}

function currentGatewayLogLevel() {
  return normalizeLogLevel(process.env.A2_GATEWAY_LOG_LEVEL || process.env.A2_LOG_LEVEL || 'warn')
}

function defaultEventLevel(event = '') {
  const normalized = clean(event).toLowerCase()
  if (/(?:error|failure|failed)/.test(normalized)) {
    return 'error'
  }
  if (/(?:warn|invalidated|reject|recovery)/.test(normalized)) {
    return 'warn'
  }
  return 'debug'
}

function shouldLogGatewayEvent(level = 'debug') {
  return LOG_LEVELS[normalizeLogLevel(level, 'debug')] <= LOG_LEVELS[currentGatewayLogLevel()]
}

function logGatewayEvent(event, details = {}) {
  const detailObject = details && typeof details === 'object' ? details : {}
  const level = normalizeLogLevel(detailObject.level, defaultEventLevel(event))
  if (!shouldLogGatewayEvent(level)) {
    return
  }
  try {
    const { level: _level, ...rest } = detailObject
    const payload = {
      ts: nowISO(),
      level,
      event,
      ...rest
    }
    const line = JSON.stringify(payload)
    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  } catch {
    // Diagnostics must never affect the gateway hot path.
  }
}

function createTransportDiagnostics(base = {}) {
  return (event, details = {}) => {
    logGatewayEvent(`transport-${event}`, {
      level: 'debug',
      ...base,
      ...(details && typeof details === 'object' ? details : {})
    })
  }
}

async function summarizeConversationWithRuntime(localRuntimeExecutor, context = {}, fallback = '') {
  if (typeof localRuntimeExecutor?.summarizeConversation !== 'function') {
    return normalizeConversationSummary(fallback)
  }
  try {
    return normalizeConversationSummary(await localRuntimeExecutor.summarizeConversation(context), { fallback })
  } catch (error) {
    logGatewayEvent('conversation-summary-error', {
      level: 'warn',
      conversationKey: clean(context.conversationKey),
      message: clean(error?.message)
    })
    return normalizeConversationSummary(fallback)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pidExists(pid) {
  const numeric = Number.parseInt(`${pid ?? ''}`, 10)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return false
  }
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function acquireGatewayProcessLock(gatewayStateFile, {
  agentId = '',
  keyFile = ''
} = {}) {
  const lockDir = `${path.resolve(gatewayStateFile)}.lock`
  const ownerFile = path.join(lockDir, 'owner.json')
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`
  const owner = {
    token,
    pid: process.pid,
    agentId: clean(agentId),
    keyFile: path.resolve(keyFile),
    startedAt: nowISO()
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 })
      fs.writeFileSync(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 })
      let released = false
      return {
        lockDir,
        releaseSync() {
          if (released) {
            return
          }
          released = true
          const currentOwner = readJsonFile(ownerFile)
          if (clean(currentOwner?.token) !== token) {
            return
          }
          fs.rmSync(lockDir, { recursive: true, force: true })
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }
      const existing = readJsonFile(ownerFile)
      if (pidExists(existing?.pid)) {
        throw new Error(`An AgentSquared gateway process is already running for ${clean(existing?.agentId) || clean(agentId) || 'this agent'} (pid ${existing.pid}). Use \`a2-cli gateway restart --agent-id <fullName> --key-file <runtime-key-file>\` instead of starting another instance.`)
      }
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  }

  throw new Error(`Could not acquire AgentSquared gateway process lock: ${lockDir}`)
}

function excerpt(text, maxLength = 180) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function toOwnerFacingText(lines = []) {
  return lines.filter(Boolean).join('\n')
}

export function isClientDisconnected(req, res, disconnected = false) {
  return Boolean(
    disconnected
    || req?.aborted
    || (res?.destroyed && !res?.writableEnded)
  )
}

function extractPeerResponseMetadata(response = null) {
  const target = response?.result && typeof response.result === 'object'
    ? response.result
    : response
  return target?.metadata && typeof target.metadata === 'object'
    ? target.metadata
    : {}
}

function describeErrorForOutput(error = null, seen = new Set()) {
  if (error == null) {
    return ''
  }
  if (typeof error !== 'object') {
    return clean(error)
  }
  if (seen.has(error)) {
    return ''
  }
  seen.add(error)
  const parts = []
  const message = clean(error.message)
  if (message) {
    parts.push(message)
  }
  const code = clean(error.code)
  if (code && !parts.some((part) => part.includes(code))) {
    parts.push(code)
  }
  const cause = describeErrorForOutput(error.cause, seen)
  if (cause) {
    parts.push(`cause: ${cause}`)
  }
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const detail = describeErrorForOutput(nested, seen)
      if (detail) {
        parts.push(`nested: ${detail}`)
      }
    }
  }
  return [...new Set(parts)].join('; ')
}

function isLocalTransportReadinessError(error = null) {
  const lower = describeErrorForOutput(error).toLowerCase()
  return Boolean(
    lower.includes('local gateway is not ready')
    || lower.includes('waiting for relay reservation-backed transport')
    || lower.includes('gateway transport is unavailable')
    || lower.includes('no direct or relay-backed addresses were published')
  )
}

function gatewayServiceUnavailable(message = '', cause = null) {
  const error = new Error(clean(message) || 'local AgentSquared gateway transport is not ready')
  error.code = 503
  error.a2FailureKind = 'local-gateway-transport-not-ready'
  if (cause) {
    error.cause = cause
  }
  return error
}

function isSensitiveHealthField(name = '') {
  const normalized = clean(name).toLowerCase().replace(/[^a-z0-9]/g, '')
  return Boolean(
    normalized.endsWith('password')
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('credential')
    || normalized.endsWith('apikey')
    || normalized.endsWith('apiserverkey')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('refreshkey')
    || normalized.endsWith('sessionkey')
    || normalized === 'authorization'
  )
}

function redactHealthPayload(value, fieldName = '') {
  if (isSensitiveHealthField(fieldName)) {
    return clean(value) ? '[redacted]' : ''
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactHealthPayload(item))
  }
  if (!isPlainObject(value)) {
    return value
  }
  const next = {}
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === 'envVars' && isPlainObject(entryValue)) {
      next[key] = Object.fromEntries(
        Object.entries(entryValue).map(([envKey, envValue]) => [
          envKey,
          clean(envValue) ? '[redacted]' : ''
        ])
      )
      continue
    }
    next[key] = redactHealthPayload(entryValue, key)
  }
  return next
}

function classifyOutboundFailure(error = '', targetAgentId = '') {
  const failureKind = clean(typeof error === 'object' && error != null ? error.a2FailureKind : '')
  const message = describeErrorForOutput(error)
  const lower = message.toLowerCase()
  if (failureKind === 'local-gateway-transport-not-ready' || isLocalTransportReadinessError(error)) {
    return {
      code: 'local-gateway-transport-not-ready',
      deliveryStatus: 'failed',
      failureStage: 'pre-dispatch / local-transport-not-ready',
      confirmationLevel: 'request was not dispatched to the remote peer',
      reason: 'The local AgentSquared gateway had not published a direct or relay-backed transport address yet. Delivery was stopped before dispatch instead of guessing.',
      nextStep: 'Do not switch targets or retry automatically. Tell the owner the local AgentSquared gateway transport is still reconnecting; retry this same target after the gateway is healthy.'
    }
  }
  if (failureKind.startsWith('post-dispatch') || lower.includes('delivery status is unknown after the request was dispatched')) {
    return {
      code: failureKind || 'delivery-status-unknown',
      deliveryStatus: 'unknown',
      failureStage: 'post-dispatch / response-unconfirmed',
      confirmationLevel: 'remote may already have processed the message',
      reason: `${clean(targetAgentId) || 'The target agent'} may already have received and processed this AgentSquared message, but the response could not be confirmed locally.`,
      nextStep: 'Do not automatically retry this same message. Wait for a later AgentSquared reply or explicitly retry later.'
    }
  }
  if (lower.includes('turn response timed out after')) {
    return {
      code: 'turn-response-timeout',
      deliveryStatus: 'unknown',
      failureStage: 'post-receipt / final-response-timeout',
      confirmationLevel: 'remote acknowledged the turn but final response timed out',
      reason: `${clean(targetAgentId) || 'The target agent'} accepted this AgentSquared turn, but did not return a final response before the per-turn response timeout.`,
      nextStep: 'Do not automatically resend the same turn. Wait for a later reply or explicitly retry later.'
    }
  }
  if (failureKind === 'remote-runtime-error' || lower.includes('openclaw runtime failed') || lower.includes('local runtime rejected')) {
    return {
      code: 'target-runtime-unavailable',
      deliveryStatus: 'failed',
      failureStage: 'remote-runtime-error',
      confirmationLevel: 'target gateway was reached and returned a runtime error',
      reason: message || `${clean(targetAgentId) || 'The target agent'} could not run its local host runtime for this turn.`,
      nextStep: 'Do not automatically retry this same message. The target agent runtime needs to be fixed or restarted before retrying.'
    }
  }
  if (
    lower.includes('turn dial timed out after')
    || lower.includes('peer dial timed out after')
    || lower.includes('protocol stream open timed out after')
  ) {
    return {
      code: 'peer-dial-timeout',
      deliveryStatus: 'failed',
      failureStage: 'pre-dispatch / peer-dial-timeout',
      confirmationLevel: 'request was not dispatched to the remote peer',
      reason: `${clean(targetAgentId) || 'The target agent'} could not be reached before the AgentSquared peer connection timeout. The request was not confirmed as sent to the remote agent.`,
      nextStep: 'Do not switch to another target automatically. The owner can retry this same target later.'
    }
  }
  if (lower.includes('request receipt timed out after')) {
    return {
      code: 'turn-receipt-timeout',
      deliveryStatus: 'unconfirmed',
      failureStage: 'awaiting-request-receipt',
      confirmationLevel: 'receipt was never confirmed',
      reason: `${clean(targetAgentId) || 'The target agent'} did not confirm receipt of this AgentSquared turn within the receipt timeout, so delivery for this turn could not be confirmed.`,
      nextStep: 'Do not continue the conversation automatically. The owner can retry later.'
    }
  }
  return {
    code: 'delivery-failed',
    deliveryStatus: 'failed',
    failureStage: 'unknown',
    confirmationLevel: 'delivery could not be completed or confirmed',
    reason: message || 'The AgentSquared message could not be delivered.',
    nextStep: 'Do not switch to another target automatically. The owner can retry this same target later.'
  }
}

async function executeLocalConversationTurn({
  localRuntimeExecutor,
  localAgentId,
  targetAgentId,
  peerSessionId,
  conversationKey,
  skillHint,
  conversationPolicy,
  inboundText,
  originalOwnerText = '',
  turnIndex,
  remoteControl = null
}) {
  const normalizedRemoteControl = normalizeConversationControl(remoteControl ?? {}, {
    defaultTurnIndex: Math.max(1, Number.parseInt(`${turnIndex ?? 1}`, 10) - 1),
    defaultDecision: 'done',
    defaultStopReason: ''
  })
  const item = {
    inboundId: `outbound-local-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    remoteAgentId: targetAgentId,
    peerSessionId,
    suggestedSkill: skillHint,
    defaultSkill: clean(skillHint),
    request: {
      id: `outbound-local-turn-${turnIndex}`,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          role: 'agent',
          parts: [{ kind: 'text', text: clean(inboundText) }]
        },
        metadata: {
          ...(conversationPolicy ? { conversationPolicy } : {}),
          from: targetAgentId,
          to: localAgentId,
          originalOwnerText: clean(originalOwnerText) || clean(inboundText),
          conversationKey: clean(conversationKey),
          turnIndex,
          decision: normalizedRemoteControl.decision,
          stopReason: normalizedRemoteControl.stopReason,
          final: normalizedRemoteControl.final,
          finalize: normalizedRemoteControl.final
        }
      }
    }
  }
  const selectedSkill = chooseInboundSkill(item, {
    defaultSkill: clean(skillHint)
  })
  return localRuntimeExecutor({
    item,
    selectedSkill,
    mailboxKey: resolveMailboxKey(item)
  })
}

export async function notifyLateConnectResult({
  ownerNotifier,
  localRuntimeExecutor,
  agentId,
  body,
  result
}) {
  if (typeof ownerNotifier !== 'function' || !body || !result) {
    return
  }
  const targetAgentId = body.targetAgentId
    ? agentSquaredAgentIdForWire(body.targetAgentId, { label: 'targetAgentId' })
    : ''
  const selectedSkill = clean(body.skillHint || body.skillName)
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  const outboundConversation = normalizeConversationControl(metadata, {
    defaultTurnIndex: Number.parseInt(`${metadata.turnIndex ?? 1}`, 10) || 1,
    defaultDecision: 'done',
    defaultStopReason: ''
  })
  if (!outboundConversation.final) {
    return
  }
  const sentAt = clean(metadata.sentAt) || nowISO()
  const conversationKey = clean(metadata.conversationKey)
  const originalText = clean(metadata.originalOwnerText)
    || clean(body.message?.parts?.[0]?.text || body.message?.text || '')
  const replyText = peerResponseText(result.response)
  const responseMetadata = result.response?.metadata && typeof result.response.metadata === 'object'
    ? result.response.metadata
    : {}
  const conversation = normalizeConversationControl(responseMetadata, {
    defaultTurnIndex: Number.parseInt(`${metadata.turnIndex ?? 1}`, 10) || 1,
    defaultDecision: 'done',
    defaultStopReason: ''
  })
  const actionItems = []
  const ownerLanguage = inferOwnerFacingLanguage(originalText, replyText)
  const ownerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const conversationTurns = [{
    turnIndex: Math.max(1, conversation.turnIndex || 1),
    outboundText: scrubOutboundText(originalText),
    replyText: scrubOutboundText(replyText),
    remoteDecision: conversation.decision,
    remoteStopReason: conversation.stopReason
  }]
  const overallSummary = await summarizeConversationWithRuntime(localRuntimeExecutor, {
    localAgentId: agentId,
    remoteAgentId: targetAgentId,
    selectedSkill,
    direction: 'outbound',
    conversationKey,
    turns: conversationTurns,
    language: ownerLanguage
  }, excerpt(replyText, 240) || 'The remote agent replied through AgentSquared.')
  const senderReport = buildSenderBaseReport({
    localAgentId: agentId,
    targetAgentId,
    selectedSkill,
    receiverSkill: clean(result?.response?.metadata?.selectedSkill || selectedSkill),
    sentAt,
    originalText,
    sentText: originalText,
    replyText,
    replyAt: nowISO(),
    conversationKey,
    peerSessionId: clean(result.peerSessionId),
    turnCount: Math.max(1, conversation.turnIndex || 1),
    stopReason: clean(conversation.stopReason),
    overallSummary,
    actionItems,
    conversationTurns,
    turnOutline: [
      {
        turnIndex: Math.max(1, conversation.turnIndex || 1),
        summary: [
          originalText ? `I sent "${excerpt(originalText, 120)}"` : 'I sent a message',
          replyText ? `the peer replied "${excerpt(replyText, 120)}"` : 'the peer replied'
        ].join(' ')
      }
    ],
    detailsHint: 'AgentSquared delivered this reply through the official owner notification path.',
    language: ownerLanguage,
    timeZone: ownerTimeZone,
    localTime: true
  })
  await ownerNotifier({
    selectedSkill,
    mailboxKey: conversationKey ? `late-connect:${conversationKey}` : `late-connect:${targetAgentId || 'unknown'}`,
    item: {
      inboundId: `late-connect-${conversationKey || clean(result.peerSessionId) || Date.now()}`,
      remoteAgentId: targetAgentId,
      peerSessionId: clean(result.peerSessionId),
      request: {
        params: {
          metadata
        }
      }
    },
    ownerReport: {
      ...senderReport,
      selectedSkill,
      conversationKey,
      peerSessionId: clean(result.peerSessionId),
      turnIndex: Math.max(1, conversation.turnIndex || 1),
      decision: clean(conversation.decision) || 'done',
      stopReason: clean(conversation.stopReason),
      final: true,
      finalize: true,
      lateConnectResult: true
    },
    peerResponse: result.response ?? null
  })
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function healthResponse(res, status, payload) {
  jsonResponse(res, status, redactHealthPayload(payload))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

function defaultPeerKeyFile(keyFile, agentId) {
  return defaultPeerKeyFileFromLayout(keyFile, agentId)
}

export async function runGateway(argv) {
  const args = parseArgs(argv)
  const apiBase = (args['api-base'] ?? 'https://api.agentsquared.net').trim()
  const agentId = agentSquaredAgentIdForWire(requireArg(args['agent-id'], '--agent-id is required'), { label: '--agent-id' })
  const keyFile = requireArg(args['key-file'], '--key-file is required')
  const gatewayHost = (args['gateway-host'] ?? DEFAULT_GATEWAY_HOST).trim()
  const gatewayPort = Number.parseInt(args['gateway-port'] ?? `${DEFAULT_GATEWAY_PORT}`, 10)
  const presenceRefreshMs = Math.max(0, Number.parseInt(args['presence-refresh-ms'] ?? `${DEFAULT_PRESENCE_REFRESH_MS}`, 10) || DEFAULT_PRESENCE_REFRESH_MS)
  const healthCheckMs = Math.max(1000, Number.parseInt(args['health-check-ms'] ?? `${DEFAULT_HEALTH_CHECK_MS}`, 10) || DEFAULT_HEALTH_CHECK_MS)
  const relayControlCheckMs = Math.max(1000, Number.parseInt(args['relay-control-check-ms'] ?? `${DEFAULT_RELAY_CONTROL_CHECK_MS}`, 10) || DEFAULT_RELAY_CONTROL_CHECK_MS)
  const transportCheckTimeoutMs = Math.max(250, Number.parseInt(args['transport-check-timeout-ms'] ?? `${DEFAULT_TRANSPORT_CHECK_TIMEOUT_MS}`, 10) || DEFAULT_TRANSPORT_CHECK_TIMEOUT_MS)
  const recoveryIdleWaitMs = Math.max(0, Number.parseInt(args['recovery-idle-wait-ms'] ?? `${DEFAULT_RECOVERY_IDLE_WAIT_MS}`, 10) || DEFAULT_RECOVERY_IDLE_WAIT_MS)
  const failuresBeforeRecover = Math.max(1, Number.parseInt(args['failures-before-recover'] ?? `${DEFAULT_FAILURES_BEFORE_RECOVER}`, 10) || DEFAULT_FAILURES_BEFORE_RECOVER)
  const routerMode = `${args['router-mode'] ?? 'integrated'}`.trim().toLowerCase() === 'external' ? 'external' : 'integrated'
  const routerWaitMs = Math.max(0, Number.parseInt(args['wait-ms'] ?? `${DEFAULT_ROUTER_WAIT_MS}`, 10) || DEFAULT_ROUTER_WAIT_MS)
  const maxActiveMailboxes = Math.max(1, Number.parseInt(args['max-active-mailboxes'] ?? '8', 10) || 8)
  const routerSkills = parseList(args['router-skills'] ?? args['allowed-skills'], DEFAULT_ROUTER_SKILLS)
  const defaultSkill = (args['default-skill'] ?? args['fallback-skill'] ?? DEFAULT_ROUTER_DEFAULT_SKILL).trim() || DEFAULT_ROUTER_DEFAULT_SKILL
  const hostRuntime = `${args['host-runtime'] ?? 'auto'}`.trim().toLowerCase() || 'auto'
  const openclawAgent = `${args['openclaw-agent'] ?? process.env.OPENCLAW_AGENT ?? ''}`.trim()
  const openclawCommand = `${args['openclaw-command'] ?? process.env.OPENCLAW_COMMAND ?? 'openclaw'}`.trim() || 'openclaw'
  const openclawCwd = `${args['openclaw-cwd'] ?? process.env.OPENCLAW_CWD ?? ''}`.trim()
  const openclawConfigPath = `${args['openclaw-config-path'] ?? process.env.OPENCLAW_CONFIG_PATH ?? ''}`.trim()
  const openclawSessionPrefix = `${args['openclaw-session-prefix'] ?? args['openclaw-peer-target-prefix'] ?? process.env.OPENCLAW_SESSION_PREFIX ?? process.env.OPENCLAW_PEER_TARGET_PREFIX ?? 'agentsquared:'}`.trim() || 'agentsquared:'
  const openclawTimeoutMs = Math.max(1000, Number.parseInt(args['openclaw-timeout-ms'] ?? `${process.env.OPENCLAW_TIMEOUT_MS ?? '180000'}`, 10) || 180000)
  const openclawGatewayUrl = `${args['openclaw-gateway-url'] ?? process.env.OPENCLAW_GATEWAY_URL ?? ''}`.trim()
  const openclawGatewayToken = `${args['openclaw-gateway-token'] ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? ''}`.trim()
  const openclawGatewayPassword = `${args['openclaw-gateway-password'] ?? process.env.OPENCLAW_GATEWAY_PASSWORD ?? ''}`.trim()
  const hermesCommand = `${args['hermes-command'] ?? process.env.HERMES_COMMAND ?? 'hermes'}`.trim() || 'hermes'
  const hermesHome = `${args['hermes-home'] ?? process.env.HERMES_HOME ?? ''}`.trim()
  const hermesProfile = `${args['hermes-profile'] ?? process.env.HERMES_PROFILE ?? ''}`.trim()
  const hermesApiBase = `${args['hermes-api-base'] ?? process.env.HERMES_API_BASE ?? ''}`.trim()
  const hermesTimeoutMs = Math.max(1000, Number.parseInt(args['hermes-timeout-ms'] ?? `${process.env.HERMES_TIMEOUT_MS ?? '180000'}`, 10) || 180000)
  const peerKeyFile = (args['peer-key-file'] ?? defaultPeerKeyFile(keyFile, agentId)).trim()
  const gatewayStateFile = (args['gateway-state-file'] ?? defaultGatewayStateFile(keyFile, agentId)).trim()
  const inboxDir = (args['inbox-dir'] ?? defaultInboxDir(keyFile, agentId)).trim()
  const gatewayProcessLock = acquireGatewayProcessLock(gatewayStateFile, {
    agentId,
    keyFile
  })
  process.once('exit', () => gatewayProcessLock.releaseSync())
  const listenAddrs = parseList(args['listen-addrs'], DEFAULT_LISTEN_ADDRS)
  const bundle = loadRuntimeKeyBundle(keyFile)
  const runtimeState = createGatewayRuntimeState()
  const conversationStore = createLiveConversationStore()
  const inboxStore = createInboxStore({ inboxDir })
  const runtimeRevision = currentRuntimeRevision()
  const currentRuntime = currentRuntimeMetadata()
  const previousGatewayState = readGatewayState(gatewayStateFile)
  const detectedHostRuntime = await detectHostRuntimeEnvironment({
    preferred: hostRuntime,
    openclaw: {
      command: openclawCommand,
      cwd: openclawCwd,
      openclawAgent,
      configPath: openclawConfigPath,
      gatewayUrl: openclawGatewayUrl,
      gatewayToken: openclawGatewayToken,
      gatewayPassword: openclawGatewayPassword
    },
    hermes: {
      command: hermesCommand,
      hermesHome,
      hermesProfile,
      apiBase: hermesApiBase
    }
  })
  const resolvedHostRuntime = detectedHostRuntime.resolved || 'none'
  if (!detectedHostRuntime.detected || !SUPPORTED_HOST_RUNTIMES.includes(resolvedHostRuntime)) {
    const detected = detectedHostRuntime.resolved || detectedHostRuntime.id || 'none'
    const reason = `${detectedHostRuntime.reason ?? ''}`.trim()
    throw new Error(
      `AgentSquared gateway startup requires a supported host runtime (${SUPPORTED_HOST_RUNTIMES.join(' or ')}). Detected host runtime: ${detected}.${reason ? ` Detection reason: ${reason}.` : ''} This gateway will not start in a runtime-without-adapter mode. Finish configuring a supported host runtime and then retry.`
    )
  }
  const detectedOpenClawAgent = clean(resolveOpenClawAgentSelection(detectedHostRuntime).defaultAgentId)
  const resolvedOpenClawAgent = openclawAgent || detectedOpenClawAgent
  if (resolvedHostRuntime === 'openclaw' && !resolvedOpenClawAgent) {
    throw new Error('OpenClaw host runtime was detected, but no default OpenClaw agent id could be resolved. AgentSquared gateway startup stops here instead of guessing with the AgentSquared id.')
  }
  const runtimeMode = resolvedHostRuntime !== 'none' ? 'host' : 'none'
  const ownerNotifyMode = resolvedHostRuntime !== 'none' ? 'host' : 'inbox'
  const localRuntimeExecutor = createLocalRuntimeExecutor({
    agentId,
    mode: runtimeMode,
    hostRuntime: resolvedHostRuntime,
    conversationStore,
    openclawStateDir: defaultOpenClawStateDir(keyFile, agentId),
    openclawCommand,
    openclawCwd,
    openclawConfigPath,
    openclawAgent: resolvedOpenClawAgent,
    openclawSessionPrefix,
    openclawTimeoutMs,
    openclawGatewayUrl,
    openclawGatewayToken,
    openclawGatewayPassword,
    hermesCommand,
    hermesHome: clean(detectedHostRuntime.hermesHome) || hermesHome,
    hermesProfile: clean(detectedHostRuntime.hermesProfile) || hermesProfile,
    hermesApiBase: clean(detectedHostRuntime.apiBase) || hermesApiBase,
    hermesTimeoutMs
  })
  const ownerNotifier = createOwnerNotifier({
    agentId,
    mode: ownerNotifyMode,
    hostRuntime: resolvedHostRuntime,
    inbox: inboxStore,
    openclawStateDir: defaultOpenClawStateDir(keyFile, agentId),
    openclawCommand,
    openclawCwd,
    openclawConfigPath,
    openclawAgent: resolvedOpenClawAgent,
    openclawSessionPrefix,
    openclawTimeoutMs,
    openclawGatewayUrl,
    openclawGatewayToken,
    openclawGatewayPassword,
    hermesCommand,
    hermesHome: clean(detectedHostRuntime.hermesHome) || hermesHome,
    hermesProfile: clean(detectedHostRuntime.hermesProfile) || hermesProfile,
    hermesApiBase: clean(detectedHostRuntime.apiBase) || hermesApiBase,
    hermesTimeoutMs
  })
  const startupChecks = {
    relay: { ok: false, error: '' },
    hostRuntime: { ok: false, error: '' }
  }

  async function refreshHostRuntimeCheck(source = 'host runtime health') {
    if (!localRuntimeExecutor?.preflight) {
      startupChecks.hostRuntime = {
        ok: resolvedHostRuntime === 'none',
        error: '',
        checkedAt: nowISO(),
        source
      }
      return startupChecks.hostRuntime
    }
    try {
      const preflight = await localRuntimeExecutor.preflight()
      startupChecks.hostRuntime = {
        ok: Boolean(preflight?.ok ?? resolvedHostRuntime === 'none'),
        error: preflight?.ok === false ? clean(preflight?.error || preflight?.reason || 'host runtime preflight failed') : '',
        checkedAt: nowISO(),
        source,
        ...(preflight?.gatewayUrl ? { gatewayUrl: clean(preflight.gatewayUrl) } : {}),
        ...(preflight?.authMode ? { authMode: clean(preflight.authMode) } : {})
      }
    } catch (error) {
      startupChecks.hostRuntime = {
        ok: false,
        error: clean(error?.message) || 'host runtime preflight failed',
        checkedAt: nowISO(),
        source
      }
    }
    if (resolvedHostRuntime !== 'none' && startupChecks.hostRuntime.ok === false) {
      logGatewayEvent('host-runtime-health-failure', {
        source,
        hostRuntime: resolvedHostRuntime,
        error: startupChecks.hostRuntime.error
      })
    }
    return startupChecks.hostRuntime
  }

  const binding = await getBindingDocument(apiBase)
  startupChecks.relay = { ok: true, error: '' }
  const relayListenAddrs = buildRelayListenAddrs(binding.relayMultiaddrs ?? [])
  const requireRelayReservation = relayListenAddrs.length > 0

  try {
    await refreshHostRuntimeCheck('startup')
    if (resolvedHostRuntime !== 'none' && startupChecks.hostRuntime.ok === false) {
      throw new Error(`host runtime preflight failed: ${startupChecks.hostRuntime.error}`)
    }
  } catch (error) {
    startupChecks.hostRuntime = {
      ok: false,
      error: clean(error?.message) || 'host runtime preflight failed'
    }
    throw error
  }

  let gatewayBase = `http://${gatewayHost}:${gatewayPort}`
  let actualGatewayPort = gatewayPort
  let currentNode = null
  let online = null
  let relayControl = {
    ok: false,
    checkedAt: '',
    detail: 'Relay control-plane handshake has not completed yet.',
    path: '/api/relay/friends'
  }
  let recoveryPromise = null
  let stopping = false
  let activeOperations = 0
  let deferredRecoveryReason = ''
  let deferredRecoveryTimer = null
  const idleWaiters = []
  const integratedRouter = routerMode === 'integrated'
    ? createAgentRouter({
        maxActiveMailboxes,
        routerSkills,
        defaultSkill,
        executeInbound: localRuntimeExecutor,
        notifyOwner: ownerNotifier,
        localAgentId: agentId,
        onStreamEvent(item, event) {
          runtimeState.emitInboundStreamEvent({
            inboundId: item.inboundId,
            event
          })
        },
        onRespond(item, result) {
          runtimeState.respondInbound({
            inboundId: item.inboundId,
            result
          })
        },
        onReject(item, payload) {
          logGatewayEvent('inbound-runtime-reject', {
            inboundId: clean(item?.inboundId),
            requestId: clean(item?.request?.id),
            conversationKey: clean(item?.request?.params?.metadata?.conversationKey),
            peerSessionId: clean(item?.peerSessionId),
            remoteAgentId: clean(item?.remoteAgentId),
            suggestedSkill: clean(item?.suggestedSkill),
            code: Number.parseInt(`${payload?.code ?? 500}`, 10) || 500,
            message: clean(payload?.message),
            stage: clean(payload?.stage),
            runtimeAdapter: clean(payload?.runtimeAdapter),
            failureKind: clean(payload?.failureKind),
            detail: clean(payload?.detail),
            stack: clean(payload?.stack)
          })
          runtimeState.rejectInbound({
            inboundId: item.inboundId,
            code: payload.code,
            message: payload.message,
            stage: payload.stage,
            runtimeAdapter: payload.runtimeAdapter,
            failureKind: payload.failureKind,
            detail: payload.detail
          })
        }
      })
    : null
  const lifecycle = {
    generation: 0,
    recovering: false,
    lastRecoveryAt: '',
    lastRecoveryReason: '',
    lastHealthyAt: '',
    lastError: '',
    consecutiveFailures: 0,
    routerMode
  }
  const outboundJobs = new Map()

  function flushIdleWaiters() {
    if (activeOperations !== 0) {
      return
    }
    while (idleWaiters.length > 0) {
      const resolve = idleWaiters.shift()
      resolve?.(true)
    }
    scheduleDeferredRecovery()
  }

  function beginOperation() {
    activeOperations += 1
    let done = false
    return () => {
      if (done) {
        return
      }
      done = true
      activeOperations = Math.max(0, activeOperations - 1)
      flushIdleWaiters()
    }
  }

  async function waitForIdle(timeoutMs) {
    if (activeOperations === 0) {
      return true
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = idleWaiters.indexOf(onIdle)
        if (index >= 0) {
          idleWaiters.splice(index, 1)
        }
        resolve(false)
      }, timeoutMs)
      const onIdle = () => {
        clearTimeout(timer)
        resolve(true)
      }
      idleWaiters.push(onIdle)
    })
  }

  function markHealthy() {
    lifecycle.lastHealthyAt = nowISO()
    lifecycle.lastError = ''
    lifecycle.consecutiveFailures = 0
  }

  function noteFailure(error) {
    lifecycle.lastError = error?.message ?? `${error ?? 'gateway failure'}`
    lifecycle.consecutiveFailures += 1
  }

  function deferRecovery(reason) {
    deferredRecoveryReason = `${reason ?? ''}`.trim() || deferredRecoveryReason || 'deferred gateway recovery'
    logGatewayEvent('gateway-recovery-deferred', {
      reason: deferredRecoveryReason,
      activeOperations
    })
    scheduleDeferredRecovery()
  }

  function scheduleDeferredRecovery() {
    if (!deferredRecoveryReason || activeOperations !== 0 || stopping || recoveryPromise || deferredRecoveryTimer) {
      return
    }
    deferredRecoveryTimer = setTimeout(() => {
      deferredRecoveryTimer = null
      if (!deferredRecoveryReason || activeOperations !== 0 || stopping || recoveryPromise) {
        scheduleDeferredRecovery()
        return
      }
      const reason = deferredRecoveryReason
      deferredRecoveryReason = ''
      recoverGateway(reason).catch((error) => {
        noteFailure(error)
        console.error(`deferred gateway recovery failed: ${error.message}`)
      })
    }, 0)
    deferredRecoveryTimer.unref?.()
  }

  function buildLifecycleSnapshot() {
    return {
      ...lifecycle,
      activeOperations,
      deferredRecoveryReason,
      hasNode: Boolean(currentNode),
      online
    }
  }

  function updateRelayControl(ok, detail) {
    relayControl = {
      ok: Boolean(ok),
      checkedAt: nowISO(),
      detail: `${detail ?? ''}`.trim() || (ok ? 'Relay control-plane handshake succeeded.' : 'Relay control-plane handshake failed.'),
      path: '/api/relay/friends'
    }
  }

  function relayControlIsFresh() {
    if (!relayControl.checkedAt) {
      return false
    }
    const parsed = Date.parse(relayControl.checkedAt)
    if (!Number.isFinite(parsed)) {
      return false
    }
    return (Date.now() - parsed) <= relayControlCheckMs
  }

  function buildRouterSnapshot() {
    return integratedRouter
      ? integratedRouter.snapshot()
        : {
          mode: 'external',
          routerSkills,
          defaultSkill,
          runtimeMode: localRuntimeExecutor.mode,
          ownerReportMode: ownerNotifier.mode,
          hostRuntime: resolvedHostRuntime
        }
  }

  function buildOutboundJobsSnapshot() {
    return {
      activeJobs: Array.from(outboundJobs.values()).filter((job) => ['queued', 'running'].includes(job.status)).length,
      recentJobs: Array.from(outboundJobs.values()).slice(-12).map((job) => ({
        jobId: job.jobId,
        status: job.status,
        targetAgentId: job.targetAgentId,
        skillHint: job.skillHint,
        conversationKey: job.conversationKey,
        turnCount: job.turnCount,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error
      }))
    }
  }

  function activeOutboundJob() {
    return Array.from(outboundJobs.values()).find((job) => ['queued', 'running'].includes(job.status)) ?? null
  }

  function writeStateForNode(node) {
    if (!gatewayBase || !node?.peerId?.toString?.()) {
      return
    }
    writeGatewayState(gatewayStateFile, {
      agentId,
      gatewayBase,
      gatewayPid: process.pid,
      gatewayHost,
      gatewayPort: actualGatewayPort,
      keyFile: path.resolve(keyFile),
      peerKeyFile: path.resolve(peerKeyFile),
      peerId: node.peerId.toString(),
      runtimePackageVersion: currentRuntime.packageVersion,
      runtimeGitCommit: currentRuntime.gitCommit,
      runtimeRepoUrl: currentRuntime.repoUrl,
      skillsPackageVersion: currentRuntime.packageVersion,
      skillsGitCommit: currentRuntime.gitCommit,
      skillsRepoUrl: currentRuntime.repoUrl,
      runtimeRevision,
      runtimeStartedAt: nowISO(),
      updatedAt: nowISO()
    })
  }

  async function stopNode(node) {
    if (!node) {
      return
    }
    try {
      await node.stop()
    } catch (error) {
      console.error(`gateway node stop failed: ${error.message}`)
    }
  }

  async function createAttachedNode() {
    const node = await createNode({
      listenAddrs,
      relayListenAddrs,
      peerKeyFile
    })
    await attachInboundRouter({
      apiBase,
      agentId,
      bundle,
      node,
      binding,
      sessionStore: runtimeState
    })
    return node
  }

  async function verifyTransport(node, timeoutMs = transportCheckTimeoutMs) {
    const transport = await currentTransport(node, binding, {
      requireRelayReservation,
      timeoutMs
    })
    markHealthy()
    return transport
  }

  async function verifyRelayControlPlane(node, { force = false } = {}) {
    if (!force && relayControl.ok && relayControlIsFresh()) {
      return relayControl
    }
    const transport = await verifyTransport(node)
    try {
      await getFriendDirectory(apiBase, agentId, bundle, transport)
      updateRelayControl(true, 'Signed relay MCP handshake succeeded and relay accepted the current transport.')
      markHealthy()
      return relayControl
    } catch (error) {
      updateRelayControl(false, error?.message ?? 'Relay control-plane handshake failed.')
      throw error
    }
  }

  async function publishPresence(node, activitySummary = 'Gateway listener ready for trusted direct sessions.') {
    const value = await publishGatewayPresence(
      apiBase,
      agentId,
      bundle,
      node,
      binding,
      activitySummary,
      { requireRelayReservation }
    )
    online = value
    updateRelayControl(true, 'Signed relay presence publish succeeded.')
    markHealthy()
    return value
  }

  async function recoverGateway(reason) {
    if (stopping) {
      throw new Error('gateway is stopping')
    }
    if (recoveryPromise) {
      return recoveryPromise
    }
    if (activeOperations !== 0 && currentNode) {
      deferRecovery(reason)
      return currentNode
    }

    recoveryPromise = (async () => {
      lifecycle.recovering = true
      lifecycle.lastRecoveryAt = nowISO()
      lifecycle.lastRecoveryReason = `${reason}`.trim() || 'gateway recovery'

      const previousNode = currentNode
      const previousOnline = online
      currentNode = null
      online = null

      const idle = await waitForIdle(recoveryIdleWaitMs)
      if (!idle && previousNode) {
        currentNode = previousNode
        online = previousOnline
        deferRecovery(reason)
        return previousNode
      }
      runtimeState.reset({
        reason: `gateway reconnect in progress: ${lifecycle.lastRecoveryReason}`,
        preserveTrustedSessions: true
      })
      await stopNode(previousNode)

      let nextNode = null
      try {
        nextNode = await createAttachedNode()
        await publishPresence(nextNode)
        await verifyRelayControlPlane(nextNode, { force: true })
        currentNode = nextNode
        lifecycle.generation += 1
        lifecycle.recovering = false
        writeStateForNode(nextNode)
        const startupHealth = {
          agentId,
          gatewayBase,
          runtimeRevision,
          hostRuntime: detectedHostRuntime,
          startupChecks,
          relayControl,
          peerId: nextNode.peerId.toString(),
          listenAddrs: directListenAddrs(nextNode),
          relayAddrs: relayReservationAddrs(nextNode),
          streamProtocol: binding.streamProtocol,
          supportedBindings: binding.supportedBindings ?? [],
          routerMode,
          agentRouter: buildRouterSnapshot(),
          lifecycle: buildLifecycleSnapshot(),
          runtimeState: runtimeState.snapshot(),
          conversations: conversationStore.snapshot(),
          outboundJobs: buildOutboundJobsSnapshot(),
          inbox: inboxStore.snapshot()
        }
        const standardReport = buildStandardRuntimeReport({
          apiBase,
          agentId,
          keyFile,
          detectedHostRuntime,
          gateway: {
            started: true,
            gatewayBase
          },
          gatewayHealth: startupHealth,
          previousState: previousGatewayState
        })
        const ownerFacingLines = buildStandardRuntimeOwnerLines(standardReport)
        logGatewayEvent(lifecycle.generation === 1 ? 'gateway-started' : 'gateway-recovered', {
          level: 'info',
          agentId,
          gatewayBase,
          gatewayStateFile,
          peerId: nextNode.peerId.toString(),
          listenAddrs: directListenAddrs(nextNode),
          relayAddrs: relayReservationAddrs(nextNode),
          streamProtocol: binding.streamProtocol,
          peerKeyFile,
          routerMode,
          agentRouter: buildRouterSnapshot(),
          lifecycle: buildLifecycleSnapshot(),
          runtimeState: runtimeState.snapshot(),
          conversations: conversationStore.snapshot(),
          outboundJobs: buildOutboundJobsSnapshot(),
          standardReport,
          ownerFacingLines,
          ownerFacingText: toOwnerFacingText(ownerFacingLines)
        })
        return nextNode
      } catch (error) {
        lifecycle.lastError = error.message
        if (nextNode) {
          await stopNode(nextNode)
        }
        throw error
      } finally {
        lifecycle.recovering = false
        recoveryPromise = null
      }
    })()

    return recoveryPromise
  }

  async function ensureGatewayReady(reason) {
    if (recoveryPromise) {
      await recoveryPromise
    }
    if (!currentNode) {
      await recoverGateway(reason)
    }
    if (!currentNode) {
      throw gatewayServiceUnavailable('gateway transport is unavailable')
    }
    try {
      await verifyTransport(currentNode)
      await verifyRelayControlPlane(currentNode)
      markHealthy()
      return currentNode
    } catch (error) {
      noteFailure(error)
      if (activeOperations !== 0 && currentNode) {
        deferRecovery(`${reason}: ${error.message}`)
        throw gatewayServiceUnavailable(`gateway transport is not ready while another AgentSquared operation is active: ${error.message}`, error)
      }
      try {
        await recoverGateway(`${reason}: ${error.message}`)
      } catch (recoveryError) {
        throw gatewayServiceUnavailable(`gateway transport recovery failed: ${recoveryError.message}`, recoveryError)
      }
      if (!currentNode) {
        throw gatewayServiceUnavailable(`gateway transport is unavailable: ${error.message}`, error)
      }
      try {
        await verifyTransport(currentNode)
        await verifyRelayControlPlane(currentNode, { force: true })
      } catch (recheckError) {
        throw gatewayServiceUnavailable(`gateway transport is still not ready after recovery: ${recheckError.message}`, recheckError)
      }
      return currentNode
    }
  }

  async function notifyOutboundJobFailure(job, error) {
    const failure = classifyOutboundFailure(error, job.targetAgentId)
    const senderReport = buildSenderFailureReport({
      localAgentId: agentId,
      targetAgentId: job.targetAgentId,
      selectedSkill: job.skillHint,
      sentAt: job.sentAt,
      originalText: job.originalText,
      conversationKey: job.conversationKey,
      deliveryStatus: failure.deliveryStatus,
      failureStage: failure.failureStage,
      confirmationLevel: failure.confirmationLevel,
      failureCode: failure.code,
      failureReason: failure.reason,
      failureDetail: describeErrorForOutput(error),
      nextStep: failure.nextStep,
      language: job.ownerLanguage,
      timeZone: job.ownerTimeZone,
      localTime: true
    })
    await ownerNotifier({
      selectedSkill: job.skillHint,
      mailboxKey: `outbound:${job.conversationKey}`,
      item: {
        inboundId: `sender-failure-${job.conversationKey}`,
        remoteAgentId: job.targetAgentId,
        peerSessionId: clean(job.peerSessionId),
        dedupeKey: job.dedupeKey,
        request: {
          params: {
            metadata: {
              conversationKey: job.conversationKey
            }
          }
        }
      },
      ownerReport: {
        ...senderReport,
        deliveryId: `sender-failure-${job.conversationKey}`,
        dedupeKey: job.dedupeKey,
        conversationKey: job.conversationKey,
        ownerRoute: job.ownerRoute,
        ownerRouteSource: job.ownerRouteSource,
        ownerRouteSessionId: job.ownerRouteSessionId,
        final: true,
        finalize: true
      },
      peerResponse: null
    })
  }

  async function notifyOutboundJobSuccess(job, result, turnLog, {
    localStopReason = '',
    continuationError = ''
  } = {}) {
    const replyText = peerResponseText(result?.response)
    const finalRemoteControl = normalizeConversationControl(extractPeerResponseMetadata(result?.response), {
      defaultTurnIndex: turnLog.length || 1,
      defaultDecision: 'done',
      defaultStopReason: localStopReason || ''
    })
    const conversationTurns = turnLog.map((turn) => ({
      turnIndex: turn.turnIndex,
      outboundText: scrubOutboundText(turn.outboundText),
      replyText: scrubOutboundText(turn.replyText),
      sentAt: turn.sentAt,
      repliedAt: turn.repliedAt,
      localDecision: turn.localDecision,
      localStopReason: turn.localStopReason,
      remoteDecision: turn.remoteDecision,
      remoteStopReason: turn.remoteStopReason
    }))
    const turnOutline = turnLog.map((turn) => {
      const outbound = excerpt(turn.outboundText, 120)
      const reply = excerpt(turn.replyText, 120)
      const stop = clean(turn.remoteStopReason || turn.localStopReason)
      return {
        turnIndex: turn.turnIndex,
        summary: [
          outbound ? `I shared or asked "${outbound}"` : 'I sent a message',
          reply ? `the peer replied "${reply}"` : 'the peer reply had no displayable text',
          stop ? `(stop: ${stop})` : ''
        ].filter(Boolean).join(' ')
      }
    })
    const summaryFallback = excerpt(replyText || turnLog.at(-1)?.replyText || '', 240) || 'This conversation completed.'
    const overallSummary = await summarizeConversationWithRuntime(localRuntimeExecutor, {
      localAgentId: agentId,
      remoteAgentId: job.targetAgentId,
      selectedSkill: job.skillHint,
      direction: 'outbound',
      conversationKey: job.conversationKey,
      turns: conversationTurns,
      language: job.ownerLanguage
    }, summaryFallback)
    const senderReport = buildSenderBaseReport({
      localAgentId: agentId,
      targetAgentId: job.targetAgentId,
      selectedSkill: job.skillHint,
      receiverSkill: clean(result?.response?.metadata?.selectedSkill || job.skillHint),
      sentAt: job.sentAt,
      originalText: job.originalText,
      sentText: scrubOutboundText(turnLog[0]?.outboundText || job.initialText),
      replyText,
      replyAt: nowISO(),
      peerSessionId: clean(result?.peerSessionId),
      conversationKey: job.conversationKey,
      turnCount: turnLog.length || 1,
      stopReason: finalRemoteControl.stopReason || localStopReason,
      overallSummary,
      turnOutline,
      conversationTurns,
      detailsHint: continuationError
        ? `The exchange then failed after the recorded turns: ${continuationError}`
        : '',
      language: job.ownerLanguage,
      timeZone: job.ownerTimeZone,
      localTime: true
    })
    await ownerNotifier({
      selectedSkill: job.skillHint,
      mailboxKey: `outbound:${job.conversationKey}`,
      item: {
        inboundId: `sender-success-${job.conversationKey}`,
        remoteAgentId: job.targetAgentId,
        peerSessionId: clean(result?.peerSessionId),
        dedupeKey: job.dedupeKey,
        request: {
          params: {
            metadata: {
              conversationKey: job.conversationKey
            }
          }
        }
      },
      ownerReport: {
        ...senderReport,
        deliveryId: `sender-success-${job.conversationKey}`,
        dedupeKey: job.dedupeKey,
        conversationKey: job.conversationKey,
        ownerRoute: job.ownerRoute,
        ownerRouteSource: job.ownerRouteSource,
        ownerRouteSessionId: job.ownerRouteSessionId,
        final: true,
        finalize: true
      },
      peerResponse: result?.response ?? null
    })
  }

  async function runOutboundConversationJob(job) {
    job.status = 'running'
    job.startedAt = nowISO()
    let result = null
    const turnLog = []
    let currentOutboundText = job.initialText
    let currentOutboundControl = normalizeConversationControl({
      turnIndex: 1,
      decision: job.conversationPolicy.maxTurns <= 1 ? 'done' : 'continue',
      stopReason: job.conversationPolicy.maxTurns <= 1 ? 'completed' : '',
      final: job.conversationPolicy.maxTurns <= 1
    })
    let turnIndex = 1
    let localStopReason = ''
    let continuationError = ''
    let releaseOperation = () => {}
    try {
      const node = await ensureGatewayReady('outbound conversation job')
      releaseOperation = beginOperation()
      while (!stopping) {
        const turnStartedAt = Date.now()
        const turnSentAt = nowISO()
        result = await openDirectPeerSession({
          apiBase,
          agentId,
          bundle,
          node,
          binding,
          targetAgentId: job.targetAgentId,
          skillName: job.skillHint,
          method: job.method,
          message: {
            kind: 'message',
            role: 'user',
            parts: [{ kind: 'text', text: currentOutboundText }]
          },
          metadata: {
            conversationPolicy: job.conversationPolicy,
            originalOwnerText: turnIndex === 1 ? job.originalText : currentOutboundText,
            conversationKey: job.conversationKey,
            sentAt: job.sentAt,
            turnIndex: currentOutboundControl.turnIndex,
            decision: currentOutboundControl.decision,
            stopReason: currentOutboundControl.stopReason,
            final: currentOutboundControl.final,
            finalize: currentOutboundControl.final
          },
          activitySummary: turnIndex === 1
            ? 'Preparing an AgentSquared peer conversation.'
            : `Continuing AgentSquared peer conversation turn ${turnIndex}.`,
          report: {
            taskId: job.skillHint,
            summary: `Delivered AgentSquared conversation turn ${turnIndex} to ${job.targetAgentId}.`,
            publicSummary: ''
          },
          sessionStore: runtimeState,
          diagnostics: createTransportDiagnostics({
            operation: 'outbound-job',
            jobId: job.jobId,
            targetAgentId: job.targetAgentId,
            skillHint: job.skillHint,
            conversationKey: job.conversationKey,
            turnIndex
          })
        })
        logGatewayEvent('outbound-job-turn-finish', {
          jobId: job.jobId,
          targetAgentId: job.targetAgentId,
          skillHint: job.skillHint,
          conversationKey: job.conversationKey,
          turnIndex,
          peerSessionId: clean(result.peerSessionId),
          trustedSessionHit: Boolean(result.trustedSessionHit),
          usedTrustedSession: Boolean(result.usedTrustedSession),
          reusedTrustedSession: Boolean(result.reusedTrustedSession),
          reusedPeerConnection: Boolean(result.reusedPeerConnection),
          usedFreshRelayTicket: Boolean(result.usedFreshRelayTicket),
          reusedSession: Boolean(result.reusedSession),
          durationMs: Date.now() - turnStartedAt
        })
        job.peerSessionId = clean(result.peerSessionId)
        job.turnCount = turnIndex

        const replyText = peerResponseText(result.response)
        const remoteControl = normalizeConversationControl(extractPeerResponseMetadata(result.response), {
          defaultTurnIndex: turnIndex,
          defaultDecision: 'done',
          defaultStopReason: turnIndex >= job.conversationPolicy.maxTurns ? 'completed' : ''
        })
        turnLog.push({
          turnIndex,
          outboundText: currentOutboundText,
          replyText,
          sentAt: turnSentAt,
          repliedAt: nowISO(),
          localDecision: currentOutboundControl.decision,
          localStopReason: currentOutboundControl.stopReason,
          remoteDecision: remoteControl.decision,
          remoteStopReason: remoteControl.stopReason,
          localFinal: currentOutboundControl.final,
          remoteFinal: remoteControl.final
        })

        if (turnIndex === 1) {
          conversationStore?.appendTurn?.({
            conversationKey: job.conversationKey,
            peerSessionId: job.peerSessionId,
            remoteAgentId: job.targetAgentId,
            selectedSkill: job.skillHint,
            turnIndex: 1,
            inboundText: '',
            replyText: currentOutboundText,
            decision: currentOutboundControl.decision,
            stopReason: currentOutboundControl.stopReason,
            final: currentOutboundControl.final,
            ownerSummary: 'Sent outbound initialization'
          })
        }

        if (currentOutboundControl.final || !shouldContinueConversation(remoteControl)) {
          break
        }

        const nextTurnIndex = turnIndex + 1
        if (nextTurnIndex > job.conversationPolicy.maxTurns) {
          localStopReason = 'completed'
          break
        }

        let localExecution
        const localTurnStartedAt = Date.now()
        try {
          logGatewayEvent('outbound-job-local-turn-start', {
            jobId: job.jobId,
            targetAgentId: job.targetAgentId,
            skillHint: job.skillHint,
            conversationKey: job.conversationKey,
            turnIndex: nextTurnIndex,
            peerSessionId: clean(result?.peerSessionId)
          })
          localExecution = await executeLocalConversationTurn({
            localRuntimeExecutor,
            localAgentId: agentId,
            targetAgentId: job.targetAgentId,
            peerSessionId: result.peerSessionId,
            conversationKey: job.conversationKey,
            skillHint: job.skillHint,
            conversationPolicy: job.conversationPolicy,
            inboundText: replyText,
            originalOwnerText: job.originalText,
            turnIndex: nextTurnIndex,
            remoteControl
          })
          logGatewayEvent('outbound-job-local-turn-finish', {
            jobId: job.jobId,
            targetAgentId: job.targetAgentId,
            skillHint: job.skillHint,
            conversationKey: job.conversationKey,
            turnIndex: nextTurnIndex,
            peerSessionId: clean(result?.peerSessionId),
            durationMs: Date.now() - localTurnStartedAt,
            rejected: Boolean(localExecution?.reject)
          })
        } catch (error) {
          continuationError = `Local AI runtime failure while preparing turn ${nextTurnIndex}: ${clean(error?.message) || 'unknown error'}`
          localStopReason = 'system-error'
          logGatewayEvent('outbound-job-local-turn-error', {
            level: 'debug',
            jobId: job.jobId,
            targetAgentId: job.targetAgentId,
            skillHint: job.skillHint,
            conversationKey: job.conversationKey,
            turnIndex: nextTurnIndex,
            peerSessionId: clean(result?.peerSessionId),
            durationMs: Date.now() - localTurnStartedAt,
            message: clean(error?.message) || 'unknown error'
          })
          console.error(`${continuationError}${error.cause ? `; cause: ${error.cause.message || error.cause}` : ''}`)
          break
        }
        if (localExecution?.reject) {
          continuationError = clean(localExecution.reject.message) || 'local runtime rejected the inbound request'
          localStopReason = 'system-error'
          break
        }
        const localControl = normalizeConversationControl(localExecution?.peerResponse?.metadata ?? {}, {
          defaultTurnIndex: nextTurnIndex,
          defaultDecision: nextTurnIndex >= job.conversationPolicy.maxTurns ? 'done' : 'continue',
          defaultStopReason: nextTurnIndex >= job.conversationPolicy.maxTurns ? 'completed' : ''
        })
        currentOutboundText = scrubOutboundText(peerResponseText(localExecution.peerResponse))
        if (!currentOutboundText) {
          localStopReason = 'completed'
          break
        }
        turnIndex = nextTurnIndex
        currentOutboundControl = localControl
        if (localControl.final && clean(localControl.stopReason)) {
          localStopReason = localControl.stopReason
        }
      }

      job.status = 'completed'
      job.finishedAt = nowISO()
      job.turnCount = turnLog.length || job.turnCount || 1
      await notifyOutboundJobSuccess(job, result, turnLog, { localStopReason, continuationError })
    } catch (error) {
      job.finishedAt = nowISO()
      job.error = clean(error?.message) || 'outbound conversation job failed'
      if (turnLog.length > 0) {
        job.status = 'completed'
        await notifyOutboundJobSuccess(job, result, turnLog, {
          localStopReason: 'system-error',
          continuationError: `Outbound P2P delivery failure: ${job.error}`
        })
      } else {
        job.status = 'failed'
        await notifyOutboundJobFailure(job, error)
      }
    } finally {
      releaseOperation()
      setTimeout(() => {
        outboundJobs.delete(job.jobId)
      }, 30 * 60 * 1000).unref?.()
    }
  }

  function enqueueOutboundConversationJob(body = {}) {
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
    const ownerContext = body.ownerContext && typeof body.ownerContext === 'object' ? body.ownerContext : {}
    const conversationKey = clean(metadata.conversationKey) || `conversation_${Math.random().toString(16).slice(2)}`
    const jobId = `outbound-job-${conversationKey}`
    if (outboundJobs.has(jobId)) {
      return outboundJobs.get(jobId)
    }
    const runningJob = activeOutboundJob()
    if (runningJob) {
      return runningJob
    }
    const conversationPolicy = metadata.conversationPolicy && typeof metadata.conversationPolicy === 'object'
      ? metadata.conversationPolicy
      : { maxTurns: 1 }
    const initialText = peerResponseText({
      message: body.message
    }) || clean(body.message?.text)
    const job = {
      jobId,
      status: 'queued',
      targetAgentId: agentSquaredAgentIdForWire(requireArg(body.targetAgentId, 'targetAgentId is required'), { label: 'targetAgentId' }),
      skillHint: clean(body.skillHint ?? body.skillName),
      method: requireArg(body.method, 'method is required'),
      initialText: requireArg(initialText, 'message text is required'),
      originalText: clean(ownerContext.originalText) || clean(metadata.originalOwnerText) || initialText,
      sentAt: clean(metadata.sentAt) || clean(ownerContext.startedAt) || nowISO(),
      conversationKey,
      conversationPolicy: {
        maxTurns: Math.max(1, Math.min(20, Number.parseInt(`${conversationPolicy.maxTurns ?? 1}`, 10) || 1))
      },
      ownerLanguage: clean(ownerContext.ownerLanguage) || inferOwnerFacingLanguage(clean(ownerContext.originalText), initialText),
      ownerTimeZone: clean(ownerContext.ownerTimeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      ownerRoute: clean(ownerContext.ownerRoute || ownerContext.ownerTarget),
      ownerRouteSource: clean(ownerContext.ownerRouteSource || ownerContext.ownerTargetSource),
      ownerRouteSessionId: clean(ownerContext.ownerRouteSessionId || ownerContext.ownerTargetSessionId),
      dedupeKey: clean(ownerContext.dedupeKey),
      peerSessionId: '',
      turnCount: 0,
      startedAt: '',
      finishedAt: '',
      error: ''
    }
    outboundJobs.set(jobId, job)
    runOutboundConversationJob(job).catch((error) => {
      job.status = 'failed'
      job.finishedAt = nowISO()
      job.error = clean(error?.message) || 'outbound conversation job failed'
      console.error(`outbound conversation job failed: ${job.error}`)
    })
    return job
  }

  async function runHealthCheck(source) {
    if (recoveryPromise || stopping) {
      return
    }
    if (activeOperations !== 0) {
      logGatewayEvent('gateway-health-skipped-active-operation', {
        source,
        activeOperations
      })
      return
    }
    if (!currentNode) {
      try {
        await recoverGateway(`${source}: no active gateway node`)
      } catch (error) {
        noteFailure(error)
        console.error(`${source} recovery failed: ${error.message}`)
      }
      return
    }
    await refreshHostRuntimeCheck(source)
    try {
      await verifyTransport(currentNode)
      await verifyRelayControlPlane(currentNode)
    } catch (error) {
      noteFailure(error)
      console.error(`${source} failed: ${error.message}${error.cause ? `; cause: ${error.cause.message || error.cause}` : ''}`)
      logGatewayEvent('gateway-health-failure', {
        level: 'debug',
        source,
        message: error.message,
        cause: error.cause ? (error.cause.message || error.cause) : null
      })
      if (lifecycle.consecutiveFailures >= failuresBeforeRecover) {
        if (activeOperations !== 0 && currentNode) {
          deferRecovery(`${source}: ${error.message}`)
          return
        }
        try {
          await recoverGateway(`${source}: ${error.message}`)
        } catch (recoveryError) {
          noteFailure(recoveryError)
          console.error(`${source} recovery failed: ${recoveryError.message}`)
        }
      }
    }
  }

  async function runIntegratedRouterLoop() {
    if (!integratedRouter) {
      return
    }
    while (!stopping) {
      const item = await runtimeState.nextInbound({ waitMs: routerWaitMs })
      if (!item?.inboundId) {
        continue
      }
      integratedRouter.enqueue(item).catch((error) => {
        try {
          runtimeState.rejectInbound({
            inboundId: item.inboundId,
            code: Number.parseInt(`${error?.code ?? 500}`, 10) || 500,
            message: error?.message ?? 'integrated agent router failed to process inbound request',
            stage: clean(error?.a2RuntimeStage || error?.stage),
            runtimeAdapter: clean(error?.runtimeAdapter || error?.a2RuntimeAdapter),
            failureKind: clean(error?.a2FailureKind || error?.failureKind),
            detail: describeErrorForOutput(error)
          })
        } catch (rejectError) {
          console.error(rejectError.message)
        }
        console.error(error?.message ?? 'integrated agent router failed to process inbound request')
      })
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', gatewayBase)
      if (req.method === 'GET' && url.pathname === '/health') {
        const state = readGatewayState(gatewayStateFile)
        let revisionStatus
        try {
          revisionStatus = assertGatewayStateFresh(state, gatewayStateFile)
        } catch (error) {
          revisionStatus = {
            stale: true,
            expectedRevision: runtimeRevision,
            currentRevision: `${state?.runtimeRevision ?? ''}`.trim(),
            message: error.message
          }
        }
        if (recoveryPromise || !currentNode) {
          healthResponse(res, 503, {
            agentId,
            gatewayBase,
            gatewayStateFile,
            runtimeRevision,
            revisionStatus,
            hostRuntime: detectedHostRuntime,
            startupChecks,
            relayControl,
            routerMode,
            agentRouter: buildRouterSnapshot(),
            lifecycle: buildLifecycleSnapshot(),
            runtimeState: runtimeState.snapshot(),
            conversations: conversationStore.snapshot(),
            outboundJobs: buildOutboundJobsSnapshot(),
            inbox: inboxStore.snapshot()
          })
          return
        }
        const hostRuntimeCheck = await refreshHostRuntimeCheck('health endpoint')
        if (resolvedHostRuntime !== 'none' && hostRuntimeCheck.ok === false) {
          healthResponse(res, 503, {
            agentId,
            gatewayBase,
            gatewayStateFile,
            runtimeRevision,
            revisionStatus,
            hostRuntime: detectedHostRuntime,
            startupChecks,
            relayControl,
            routerMode,
            error: { message: `host runtime preflight failed: ${hostRuntimeCheck.error}` },
            agentRouter: buildRouterSnapshot(),
            lifecycle: buildLifecycleSnapshot(),
            runtimeState: runtimeState.snapshot(),
            conversations: conversationStore.snapshot(),
            outboundJobs: buildOutboundJobsSnapshot(),
            inbox: inboxStore.snapshot()
          })
          return
        }
        try {
          const transport = await verifyTransport(currentNode)
          await verifyRelayControlPlane(currentNode, { force: true })
          healthResponse(res, 200, {
            agentId,
            gatewayBase,
            gatewayStateFile,
            runtimeRevision,
            revisionStatus,
            hostRuntime: detectedHostRuntime,
            startupChecks,
            relayControl,
            peerId: transport.peerId,
            listenAddrs: transport.listenAddrs,
            relayAddrs: transport.relayAddrs,
            directListenAddrs: directListenAddrs(currentNode),
            relayReservationAddrs: relayReservationAddrs(currentNode),
            streamProtocol: transport.streamProtocol,
            supportedBindings: transport.supportedBindings,
            routerMode,
            agentRouter: buildRouterSnapshot(),
            lifecycle: buildLifecycleSnapshot(),
            runtimeState: runtimeState.snapshot(),
            conversations: conversationStore.snapshot(),
            outboundJobs: buildOutboundJobsSnapshot(),
            inbox: inboxStore.snapshot()
          })
          return
        } catch (error) {
          noteFailure(error)
          healthResponse(res, 503, {
            agentId,
            gatewayBase,
            gatewayStateFile,
            runtimeRevision,
            revisionStatus,
            hostRuntime: detectedHostRuntime,
            startupChecks,
            relayControl,
            routerMode,
            error: { message: error.message },
            agentRouter: buildRouterSnapshot(),
            lifecycle: buildLifecycleSnapshot(),
            runtimeState: runtimeState.snapshot(),
            conversations: conversationStore.snapshot(),
            outboundJobs: buildOutboundJobsSnapshot(),
            inbox: inboxStore.snapshot()
          })
          return
        }
      }

      if (req.method === 'GET' && url.pathname === '/inbox/index') {
        jsonResponse(res, 200, {
          index: inboxStore.readIndex(),
          snapshot: inboxStore.snapshot()
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/conversations/show') {
        const conversationId = clean(url.searchParams.get('conversationId'))
        if (!conversationId) {
          jsonResponse(res, 400, { error: { message: 'conversationId is required' } })
          return
        }
        const conversation = inboxStore.findConversation?.(conversationId)
        if (!conversation) {
          jsonResponse(res, 404, { error: { message: `Conversation ${conversationId} was not found in the local AgentSquared inbox.` } })
          return
        }
        jsonResponse(res, 200, conversation)
        return
      }

      if (req.method === 'POST' && url.pathname === '/owner/notifications') {
        const body = await readJson(req)
        const deliveryId = clean(body.deliveryId ?? body.id)
        const ownerReport = body.ownerReport && typeof body.ownerReport === 'object' ? body.ownerReport : {}
        const localAgentId = clean(body.agentId) || agentId
        const ownerSenderAgentId = clean(ownerReport.senderAgentId)
        const ownerRecipientAgentId = clean(ownerReport.recipientAgentId)
        const remoteAgentId = [
          body.remoteAgentId,
          body.targetAgentId,
          ownerReport.remoteAgentId,
          ownerReport.targetAgentId,
          ownerSenderAgentId && ownerSenderAgentId !== localAgentId ? ownerSenderAgentId : '',
          ownerRecipientAgentId && ownerRecipientAgentId !== localAgentId ? ownerRecipientAgentId : ''
        ].map(clean).find(Boolean) || ''
        const selectedSkill = [
          body.selectedSkill,
          body.skillHint,
          ownerReport.selectedSkill,
          ownerReport.receiverSkill,
          ownerReport.senderSkill
        ].map(clean).find(Boolean) || ''
        const conversationKey = clean(body.conversationKey) || clean(ownerReport.conversationKey)
        const result = await ownerNotifier({
          selectedSkill,
          mailboxKey: clean(body.mailboxKey),
          forceOwnerDelivery: Boolean(body.forceOwnerDelivery),
          waitForOwnerDelivery: Boolean(body.waitForOwnerDelivery),
          item: {
            inboundId: deliveryId || `owner-notification-${Date.now()}`,
            remoteAgentId,
            peerSessionId: clean(body.peerSessionId ?? ownerReport.peerSessionId),
            conversationKey,
            dedupeKey: clean(body.dedupeKey ?? ownerReport.dedupeKey),
            request: body.request ?? null
          },
          ownerReport: {
            ...ownerReport,
            conversationKey,
            remoteAgentId,
            selectedSkill,
            deliveryId: deliveryId || ownerReport.deliveryId,
            dedupeKey: clean(body.dedupeKey ?? ownerReport.dedupeKey),
            forceOwnerDelivery: Boolean(body.forceOwnerDelivery ?? ownerReport.forceOwnerDelivery),
            waitForOwnerDelivery: Boolean(body.waitForOwnerDelivery ?? ownerReport.waitForOwnerDelivery)
          },
          peerResponse: body.peerResponse ?? null
        })
        jsonResponse(res, 200, {
          ok: true,
          handled: true,
          status: result?.ownerDelivery?.status || result?.notificationStatus || 'sent',
          deliveredToOwner: Boolean(result?.deliveredToOwner || result?.ownerDelivery?.delivered),
          ownerDelivery: result?.ownerDelivery ?? null,
          ownerNotification: result?.ownerDelivery?.delivered || result?.deliveredToOwner ? 'sent' : 'failed',
          entryId: result.entryId,
          totalCount: result.totalCount
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/inbound/next') {
        if (integratedRouter) {
          jsonResponse(res, 409, { error: { message: 'integrated agent router is active; external inbound polling is disabled' } })
          return
        }
        const waitMs = Number.parseInt(url.searchParams.get('waitMs') ?? '30000', 10)
        const nextInbound = await runtimeState.nextInbound({ waitMs })
        jsonResponse(res, 200, { item: nextInbound })
        return
      }

      if (req.method === 'POST' && url.pathname === '/inbound/respond') {
        if (integratedRouter) {
          jsonResponse(res, 409, { error: { message: 'integrated agent router is active; external inbound responses are disabled' } })
          return
        }
        const body = await readJson(req)
        runtimeState.respondInbound({
          inboundId: requireArg(body.inboundId, 'inboundId is required'),
          result: body.result ?? {}
        })
        jsonResponse(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/inbound/reject') {
        if (integratedRouter) {
          jsonResponse(res, 409, { error: { message: 'integrated agent router is active; external inbound rejects are disabled' } })
          return
        }
        const body = await readJson(req)
        runtimeState.rejectInbound({
          inboundId: requireArg(body.inboundId, 'inboundId is required'),
          code: Number.parseInt(body.code ?? '500', 10) || 500,
          message: `${body.message ?? 'local runtime rejected the inbound request'}`,
          stage: clean(body.stage),
          runtimeAdapter: clean(body.runtimeAdapter),
          failureKind: clean(body.failureKind),
          detail: clean(body.detail)
        })
        jsonResponse(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/connect-jobs') {
        await ensureGatewayReady('outbound conversation job submit')
        const body = await readJson(req)
        const job = enqueueOutboundConversationJob(body)
        const requestedConversationKey = clean(body?.metadata?.conversationKey)
        const alreadyRunning = Boolean(requestedConversationKey && requestedConversationKey !== job.conversationKey)
        logGatewayEvent('connect-job-accepted', {
          jobId: job.jobId,
          status: alreadyRunning ? 'already-running' : 'accepted',
          targetAgentId: job.targetAgentId,
          skillHint: job.skillHint,
          conversationKey: job.conversationKey,
          requestedConversationKey,
          maxTurns: job.conversationPolicy.maxTurns
        })
        jsonResponse(res, 202, {
          ok: true,
          status: alreadyRunning ? 'already-running' : 'accepted',
          jobId: job.jobId,
          conversationKey: job.conversationKey,
          targetAgentId: job.targetAgentId,
          skillHint: job.skillHint,
          alreadyRunning
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/connect') {
        const node = await ensureGatewayReady('connect request')
        const releaseOperation = beginOperation()
        let clientDisconnected = false
        req.once('aborted', () => {
          clientDisconnected = true
        })
        res.once('close', () => {
          if (!res.writableEnded) {
            clientDisconnected = true
          }
        })
        const startedAt = Date.now()
        let body = null
        try {
          body = await readJson(req)
          logGatewayEvent('connect-start', {
            targetAgentId: clean(body.targetAgentId),
            skillHint: clean(body.skillHint ?? body.skillName),
            conversationKey: clean(body.metadata?.conversationKey),
            turnIndex: Number.parseInt(`${body.metadata?.turnIndex ?? 1}`, 10) || 1
          })
          const result = await openDirectPeerSession({
            apiBase,
            agentId,
            bundle,
            node,
            binding,
            targetAgentId: agentSquaredAgentIdForWire(requireArg(body.targetAgentId, 'targetAgentId is required'), { label: 'targetAgentId' }),
            skillName: (body.skillHint ?? body.skillName ?? '').trim(),
            method: requireArg(body.method, 'method is required'),
            message: body.message,
            metadata: body.metadata ?? null,
            activitySummary: (body.activitySummary ?? '').trim() || `Preparing direct peer session${(body.skillHint ?? body.skillName ?? '').trim() ? ` for ${(body.skillHint ?? body.skillName ?? '').trim()}` : ''}.`,
            report: body.report ?? null,
            sessionStore: runtimeState,
            diagnostics: createTransportDiagnostics({
              operation: 'connect',
              targetAgentId: clean(body.targetAgentId),
              skillHint: clean(body.skillHint ?? body.skillName),
              conversationKey: clean(body.metadata?.conversationKey),
              turnIndex: Number.parseInt(`${body.metadata?.turnIndex ?? 1}`, 10) || 1
            })
          })
          logGatewayEvent('connect-finish', {
            targetAgentId: clean(body.targetAgentId),
            skillHint: clean(body.skillHint ?? body.skillName),
            conversationKey: clean(body.metadata?.conversationKey),
            peerSessionId: clean(result.peerSessionId),
            trustedSessionHit: Boolean(result.trustedSessionHit),
            usedTrustedSession: Boolean(result.usedTrustedSession),
            reusedTrustedSession: Boolean(result.reusedTrustedSession),
            reusedPeerConnection: Boolean(result.reusedPeerConnection),
            usedFreshRelayTicket: Boolean(result.usedFreshRelayTicket),
            reusedSession: Boolean(result.reusedSession),
            clientDisconnected: isClientDisconnected(req, res, clientDisconnected),
            durationMs: Date.now() - startedAt
          })
          if (isClientDisconnected(req, res, clientDisconnected)) {
            await notifyLateConnectResult({
              ownerNotifier,
              localRuntimeExecutor,
              agentId,
              body,
              result
            })
            return
          }
          jsonResponse(res, 200, result)
          return
        } catch (error) {
          logGatewayEvent('connect-error', {
            targetAgentId: clean(body?.targetAgentId),
            skillHint: clean(body?.skillHint ?? body?.skillName),
            conversationKey: clean(body?.metadata?.conversationKey),
            dispatchStage: clean(error?.a2DispatchStage),
            deliveryStatusKnown: Boolean(error?.a2DeliveryStatusKnown),
            code: clean(error?.code),
            message: clean(error?.message),
            durationMs: Date.now() - startedAt
          })
          throw error
        } finally {
          releaseOperation()
        }
      }

      jsonResponse(res, 404, { error: { message: 'Not found' } })
    } catch (error) {
      const statusCode = Number.parseInt(`${error?.code ?? 500}`, 10) || 500
      const errorData = {
        ...(error?.data && typeof error.data === 'object' ? error.data : {}),
        ...(error?.a2FailureKind ? { failureKind: clean(error.a2FailureKind) } : {})
      }
      jsonResponse(res, statusCode >= 400 && statusCode < 600 ? statusCode : 500, {
        error: {
          message: error.message,
          ...(Object.keys(errorData).length > 0 ? { data: errorData } : {})
        }
      })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(gatewayPort, gatewayHost, resolve)
  })
  const controlAddress = server.address()
  actualGatewayPort = typeof controlAddress === 'object' && controlAddress ? controlAddress.port : gatewayPort
  gatewayBase = `http://${gatewayHost}:${actualGatewayPort}`

  try {
    await recoverGateway('initial startup')
  } catch (error) {
    noteFailure(error)
    console.error(`gateway initial startup failed: ${error.message}`)
    throw error
  }

  const integratedRouterLoop = integratedRouter
    ? runIntegratedRouterLoop().catch((error) => {
        console.error(`integrated agent router stopped: ${error.message}`)
      })
    : null

  const presenceTimer = presenceRefreshMs > 0
    ? setInterval(async () => {
        if (stopping || recoveryPromise) {
          return
        }
        if (activeOperations !== 0) {
          logGatewayEvent('gateway-presence-skipped-active-operation', {
            activeOperations
          })
          return
        }
        if (!currentNode) {
          try {
            await recoverGateway('presence refresh found no active gateway node')
          } catch (error) {
            noteFailure(error)
            console.error(`gateway presence recovery failed: ${error.message}`)
          }
          return
        }
        try {
          await publishPresence(currentNode)
        } catch (error) {
          noteFailure(error)
          console.error(`gateway presence refresh failed: ${error.message}`)
          if (lifecycle.consecutiveFailures >= failuresBeforeRecover) {
            try {
              await recoverGateway(`presence refresh failed: ${error.message}`)
            } catch (recoveryError) {
              noteFailure(recoveryError)
              console.error(`gateway presence recovery failed: ${recoveryError.message}`)
            }
          }
        }
      }, presenceRefreshMs)
    : null

  const healthTimer = setInterval(async () => {
    await runHealthCheck('gateway transport watchdog')
  }, healthCheckMs)

  const stop = async () => {
    if (stopping) {
      return
    }
    stopping = true
    if (presenceTimer) {
      clearInterval(presenceTimer)
    }
    clearInterval(healthTimer)
    await sleep(10)
    if (recoveryPromise) {
      try {
        await recoveryPromise
      } catch {
        // best-effort shutdown only
      }
    }
    if (integratedRouter) {
      try {
        await integratedRouter.whenIdle()
      } catch {
        // best-effort shutdown only
      }
    }
    await new Promise((resolve) => server.close(resolve))
    await stopNode(currentNode)
    gatewayProcessLock.releaseSync()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    stop().catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
  })
  process.on('SIGTERM', () => {
    stop().catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runGateway(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
