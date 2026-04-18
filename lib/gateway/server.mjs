#!/usr/bin/env node

import http from 'node:http'
import path from 'node:path'
import { URL } from 'node:url'
import { fileURLToPath } from 'node:url'

import { parseArgs, parseList, requireArg } from '../shared/primitives.mjs'
import { getBindingDocument, getFriendDirectory } from '../transport/relay_http.mjs'
import { loadRuntimeKeyBundle } from '../runtime/keys.mjs'
import { DEFAULT_LISTEN_ADDRS, buildRelayListenAddrs, createNode, directListenAddrs, relayReservationAddrs } from '../transport/libp2p.mjs'
import { attachInboundRouter, currentTransport, openDirectPeerSession, publishGatewayPresence } from '../transport/peer_session.mjs'
import { assertGatewayStateFresh, currentRuntimeRevision, defaultGatewayStateFile, readGatewayState, writeGatewayState } from './state.mjs'
import { createGatewayRuntimeState } from './runtime_state.mjs'
import { createAgentRouter, DEFAULT_ROUTER_DEFAULT_SKILL, DEFAULT_ROUTER_SKILLS } from '../routing/agent_router.mjs'
import { createLocalRuntimeExecutor, createOwnerNotifier } from '../runtime/executor.mjs'
import { createInboxStore } from './inbox.mjs'
import { createLiveConversationStore } from '../conversation/store.mjs'
import { defaultInboxDir, defaultOpenClawStateDir, defaultPeerKeyFile as defaultPeerKeyFileFromLayout } from '../shared/paths.mjs'
import { SUPPORTED_HOST_RUNTIMES, detectHostRuntimeEnvironment } from '../../adapters/index.mjs'
import { resolveOpenClawAgentSelection } from '../../adapters/openclaw/detect.mjs'
import { buildStandardRuntimeOwnerLines, buildStandardRuntimeReport, currentRuntimeMetadata } from '../runtime/report.mjs'
import { buildSenderBaseReport, inferOwnerFacingLanguage, peerResponseText } from '../conversation/templates.mjs'
import { normalizeConversationControl } from '../conversation/policy.mjs'

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

function nowISO() {
  return new Date().toISOString()
}

function logGatewayEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({
      ts: nowISO(),
      event,
      ...details
    }))
  } catch {
    // Diagnostics must never affect the gateway hot path.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function isClientDisconnected(req, res, disconnected = false) {
  return Boolean(
    disconnected
    || req?.aborted
    || req?.destroyed
    || (res?.destroyed && !res?.writableEnded)
    || res?.closed
  )
}

export async function notifyLateConnectResult({
  ownerNotifier,
  agentId,
  body,
  result
}) {
  if (typeof ownerNotifier !== 'function' || !body || !result) {
    return
  }
  const targetAgentId = clean(body.targetAgentId)
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
  const senderReport = buildSenderBaseReport({
    localAgentId: agentId,
    targetAgentId,
    selectedSkill,
    sentAt,
    originalText,
    sentText: originalText,
    replyText,
    replyAt: nowISO(),
    conversationKey,
    peerSessionId: clean(result.peerSessionId),
    turnCount: Math.max(1, conversation.turnIndex || 1),
    stopReason: clean(conversation.stopReason),
    overallSummary: excerpt(replyText, 240) || 'The remote agent replied through AgentSquared.',
    actionItems,
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
  const agentId = requireArg(args['agent-id'], '--agent-id is required')
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

  const binding = await getBindingDocument(apiBase)
  startupChecks.relay = { ok: true, error: '' }
  const relayListenAddrs = buildRelayListenAddrs(binding.relayMultiaddrs ?? [])
  const requireRelayReservation = relayListenAddrs.length > 0

  try {
    const preflight = await localRuntimeExecutor.preflight?.()
    startupChecks.hostRuntime = {
      ok: Boolean(preflight?.ok ?? resolvedHostRuntime === 'none'),
      error: preflight?.ok === false ? clean(preflight?.error || preflight?.reason || 'host runtime preflight failed') : ''
    }
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
  const idleWaiters = []
  const integratedRouter = routerMode === 'integrated'
    ? createAgentRouter({
        maxActiveMailboxes,
        routerSkills,
        defaultSkill,
        executeInbound: localRuntimeExecutor,
        notifyOwner: ownerNotifier,
        onRespond(item, result) {
          runtimeState.respondInbound({
            inboundId: item.inboundId,
            result
          })
        },
        onReject(item, payload) {
          runtimeState.rejectInbound({
            inboundId: item.inboundId,
            code: payload.code,
            message: payload.message
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

  function flushIdleWaiters() {
    if (activeOperations !== 0) {
      return
    }
    while (idleWaiters.length > 0) {
      const resolve = idleWaiters.shift()
      resolve?.(true)
    }
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

  function buildLifecycleSnapshot() {
    return {
      ...lifecycle,
      activeOperations,
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

    recoveryPromise = (async () => {
      lifecycle.recovering = true
      lifecycle.lastRecoveryAt = nowISO()
      lifecycle.lastRecoveryReason = `${reason}`.trim() || 'gateway recovery'

      const previousNode = currentNode
      currentNode = null
      online = null

      await waitForIdle(recoveryIdleWaitMs)
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
        console.log(JSON.stringify({
          event: lifecycle.generation === 1 ? 'gateway-started' : 'gateway-recovered',
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
          standardReport,
          ownerFacingLines,
          ownerFacingText: toOwnerFacingText(ownerFacingLines)
        }, null, 2))
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
      throw new Error('gateway transport is unavailable')
    }
    try {
      await verifyTransport(currentNode)
      await verifyRelayControlPlane(currentNode)
      return currentNode
    } catch (error) {
      noteFailure(error)
      await recoverGateway(`${reason}: ${error.message}`)
      if (!currentNode) {
        throw new Error(`gateway transport is unavailable: ${error.message}`)
      }
      await verifyTransport(currentNode)
      await verifyRelayControlPlane(currentNode, { force: true })
      return currentNode
    }
  }

  async function runHealthCheck(source) {
    if (recoveryPromise || stopping) {
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
    try {
      await verifyTransport(currentNode)
      await verifyRelayControlPlane(currentNode)
    } catch (error) {
      noteFailure(error)
      console.error(`${source} failed: ${error.message}`)
      if (lifecycle.consecutiveFailures >= failuresBeforeRecover) {
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
            message: error?.message ?? 'integrated agent router failed to process inbound request'
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
          jsonResponse(res, 503, {
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
            inbox: inboxStore.snapshot()
          })
          return
        }
        try {
          const transport = await verifyTransport(currentNode)
          await verifyRelayControlPlane(currentNode, { force: true })
          jsonResponse(res, 200, {
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
            inbox: inboxStore.snapshot()
          })
          return
        } catch (error) {
          noteFailure(error)
          jsonResponse(res, 503, {
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

      if (req.method === 'POST' && url.pathname === '/owner/notifications') {
        const body = await readJson(req)
        const deliveryId = clean(body.deliveryId ?? body.id)
        const ownerReport = body.ownerReport && typeof body.ownerReport === 'object' ? body.ownerReport : {}
        const remoteAgentId = clean(body.remoteAgentId ?? body.targetAgentId ?? ownerReport.remoteAgentId ?? ownerReport.targetAgentId)
        const selectedSkill = clean(body.selectedSkill ?? body.skillHint ?? ownerReport.selectedSkill)
        const result = await ownerNotifier({
          selectedSkill,
          mailboxKey: clean(body.mailboxKey),
          item: {
            inboundId: deliveryId || `owner-notification-${Date.now()}`,
            remoteAgentId,
            peerSessionId: clean(body.peerSessionId),
            dedupeKey: clean(body.dedupeKey ?? ownerReport.dedupeKey),
            request: body.request ?? null
          },
          ownerReport: {
            ...ownerReport,
            deliveryId: deliveryId || ownerReport.deliveryId,
            dedupeKey: clean(body.dedupeKey ?? ownerReport.dedupeKey)
          },
          peerResponse: body.peerResponse ?? null
        })
        jsonResponse(res, 200, {
          ok: true,
          handled: true,
          status: 'sent',
          ownerNotification: 'sent',
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
          message: `${body.message ?? 'local runtime rejected the inbound request'}`
        })
        jsonResponse(res, 200, { ok: true })
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
            targetAgentId: requireArg(body.targetAgentId, 'targetAgentId is required'),
            skillName: (body.skillHint ?? body.skillName ?? '').trim(),
            method: requireArg(body.method, 'method is required'),
            message: body.message,
            metadata: body.metadata ?? null,
            activitySummary: (body.activitySummary ?? '').trim() || `Preparing direct peer session${(body.skillHint ?? body.skillName ?? '').trim() ? ` for ${(body.skillHint ?? body.skillName ?? '').trim()}` : ''}.`,
            report: body.report ?? null,
            sessionStore: runtimeState
          })
          logGatewayEvent('connect-finish', {
            targetAgentId: clean(body.targetAgentId),
            skillHint: clean(body.skillHint ?? body.skillName),
            conversationKey: clean(body.metadata?.conversationKey),
            peerSessionId: clean(result.peerSessionId),
            reusedSession: Boolean(result.reusedSession),
            clientDisconnected: isClientDisconnected(req, res, clientDisconnected),
            durationMs: Date.now() - startedAt
          })
          if (isClientDisconnected(req, res, clientDisconnected)) {
            await notifyLateConnectResult({
              ownerNotifier,
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
      jsonResponse(res, 500, { error: { message: error.message } })
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
