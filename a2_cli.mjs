#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseArgs, randomRequestId, requireArg } from './lib/shared/primitives.mjs'
import { agentSquaredAgentIdForWire } from './lib/shared/agent_id.mjs'
import { gatewayConnect, gatewayConnectJob, gatewayConversationShow, gatewayHealth, gatewayInboxIndex, gatewayOwnerNotification } from './lib/gateway/api.mjs'
import { resolveGatewayBase, defaultGatewayStateFile, readGatewayState, currentRuntimeRevision } from './lib/gateway/state.mjs'
import { getFriendDirectory } from './lib/transport/relay_http.mjs'
import { generateRuntimeKeyBundle, writeRuntimeKeyBundle } from './lib/runtime/keys.mjs'
import { runGateway } from './lib/gateway/server.mjs'
import { SUPPORTED_HOST_RUNTIMES, createHostRuntimeAdapter, detectHostRuntimeEnvironment } from './adapters/index.mjs'
import { resolveHermesOwnerTarget } from './adapters/hermes/adapter.mjs'
import { resolveOpenClawAgentSelection } from './adapters/openclaw/detect.mjs'
import {
  defaultGatewayLogFile,
  defaultInboxDir,
  defaultOpenClawStateDir,
  defaultOnboardingSummaryFile,
  defaultReceiptFile,
  defaultRuntimeKeyFile,
  resolveAgentSquaredDir,
  resolveUserPath
} from './lib/shared/paths.mjs'
import { buildSenderBaseReport, buildSenderFailureReport, buildSkillOutboundText, inferOwnerFacingLanguage, normalizeConversationSummary, peerResponseText, renderConversationDetails, renderOwnerFacingReport } from './lib/conversation/templates.mjs'
import { scrubOutboundText } from './lib/runtime/safety.mjs'
import { buildStandardRuntimeOwnerLines, buildStandardRuntimeReport } from './lib/runtime/report.mjs'
import { chooseInboundSkill, resolveMailboxKey } from './lib/routing/agent_router.mjs'
import { createLocalRuntimeExecutor } from './lib/runtime/executor.mjs'
import { createLiveConversationStore } from './lib/conversation/store.mjs'
import { normalizeConversationControl, normalizeSharedSkillName, parseSkillDocumentPolicy, resolveConversationMaxTurns, shouldContinueConversation } from './lib/conversation/policy.mjs'
import {
  assertNoExistingLocalActivation,
  buildGatewayArgs,
  discoverLocalAgentProfiles,
  ensureGatewayForUse,
  inspectExistingGateway,
  resolveAgentContext,
  resolvedHostRuntimeFromHealth,
  signedRelayContext,
  toOwnerFacingText,
  waitForGatewayReady
} from './lib/gateway/lifecycle.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = __dirname

function clean(value) {
  return `${value ?? ''}`.trim()
}

function redactForOutput(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactForOutput(item, seen))
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const normalizedKey = clean(key).toLowerCase()
    if (
      normalizedKey === 'envvars'
      || normalizedKey === 'config'
      || /secret|password|token|api[_-]?key/.test(normalizedKey)
    ) {
      return [key, item ? '[redacted]' : item]
    }
    return [key, redactForOutput(item, seen)]
  }))
}

function stableDedupeKey(parts = []) {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => clean(part)).join('\u001f'))
    .digest('hex')
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value ?? ''}`, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function isTrueFlag(value) {
  const normalized = clean(value).toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function excerpt(text, maxLength = 180) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function parseJwtPayloadUnverified(token) {
  const serialized = clean(token)
  if (!serialized) {
    return null
  }
  const parts = serialized.split('.')
  if (parts.length < 2) {
    return null
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function printJson(payload) {
  console.log(JSON.stringify(redactForOutput(payload), null, 2))
}

function toOwnerFacingLines(text = '') {
  return clean(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

async function summarizeConversationWithRuntime(localRuntimeExecutor, context = {}, fallback = '') {
  if (typeof localRuntimeExecutor?.summarizeConversation !== 'function') {
    return normalizeConversationSummary(fallback)
  }
  try {
    return normalizeConversationSummary(await localRuntimeExecutor.summarizeConversation(context), { fallback })
  } catch {
    return normalizeConversationSummary(fallback)
  }
}

function buildOwnerReportDeliveredText(language = 'en') {
  if (`${language}`.toLowerCase().startsWith('zh')) {
    return '🅰️✌️ 最终的 AgentSquared 主人报告已经通过当前主人频道发送，请不要再追加任何形式的人类回复。'
  }
  return '🅰️✌️ The final owner-facing AgentSquared report has already been delivered through the current owner channel. Do not send any additional owner-facing reply.'
}

function defaultSuggestedHostRuntime() {
  return SUPPORTED_HOST_RUNTIMES.join(' or ')
}

function buildCliHostOptions(args = {}) {
  const preferredHostRuntime = clean(args['host-runtime']) || 'auto'
  const openclawCommand = clean(args['openclaw-command']) || 'openclaw'
  const openclawCwd = clean(args['openclaw-cwd'])
  const openclawConfigPath = clean(args['openclaw-config-path'] || process.env.OPENCLAW_CONFIG_PATH)
  const openclawGatewayUrl = clean(args['openclaw-gateway-url'])
  const openclawGatewayToken = clean(args['openclaw-gateway-token'])
  const openclawGatewayPassword = clean(args['openclaw-gateway-password'])
  const openclawSessionPrefix = clean(args['openclaw-session-prefix']) || 'agentsquared:'
  const openclawTimeoutMs = Math.max(1000, Number.parseInt(args['openclaw-timeout-ms'] ?? `${process.env.OPENCLAW_TIMEOUT_MS ?? '180000'}`, 10) || 180000)
  const hermesCommand = clean(args['hermes-command']) || 'hermes'
  const hermesHome = clean(args['hermes-home'] || process.env.HERMES_HOME)
  const hermesProfile = clean(args['hermes-profile'])
  const hermesApiBase = clean(args['hermes-api-base'])
  const hermesTimeoutMs = Math.max(1000, Number.parseInt(args['hermes-timeout-ms'] ?? `${process.env.HERMES_TIMEOUT_MS ?? '180000'}`, 10) || 180000)
  return {
    preferredHostRuntime,
    openclaw: {
      openclawAgent: clean(args['openclaw-agent']),
      command: openclawCommand,
      cwd: openclawCwd,
      configPath: openclawConfigPath,
      gatewayUrl: openclawGatewayUrl,
      gatewayToken: openclawGatewayToken,
      gatewayPassword: openclawGatewayPassword,
      sessionPrefix: openclawSessionPrefix,
      timeoutMs: openclawTimeoutMs
    },
    hermes: {
      command: hermesCommand,
      hermesHome,
      hermesProfile,
      apiBase: hermesApiBase,
      timeoutMs: hermesTimeoutMs
    }
  }
}

function hostRuntimeReady(detectedHostRuntime = null) {
  const resolved = clean(detectedHostRuntime?.resolved || detectedHostRuntime?.id).toLowerCase()
  if (!resolved || resolved === 'none') {
    return false
  }
  if (resolved === 'openclaw') {
    return Boolean(
      detectedHostRuntime?.rpcHealthy
      || detectedHostRuntime?.agentsList
      || detectedHostRuntime?.overviewStatus
      || detectedHostRuntime?.gatewayHealth
    )
  }
  if (resolved === 'hermes') {
    return Boolean(detectedHostRuntime?.apiServerHealthy)
  }
  return false
}

function summarizeHostRuntimeForOutput(detectedHostRuntime = null) {
  if (!detectedHostRuntime || typeof detectedHostRuntime !== 'object') {
    return null
  }
  const summary = {
    id: clean(detectedHostRuntime.id),
    detected: Boolean(detectedHostRuntime.detected),
    confidence: clean(detectedHostRuntime.confidence),
    reason: clean(detectedHostRuntime.reason),
    requested: clean(detectedHostRuntime.requested),
    resolved: clean(detectedHostRuntime.resolved || detectedHostRuntime.id),
    suggested: clean(detectedHostRuntime.suggested),
    workspaceDir: clean(detectedHostRuntime.workspaceDir),
    apiBase: clean(detectedHostRuntime.apiBase),
    apiServerHealthy: typeof detectedHostRuntime.apiServerHealthy === 'boolean' ? detectedHostRuntime.apiServerHealthy : undefined,
    gatewayServiceInstalled: typeof detectedHostRuntime.gatewayServiceInstalled === 'boolean' ? detectedHostRuntime.gatewayServiceInstalled : undefined,
    gatewayPid: detectedHostRuntime.gatewayPid ?? null,
    rpcHealthy: typeof detectedHostRuntime.rpcHealthy === 'boolean' ? detectedHostRuntime.rpcHealthy : undefined
  }
  if (detectedHostRuntime.gatewayService && typeof detectedHostRuntime.gatewayService === 'object') {
    summary.gatewayService = {
      installed: Boolean(detectedHostRuntime.gatewayService.installed),
      systemdUserUnit: clean(detectedHostRuntime.gatewayService.systemdUserUnit),
      systemdSystemUnit: clean(detectedHostRuntime.gatewayService.systemdSystemUnit),
      launchdPlist: clean(detectedHostRuntime.gatewayService.launchdPlist)
    }
  }
  if (detectedHostRuntime.apiServerProbe && typeof detectedHostRuntime.apiServerProbe === 'object') {
    summary.apiServerProbe = {
      ok: Boolean(detectedHostRuntime.apiServerProbe.ok),
      apiBase: clean(detectedHostRuntime.apiServerProbe.apiBase),
      reason: clean(detectedHostRuntime.apiServerProbe.reason),
      error: clean(detectedHostRuntime.apiServerProbe.error)
    }
  }
  if (detectedHostRuntime.candidates && typeof detectedHostRuntime.candidates === 'object') {
    summary.candidates = Object.fromEntries(
      Object.entries(detectedHostRuntime.candidates).map(([key, value]) => [key, summarizeHostRuntimeForOutput(value)])
    )
  }
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined && value !== '' && value !== null)
  )
}

function buildHostCoordinationSummary(detectedHostRuntime = null, gatewayHealthPayload = null) {
  const localGatewayHostRuntime = gatewayHealthPayload?.hostRuntime && typeof gatewayHealthPayload.hostRuntime === 'object'
    ? gatewayHealthPayload.hostRuntime
    : null
  const gatewayStartupChecks = gatewayHealthPayload?.startupChecks && typeof gatewayHealthPayload.startupChecks === 'object'
    ? gatewayHealthPayload.startupChecks
    : null
  const gatewayHostCheck = gatewayStartupChecks?.hostRuntime && typeof gatewayStartupChecks.hostRuntime === 'object'
    ? gatewayStartupChecks.hostRuntime
    : null
  return {
    detectedHostRuntime: summarizeHostRuntimeForOutput(detectedHostRuntime),
    detectedReady: hostRuntimeReady(detectedHostRuntime),
    gatewayObservedHostRuntime: localGatewayHostRuntime,
    gatewayObservedReady: Boolean(gatewayHostCheck?.ok),
    startupCheck: gatewayHostCheck
  }
}

function buildGatewayHealthGuidance({
  detectedHostRuntime = null,
  hostCoordination = null,
  gatewayStatus = null
} = {}) {
  const guidance = []
  if (!detectedHostRuntime?.detected) {
    guidance.push(`Install and configure a supported host runtime (${defaultSuggestedHostRuntime()}) before using AgentSquared.`)
  } else if (!hostCoordination?.detectedReady) {
    if (clean(detectedHostRuntime?.resolved) === 'hermes') {
      guidance.push('Hermes is installed but not ready yet. Ensure Hermes gateway is running and the API server is healthy, then retry.')
    } else if (clean(detectedHostRuntime?.resolved) === 'openclaw') {
      guidance.push('OpenClaw is installed but not ready yet. Ensure the OpenClaw gateway is running and reachable, then retry.')
    }
  }
  if (!gatewayStatus?.discovered) {
    guidance.push('No local AgentSquared gateway state was discovered. Start the AgentSquared gateway with `a2-cli gateway --agent-id <fullName> --key-file <runtime-key-file>` to enable relay-backed messaging.')
  } else if (gatewayStatus?.running && !gatewayStatus?.healthy) {
    guidance.push('The local AgentSquared gateway process is running but not healthy. Restart it with `a2-cli gateway restart --agent-id <fullName> --key-file <runtime-key-file>`.')
  } else if (gatewayStatus?.discovered && !gatewayStatus?.running) {
    guidance.push('A local AgentSquared gateway profile exists, but the gateway is not running. Start it with `a2-cli gateway --agent-id <fullName> --key-file <runtime-key-file>`.')
  }
  return guidance
}

async function pushCliOwnerReport({
  agentId,
  keyFile,
  args,
  gatewayBase = '',
  targetAgentId,
  selectedSkill,
  ownerReport,
  deliveryId = '',
  forceOwnerDelivery = false,
  waitForOwnerDelivery = false
} = {}) {
  const resolvedGatewayBase = clean(gatewayBase)
  const finalOwnerReport = {
    ...(ownerReport ?? {}),
    final: true,
    finalize: true
  }
  if (resolvedGatewayBase) {
    try {
      const response = await gatewayOwnerNotification(resolvedGatewayBase, {
        deliveryId: clean(deliveryId) || randomRequestId('sender-owner-report'),
        agentId,
        keyFile,
        remoteAgentId: targetAgentId,
        targetAgentId,
        selectedSkill,
        forceOwnerDelivery: Boolean(forceOwnerDelivery),
        waitForOwnerDelivery: Boolean(waitForOwnerDelivery),
        ownerReport: {
          ...finalOwnerReport,
          deliveryId: clean(deliveryId) || finalOwnerReport?.deliveryId,
          dedupeKey: clean(finalOwnerReport?.dedupeKey) || clean(deliveryId),
          forceOwnerDelivery: Boolean(forceOwnerDelivery || finalOwnerReport?.forceOwnerDelivery),
          waitForOwnerDelivery: Boolean(waitForOwnerDelivery || finalOwnerReport?.waitForOwnerDelivery)
        }
      }, {
        timeoutMs: waitForOwnerDelivery ? 60000 : 3000,
        fallbackOnNetworkError: false
      })
      const gatewayDelivered = waitForOwnerDelivery
        ? Boolean(response?.deliveredToOwner || response?.ownerDelivery?.delivered)
        : true
      return {
        delivered: gatewayDelivered,
        attempted: false,
        mode: 'agentsquared-gateway',
        status: response?.status || (gatewayDelivered ? 'sent' : 'failed'),
        reason: gatewayDelivered ? 'owner-notification-delivered' : clean(response?.ownerDelivery?.reason) || 'owner-notification-not-delivered',
        entryId: response?.entryId ?? '',
        totalCount: response?.totalCount ?? 0,
        ownerNotification: response?.ownerNotification ?? (gatewayDelivered ? 'sent' : 'failed'),
        ownerDelivery: response?.ownerDelivery ?? null
      }
    } catch (error) {
      return {
        delivered: false,
        attempted: true,
        mode: 'agentsquared-gateway',
        status: 'failed',
        reason: clean(error?.message) || 'owner-notification-api-failed'
      }
    }
  }
  try {
    const hostContext = await resolveCliHostContext({
      agentId,
      keyFile,
      args,
      purpose: 'AgentSquared owner report delivery'
    })
    const hostAdapter = createHostRuntimeAdapter({
      hostRuntime: hostContext.resolvedHostRuntime,
      localAgentId: agentId,
      openclaw: {
        stateDir: hostContext.openclawStateDir,
        openclawAgent: hostContext.resolvedOpenClawAgent,
        command: hostContext.openclawCommand,
        cwd: hostContext.openclawCwd,
        configPath: hostContext.openclawConfigPath,
        sessionPrefix: hostContext.openclawSessionPrefix,
        timeoutMs: 30000,
        gatewayUrl: hostContext.openclawGatewayUrl,
        gatewayToken: hostContext.openclawGatewayToken,
        gatewayPassword: hostContext.openclawGatewayPassword
      },
      hermes: {
        command: hostContext.hermesCommand,
        hermesHome: hostContext.hermesHome,
        hermesProfile: hostContext.hermesProfile,
        apiBase: hostContext.hermesApiBase,
        timeoutMs: hostContext.hermesTimeoutMs
      }
    })
    if (!hostAdapter?.pushOwnerReport) {
      return { delivered: false, attempted: false, mode: hostContext.resolvedHostRuntime, reason: 'host-adapter-missing-push-owner-report' }
    }
    return await hostAdapter.pushOwnerReport({
      item: {
        inboundId: clean(deliveryId) || randomRequestId('sender-owner-report'),
        remoteAgentId: targetAgentId
      },
      selectedSkill,
      ownerReport: finalOwnerReport
    })
  } catch (error) {
    return {
      delivered: false,
      attempted: true,
      mode: 'host',
      reason: clean(error?.message) || 'owner-report-delivery-failed'
    }
  }
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)))
}

function walkLocalFiles(dirPath, out, depth = 0, maxDepth = 4) {
  if (!dirPath || !fs.existsSync(dirPath) || depth > maxDepth) {
    return
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue
      }
      walkLocalFiles(entryPath, out, depth + 1, maxDepth)
      continue
    }
    if (entry.isFile()) {
      out.push(entryPath)
    }
  }
}

function loadSharedSkillFile(skillFile) {
  const resolved = resolveUserPath(skillFile)
  const text = fs.readFileSync(resolved, 'utf8')
  const policy = parseSkillDocumentPolicy(text, {
    fallbackName: path.basename(path.dirname(resolved)) || path.basename(resolved, path.extname(resolved))
  })
  return {
    path: resolved,
    name: policy.name,
    maxTurns: policy.maxTurns,
    conversationPolicy: {
      maxTurns: policy.maxTurns
    },
    document: clean(text).slice(0, 16000)
  }
}

function reportMissingFriendWorkflow({
  explicitSkillName = '',
  skillFile = ''
} = {}) {
  const missing = []
  if (!clean(explicitSkillName)) {
    missing.push('--skill-name')
  }
  if (!clean(skillFile)) {
    missing.push('--skill-file')
  }
  printJson({
    ok: false,
    error: {
      code: 'shared-workflow-required',
      message: `AgentSquared friend messaging requires ${missing.join(' and ')} from the upper skill layer.`,
      detail: 'Do not send a bare a2-cli friend msg. Read the installed AgentSquared root skill, choose the correct shared workflow, then retry with both --skill-name and an absolute --skill-file path.'
    },
    ownerNotification: 'not-sent',
    ownerFacingMode: 'internal-retry',
    ownerFacingInstruction: 'Do not report this internal CLI failure to the owner yet. Read the AgentSquared skill, select the correct shared workflow, and retry the same owner request with both --skill-name and --skill-file.',
    stdoutLines: []
  })
  process.exitCode = 1
}

function reportMismatchedFriendWorkflow({
  explicitSkillName = '',
  sharedSkillName = '',
  skillFile = ''
} = {}) {
  printJson({
    ok: false,
    error: {
      code: 'shared-workflow-mismatch',
      message: `AgentSquared workflow mismatch: --skill-name "${clean(explicitSkillName)}" does not match --skill-file frontmatter name "${clean(sharedSkillName)}".`,
      detail: `Use the shared workflow name declared by ${clean(skillFile) || 'the skill file'}, or pass the matching workflow file.`
    },
    ownerNotification: 'not-sent',
    ownerFacingMode: 'internal-retry',
    ownerFacingInstruction: 'Do not report this internal CLI failure to the owner yet. Retry with a matching --skill-name and --skill-file from the AgentSquared skill checkout.',
    stdoutLines: []
  })
  process.exitCode = 1
}

function buildFriendMessageWorkerArgv(args = {}) {
  const argv = ['friend', 'msg']
  for (const [key, value] of Object.entries(args)) {
    if (key === '_' || key === 'background-worker' || key === 'friend-msg-sync') {
      continue
    }
    const normalizedValue = clean(value)
    if (!normalizedValue) {
      continue
    }
    argv.push(`--${key}`)
    if (normalizedValue !== 'true') {
      argv.push(normalizedValue)
    }
  }
  argv.push('--background-worker', 'true')
  return argv
}

function spawnFriendMessageWorker(args = {}) {
  const worker = spawn(process.execPath, [path.join(ROOT, 'a2_cli.mjs'), ...buildFriendMessageWorkerArgv(args)], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore'
  })
  worker.unref()
  return worker
}

function extractPeerResponseMetadata(response = null) {
  const target = response?.result && typeof response.result === 'object'
    ? response.result
    : response
  return target?.metadata && typeof target.metadata === 'object'
    ? target.metadata
    : {}
}

function resolveOutboundConversationPolicy(sharedSkill = null) {
  return {
    maxTurns: resolveConversationMaxTurns({
      conversationPolicy: sharedSkill?.conversationPolicy ?? { maxTurns: sharedSkill?.maxTurns },
      sharedSkill,
      fallback: 1
    })
  }
}

async function resolveCliHostContext({
  agentId,
  keyFile,
  args,
  purpose = 'AgentSquared local runtime execution'
}) {
  const hostOptions = buildCliHostOptions(args)
  const detectedHostRuntime = await detectHostRuntimeEnvironment({
    preferred: hostOptions.preferredHostRuntime,
    openclaw: hostOptions.openclaw,
    hermes: hostOptions.hermes
  })
  const resolvedHostRuntime = detectedHostRuntime.resolved || 'none'
  if (!detectedHostRuntime.detected || !SUPPORTED_HOST_RUNTIMES.includes(resolvedHostRuntime)) {
    const detected = detectedHostRuntime.resolved || detectedHostRuntime.id || 'none'
    const reason = clean(detectedHostRuntime.reason)
    throw new Error(
      `${clean(purpose) || 'AgentSquared local runtime execution'} requires a supported local host runtime (${defaultSuggestedHostRuntime()}). Detected host runtime: ${detected}.${reason ? ` Detection reason: ${reason}.` : ''}`
    )
  }
  const detectedOpenClawAgent = clean(resolveOpenClawAgentSelection(detectedHostRuntime).defaultAgentId)
  const resolvedOpenClawAgent = clean(args['openclaw-agent']) || detectedOpenClawAgent
  if (resolvedHostRuntime === 'openclaw' && !resolvedOpenClawAgent) {
    throw new Error(`OpenClaw was detected for ${clean(purpose).toLowerCase() || 'local runtime execution'}, but no OpenClaw agent id could be resolved.`)
  }
  return {
    detectedHostRuntime,
    resolvedHostRuntime,
    resolvedOpenClawAgent,
    openclawCommand: hostOptions.openclaw.command,
    openclawCwd: hostOptions.openclaw.cwd,
    openclawConfigPath: hostOptions.openclaw.configPath,
    openclawGatewayUrl: hostOptions.openclaw.gatewayUrl,
    openclawGatewayToken: hostOptions.openclaw.gatewayToken,
    openclawGatewayPassword: hostOptions.openclaw.gatewayPassword,
    openclawSessionPrefix: hostOptions.openclaw.sessionPrefix,
    openclawTimeoutMs: hostOptions.openclaw.timeoutMs,
    openclawStateDir: defaultOpenClawStateDir(keyFile, agentId),
    hermesCommand: hostOptions.hermes.command,
    hermesHome: clean(detectedHostRuntime.hermesHome) || hostOptions.hermes.hermesHome,
    hermesProfile: clean(detectedHostRuntime.hermesProfile) || hostOptions.hermes.hermesProfile,
    hermesApiBase: clean(detectedHostRuntime.apiBase) || hostOptions.hermes.apiBase,
    hermesTimeoutMs: hostOptions.hermes.timeoutMs,
    agentId
  }
}

async function createCliLocalRuntimeExecutor({
  agentId,
  keyFile,
  args
}) {
  const hostContext = await resolveCliHostContext({
    agentId,
    keyFile,
    args,
    purpose: 'local multi-turn execution'
  })
  return createLocalRuntimeExecutor({
    agentId,
    mode: 'host',
    hostRuntime: hostContext.resolvedHostRuntime,
    conversationStore: createLiveConversationStore(),
    openclawStateDir: hostContext.openclawStateDir,
    openclawCommand: hostContext.openclawCommand,
    openclawCwd: hostContext.openclawCwd,
    openclawConfigPath: hostContext.openclawConfigPath,
    openclawAgent: hostContext.resolvedOpenClawAgent,
    openclawSessionPrefix: hostContext.openclawSessionPrefix,
    openclawTimeoutMs: hostContext.openclawTimeoutMs,
    openclawGatewayUrl: hostContext.openclawGatewayUrl,
    openclawGatewayToken: hostContext.openclawGatewayToken,
    openclawGatewayPassword: hostContext.openclawGatewayPassword,
    hermesCommand: hostContext.hermesCommand,
    hermesHome: hostContext.hermesHome,
    hermesProfile: hostContext.hermesProfile,
    hermesApiBase: hostContext.hermesApiBase,
    hermesTimeoutMs: hostContext.hermesTimeoutMs
  })
}

async function resolveCliOwnerRouteSnapshot({
  agentId,
  keyFile,
  args
} = {}) {
  try {
    const hostContext = await resolveCliHostContext({
      agentId,
      keyFile,
      args,
      purpose: 'AgentSquared owner route snapshot'
    })
    if (hostContext.resolvedHostRuntime !== 'hermes') {
      return null
    }
    const route = resolveHermesOwnerTarget(hostContext.hermesHome, {
      command: hostContext.hermesCommand
    })
    if (!clean(route?.target)) {
      return null
    }
    return {
      ownerRoute: clean(route.target),
      ownerRouteSource: clean(route.source),
      ownerRouteSessionId: clean(route.sessionId),
      ownerRouteTargetSource: clean(route.targetSource),
      ownerRouteSessionSource: clean(route.sessionSource)
    }
  } catch {
    return null
  }
}

async function executeLocalConversationTurn({
  localRuntimeExecutor,
  localAgentId,
  targetAgentId,
  peerSessionId,
  conversationKey,
  skillHint,
  sharedSkill,
  conversationPolicy,
  inboundText,
  originalOwnerText = '',
  localSkillInventory = '',
  turnIndex,
  remoteControl = null
}) {
  const normalizedRemoteControl = normalizeConversationControl(remoteControl ?? {}, {
    defaultTurnIndex: Math.max(1, Number.parseInt(`${turnIndex ?? 1}`, 10) - 1),
    defaultDecision: 'done',
    defaultStopReason: ''
  })
  const item = {
    inboundId: `local-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    remoteAgentId: targetAgentId,
    peerSessionId,
    suggestedSkill: skillHint,
    defaultSkill: clean(skillHint),
    request: {
      id: `local-turn-${turnIndex}`,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          role: 'agent',
          parts: [{ kind: 'text', text: clean(inboundText) }]
        },
        metadata: {
          ...(sharedSkill ? { sharedSkill } : {}),
          ...(conversationPolicy ? { conversationPolicy } : {}),
          from: targetAgentId,
          to: localAgentId,
          originalOwnerText: clean(originalOwnerText) || clean(inboundText),
          ...(clean(localSkillInventory) ? { localSkillInventory: clean(localSkillInventory) } : {}),
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

function receiptFileFor(keyFile, fullName) {
  return defaultReceiptFile(keyFile, fullName)
}

function onboardingSummaryFileFor(keyFile, fullName) {
  return defaultOnboardingSummaryFile(keyFile, fullName)
}

function gatewayLogFileFor(keyFile, fullName) {
  return defaultGatewayLogFile(keyFile, fullName)
}

function writeJson(filePath, payload) {
  const resolved = resolveUserPath(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  return resolved
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(resolveUserPath(filePath), 'utf8'))
}

function archiveGatewayStateFile(gatewayStateFile, reason = 'stale') {
  const resolved = clean(gatewayStateFile) ? resolveUserPath(gatewayStateFile) : ''
  if (!resolved || !fs.existsSync(resolved)) {
    return ''
  }
  const archived = `${resolved}.${clean(reason) || 'archived'}.${Date.now()}.bak`
  fs.renameSync(resolved, archived)
  return archived
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

function parsePid(value) {
  const numeric = Number.parseInt(`${value ?? ''}`, 10)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function boolFlag(value, fallback = false) {
  const normalized = clean(value).toLowerCase()
  if (!normalized) {
    return fallback
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false
  }
  return fallback
}

function classifyGatewayFailure(error = '', hostRuntime = null) {
  const message = clean(error)
  const lower = message.toLowerCase()
  if (!message) {
    return {
      code: 'gateway-startup-failed',
      retryable: true,
      guidance: [
        'Retry after updating @agentsquared/cli and restarting the local AgentSquared gateway.',
        'If the relay or host runtime still looks unstable, retry later.',
        'If the problem persists, open an issue in the official AgentSquared CLI repository.'
      ]
    }
  }
  if (lower.includes('host runtime preflight failed') || lower.includes('openclaw') || lower.includes('hermes') || lower.includes('pairing') || lower.includes('loopback')) {
    return {
      code: 'adapter-startup-failed',
      retryable: true,
      guidance: [
        `The ${clean(hostRuntime?.resolved) || 'host'} adapter could not be reached during gateway startup.`,
        'Update @agentsquared/cli and restart the local AgentSquared gateway.',
        'If the local host runtime is unstable, retry later.',
        'If the adapter still fails, report it to the official AgentSquared CLI issue tracker.'
      ]
    }
  }
  if (lower.includes('relay') || lower.includes('reservation') || lower.includes('presence') || lower.includes('too many requests') || lower.includes('429')) {
    return {
      code: 'relay-startup-failed',
      retryable: true,
      guidance: [
        'The AgentSquared relay path was not healthy enough during gateway startup.',
        'Retry after updating @agentsquared/cli or wait and retry later if the remote service looks unstable.',
        'If relay startup keeps failing, report it to the official AgentSquared CLI issue tracker.'
      ]
    }
  }
  return {
    code: 'gateway-startup-failed',
    retryable: true,
    guidance: [
      'Retry after updating @agentsquared/cli and restarting the local AgentSquared gateway.',
      'If the problem persists, retry later or report it to the official AgentSquared CLI issue tracker.'
    ]
  }
}

function describeDetectedHostRuntime(detectedHostRuntime = null) {
  const resolved = clean(detectedHostRuntime?.resolved)
  if (resolved && resolved !== 'none') {
    return resolved
  }
  const requested = clean(detectedHostRuntime?.requested)
  if (requested && requested !== 'auto') {
    return requested
  }
  return clean(detectedHostRuntime?.id) || 'unknown'
}

function assertSupportedActivationHostRuntime(detectedHostRuntime = null) {
  if (Boolean(detectedHostRuntime?.detected) && SUPPORTED_HOST_RUNTIMES.includes(clean(detectedHostRuntime?.resolved))) {
    return
  }
  const detected = describeDetectedHostRuntime(detectedHostRuntime)
  const reason = clean(detectedHostRuntime?.reason)
  const suggested = clean(detectedHostRuntime?.suggested) || defaultSuggestedHostRuntime()
  const detail = reason ? ` Detection reason: ${reason}.` : ''
  throw new Error(
    `AgentSquared activation requires a supported host runtime (${defaultSuggestedHostRuntime()}). Detected host runtime: ${detected}.${detail} Finish installing/configuring a supported host runtime first, then retry onboarding. Suggested host runtime: ${suggested}.`
  )
}

function isFlagToken(value) {
  return clean(value).startsWith('-')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  if (failureKind === 'post-dispatch-empty-response') {
    return {
      code: 'post-dispatch-empty-response',
      deliveryStatus: 'unknown',
      failureStage: 'post-dispatch / final-response-empty',
      confirmationLevel: 'remote may have received and processed the turn',
      reason: `${clean(targetAgentId) || 'The target agent'} may have received this AgentSquared turn, but the final response stream ended with no JSON payload after dispatch.`,
      nextStep: 'Do not automatically retry this same message. Tell the owner the remote side may have processed the turn, but the final response came back empty. Ask whether they want to check for a later reply or retry later.'
    }
  }
  if (failureKind === 'post-dispatch-stream-closed') {
    return {
      code: 'post-dispatch-stream-closed',
      deliveryStatus: 'unknown',
      failureStage: 'post-dispatch / response-stream-closed',
      confirmationLevel: 'remote may have received and processed the turn',
      reason: `${clean(targetAgentId) || 'The target agent'} may have received this AgentSquared turn, but the response stream closed before the final reply could be confirmed locally.`,
      nextStep: 'Do not automatically retry this same message. Tell the owner the remote side may have processed the turn, but the connection closed during response confirmation. Ask whether they want to check for a later reply or retry later.'
    }
  }
  if (failureKind === 'post-dispatch-response-timeout') {
    return {
      code: 'post-dispatch-response-timeout',
      deliveryStatus: 'unknown',
      failureStage: 'post-dispatch / final-response-timeout',
      confirmationLevel: 'remote accepted the turn but did not finish in time',
      reason: `${clean(targetAgentId) || 'The target agent'} accepted this AgentSquared turn, but the final response timed out after dispatch.`,
      nextStep: 'Do not automatically resend the same turn. Tell the owner the remote side accepted the turn but did not finish responding in time, then ask whether they want to wait for a later reply or retry later.'
    }
  }
  if (lower.includes('request receipt timed out after')) {
    return {
      code: 'turn-receipt-timeout',
      deliveryStatus: 'unconfirmed',
      failureStage: 'awaiting-request-receipt',
      confirmationLevel: 'receipt was never confirmed',
      reason: `${clean(targetAgentId) || 'The target agent'} did not confirm receipt of this AgentSquared turn within 20 seconds, so delivery for this turn could not be confirmed.`,
      nextStep: 'Do not continue the conversation automatically. Tell the owner this specific turn did not receive a delivery receipt in time, then ask whether they want to retry later.'
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
      nextStep: 'Do not switch to another target automatically. Stop here and tell the owner the target AgentSquared peer path is currently unreachable. The owner can retry this same target later.'
    }
  }
  if (lower.includes('turn response timed out after')) {
    return {
      code: 'turn-response-timeout',
      deliveryStatus: 'unknown',
      failureStage: 'post-receipt / final-response-timeout',
      confirmationLevel: 'remote acknowledged the turn but final response timed out',
      reason: `${clean(targetAgentId) || 'The target agent'} accepted this AgentSquared turn, but did not return a final response before the per-turn response timeout.`,
      nextStep: 'Do not automatically resend the same turn. Tell the owner the remote side acknowledged the turn but did not finish responding in time, then ask whether they want to wait for a later reply or retry later.'
    }
  }
  if (error?.code === 'A2_HTTP_TIMEOUT' || lower.includes('http request timed out after')) {
    return {
      code: 'local-gateway-response-timeout',
      deliveryStatus: 'unknown',
      failureStage: 'local-gateway / response-timeout',
      confirmationLevel: 'the remote agent may already have received and processed the message',
      reason: `${clean(targetAgentId) || 'The target agent'} did not return a confirmed AgentSquared result before the local command timeout. The message may already have been delivered.`,
      nextStep: 'Do not automatically resend the same message. Tell the owner it may have been delivered, then ask whether they want to wait, check for a later reply, or explicitly retry.'
    }
  }
  if (failureKind === 'remote-runtime-error' || lower.includes('openclaw runtime failed') || lower.includes('local runtime rejected')) {
    return {
      code: 'target-runtime-unavailable',
      deliveryStatus: 'failed',
      failureStage: 'remote-runtime-error',
      confirmationLevel: 'target gateway was reached and returned a runtime error',
      reason: message || `${clean(targetAgentId) || 'The target agent'} could not run its local host runtime for this turn.`,
      nextStep: 'Do not automatically retry this same message. Tell the owner the target agent runtime needs to be fixed or restarted before retrying.'
    }
  }
  if (lower.includes('delivery status is unknown after the request was dispatched')) {
    return {
      code: 'delivery-status-unknown',
      deliveryStatus: 'unknown',
      failureStage: 'post-dispatch / response-unconfirmed',
      confirmationLevel: 'remote may already have processed the message',
      reason: `${clean(targetAgentId) || 'The target agent'} may already have received and processed this AgentSquared message, but the response could not be confirmed locally.`,
      nextStep: 'Do not automatically retry this same message. First tell the owner that delivery status is unknown and ask whether they want to check for a reply or retry later.'
    }
  }
  if (lower.includes('no local agent runtime adapter is configured')) {
    return {
      code: 'target-runtime-unavailable',
      deliveryStatus: 'failed',
      failureStage: 'remote-runtime-unavailable',
      confirmationLevel: 'target gateway was reachable but had no usable runtime',
      reason: `${clean(targetAgentId) || 'The target agent'} is online in AgentSquared, but its local host runtime is not attached correctly right now. The target gateway appears to be running without a supported inbound runtime adapter.`,
      nextStep: 'Do not switch to another target automatically. Stop here and tell the owner the target Agent must restart its AgentSquared gateway after fixing or re-detecting the supported host runtime.'
    }
  }
  if (lower.includes('peer identity') || lower.includes('not visible in friend directory')) {
    return {
      code: 'target-unreachable',
      deliveryStatus: 'failed',
      failureStage: 'pre-dispatch / target-unreachable',
      confirmationLevel: 'relay could not provide a usable live target',
      reason: `${clean(targetAgentId) || 'The target agent'} is not currently reachable through AgentSquared. Relay did not provide a usable live peer identity for this target.`,
      nextStep: 'Do not switch to another target automatically. Stop here and tell the owner this exact target is offline or unavailable. The owner can retry this same target later.'
    }
  }
  if (lower.includes('missing dialaddrs')) {
    return {
      code: 'target-unreachable',
      deliveryStatus: 'failed',
      failureStage: 'pre-dispatch / target-address-missing',
      confirmationLevel: 'target did not expose usable dial addresses',
      reason: `${clean(targetAgentId) || 'The target agent'} does not currently expose any dialable AgentSquared transport addresses. The target may be offline, reconnecting, or missing fresh relay-backed transport publication.`,
      nextStep: 'Do not switch to another target automatically. Stop here and tell the owner this exact target is not currently reachable. The owner can retry the same target later.'
    }
  }
  if (lower.includes('gateway transport is unavailable') || lower.includes('recovering') || lower.includes('429') || lower.includes('too many requests') || lower.includes('relay') || lower.includes('fetch failed')) {
    return {
      code: 'relay-or-gateway-unavailable',
      deliveryStatus: 'failed',
      failureStage: 'pre-dispatch / local-or-relay-path-unavailable',
      confirmationLevel: 'delivery path was unstable before confirmation',
      reason: message || 'The local AgentSquared gateway or relay path was not healthy enough to deliver this message.',
      nextStep: 'Do not switch to another target automatically. Stop here and tell the owner this delivery failed because the current AgentSquared path is unstable. The owner can retry the same target later.'
    }
  }
  return {
    code: 'delivery-failed',
    deliveryStatus: 'failed',
    failureStage: 'unknown',
    confirmationLevel: 'delivery could not be completed or confirmed',
    reason: message || 'The AgentSquared message could not be delivered.',
    nextStep: 'Do not switch to another target automatically. Stop here and ask the owner whether they want to retry this same target later.'
  }
}

function extractFailureDetail(error = null) {
  const raw = describeErrorForOutput(error)
  if (!raw) {
    return ''
  }
  return raw.replace(/^delivery status is unknown after the request was dispatched:\s*/i, '').trim()
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


async function registerAgent(args) {
  const apiBase = clean(args['api-base']) || 'https://api.agentsquared.net'
  const authorizationToken = requireArg(args['authorization-token'], '--authorization-token is required')
  const agentName = requireArg(args['agent-name'], '--agent-name is required')
  const keyTypeName = clean(args['key-type']) || 'ed25519'
  const displayName = clean(args['display-name']) || agentName
  const detectedHostRuntime = args.__detectedHostRuntime ?? null
  const keyFile = resolveUserPath(args['key-file'] || defaultRuntimeKeyFile(agentName, args, detectedHostRuntime))
  const keyBundle = generateRuntimeKeyBundle(keyTypeName)
  writeRuntimeKeyBundle(keyFile, keyBundle)

  const response = await fetch(`${apiBase.replace(/\/$/, '')}/api/onboard/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      authorizationToken,
      agentName,
      keyType: keyBundle.keyType,
      publicKey: keyBundle.publicKey,
      displayName
    })
  })
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Agent registration failed with status ${response.status}`)
  }
  const result = payload?.value ?? payload
  const receiptFile = receiptFileFor(keyFile, result.fullName || `${agentName}@unknown`)
  writeJson(receiptFile, result)
  return {
    apiBase,
    keyFile,
    keyBundle,
    receiptFile,
    result
  }
}

async function commandOnboard(args) {
  const authorizationToken = clean(args['authorization-token'])
  assertNoExistingLocalActivation(authorizationToken)
  const hostOptions = buildCliHostOptions(args)
  const detectedHostRuntime = await detectHostRuntimeEnvironment({
    preferred: hostOptions.preferredHostRuntime,
    openclaw: hostOptions.openclaw,
    hermes: hostOptions.hermes
  })
  assertSupportedActivationHostRuntime(detectedHostRuntime)
  if (!authorizationToken) {
    throw new Error('--authorization-token is required for first-time onboarding.')
  }
  const registration = await registerAgent({
    ...args,
    __detectedHostRuntime: detectedHostRuntime
  })
  const fullName = registration.result.fullName
  const gatewayStateFile = clean(args['gateway-state-file']) || defaultGatewayStateFile(registration.keyFile, fullName)
  const previousGatewayState = readGatewayState(gatewayStateFile)
  const shouldStartGateway = boolFlag(args['start-gateway'], true)
  let gateway = {
    started: false,
    launchRequested: false,
    pending: false,
    gatewayBase: '',
    health: null,
    error: '',
    logFile: '',
    pid: null
  }

  if (shouldStartGateway) {
    gateway.launchRequested = true
    const gatewayArgs = buildGatewayArgs(args, fullName, registration.keyFile, detectedHostRuntime)
    const existingGateway = await inspectExistingGateway({
      keyFile: registration.keyFile,
      agentId: fullName,
      gatewayStateFile: clean(args['gateway-state-file'])
    })
    if (existingGateway.running && !existingGateway.revisionMatches) {
      gateway = {
        started: false,
        launchRequested: true,
        pending: false,
        gatewayBase: existingGateway.gatewayBase,
        health: existingGateway.health,
        error: 'An existing AgentSquared gateway process is running from an older @agentsquared/cli revision. Use `a2-cli gateway restart ...` before onboarding tries to reuse it.',
        logFile: gatewayLogFileFor(registration.keyFile, fullName),
        pid: existingGateway.pid
      }
    } else if (existingGateway.running && existingGateway.healthy) {
      gateway = {
        started: true,
        launchRequested: true,
        pending: false,
        gatewayBase: existingGateway.gatewayBase,
        health: existingGateway.health,
        error: '',
        logFile: gatewayLogFileFor(registration.keyFile, fullName),
        pid: existingGateway.pid
      }
	    } else if (existingGateway.running) {
	      gateway = {
        started: false,
        launchRequested: true,
        pending: true,
        gatewayBase: existingGateway.gatewayBase,
        health: existingGateway.health,
        error: 'An existing AgentSquared gateway process is already running but is not healthy yet. Use `a2-cli gateway restart ...` instead of starting another one.',
        logFile: gatewayLogFileFor(registration.keyFile, fullName),
	        pid: existingGateway.pid
	      }
	    } else {
	      let archivedGatewayStateFile = ''
	      if (existingGateway.stateFile && existingGateway.state) {
	        const staleState = !existingGateway.revisionMatches || !clean(existingGateway.state?.gatewayBase)
	        if (staleState) {
	          archivedGatewayStateFile = archiveGatewayStateFile(existingGateway.stateFile, 'restart-required')
	        }
	      }
	      const gatewayLogFile = gatewayLogFileFor(registration.keyFile, fullName)
      fs.mkdirSync(path.dirname(gatewayLogFile), { recursive: true })
      const stdoutFd = fs.openSync(gatewayLogFile, 'a')
      const stderrFd = fs.openSync(gatewayLogFile, 'a')
      const child = spawn(process.execPath, [path.join(ROOT, 'a2_cli.mjs'), 'gateway', ...gatewayArgs], {
        detached: true,
        cwd: ROOT,
        stdio: ['ignore', stdoutFd, stderrFd]
      })
      fs.closeSync(stdoutFd)
      fs.closeSync(stderrFd)
      child.unref()
      gateway.logFile = gatewayLogFile
      gateway.pid = child.pid ?? null
      try {
        const ready = await waitForGatewayReady({
          keyFile: registration.keyFile,
          agentId: fullName,
          gatewayStateFile: clean(args['gateway-state-file']),
          timeoutMs: Number.parseInt(args['gateway-wait-ms'] ?? '90000', 10) || 90000
        })
	        gateway = {
	          started: true,
	          launchRequested: true,
	          pending: false,
	          gatewayBase: ready.gatewayBase,
	          health: ready.health,
	          error: '',
	          logFile: gatewayLogFile,
	          pid: child.pid ?? null,
	          archivedGatewayStateFile
	        }
	      } catch (error) {
        const gatewayState = readGatewayState(gatewayStateFile)
        const discoveredPid = gatewayState?.gatewayPid ?? child.pid ?? null
        const discoveredBase = clean(gatewayState?.gatewayBase)
        const failure = classifyGatewayFailure(error.message, detectedHostRuntime)
	        gateway.pending = pidExists(discoveredPid)
	        gateway.gatewayBase = discoveredBase
	        gateway.pid = parsePid(discoveredPid)
	        gateway.error = error.message
	        gateway.failure = failure
	        gateway.archivedGatewayStateFile = archivedGatewayStateFile
	      }
	    }
  }

  const agentsquaredDir = path.dirname(resolveUserPath(registration.keyFile))
  const inboxDir = defaultInboxDir(registration.keyFile, fullName)
  const onboardingSummaryFile = onboardingSummaryFileFor(registration.keyFile, fullName)
  const standardReport = buildStandardRuntimeReport({
    apiBase: registration.apiBase,
    agentId: fullName,
    keyFile: registration.keyFile,
    detectedHostRuntime,
    registration: registration.result,
    gateway,
    gatewayHealth: gateway.health,
    previousState: previousGatewayState
  })
  const summary = {
    setupComplete: true,
    apiBase: registration.apiBase,
    agentsquaredDir,
    hostRuntime: detectedHostRuntime,
    receiptFile: registration.receiptFile,
    keyFile: registration.keyFile,
    inboxDir,
    memoryReminder: {
      required: true,
      instruction: 'Store the AgentSquared platform introduction, this local AgentSquared directory, the runtime key path, and the latest Runtime Status in the host runtime memory system.'
    },
    registration: registration.result,
    gateway,
    standardReport,
    ownerFacingLines: [
      'AgentSquared setup is complete.',
      `Agent: ${registration.result.fullName}`,
      `AgentSquared directory: ${agentsquaredDir}.`,
      `Host runtime: ${detectedHostRuntime.resolved !== 'none' ? detectedHostRuntime.resolved : `not bound (${detectedHostRuntime.suggested || defaultSuggestedHostRuntime()} suggested)`}.`,
      gateway.started
        ? `Gateway was auto-started and is running at ${gateway.gatewayBase}.`
        : gateway.pending
          ? `Gateway launch was requested and the background process is still running${gateway.gatewayBase ? ` at ${gateway.gatewayBase}` : ''}, but health was not confirmed before timeout.`
          : `Gateway auto-start is not confirmed${gateway.error ? `: ${gateway.error}` : '.'}`,
      gateway.logFile
        ? `Gateway log file: ${gateway.logFile}.`
        : 'Gateway log file: unavailable.',
      ...(gateway.failure?.guidance ?? []),
      'Store the AgentSquared platform intro, this AgentSquared directory, the runtime key path, and the latest Runtime Status in the host runtime memory system.',
      `Inbox audit path: ${inboxDir}.`,
      'AgentSquared, A², and A2 all mean the same platform.',
      'You can now ask this agent to check AgentSquared status, view friends, read inbox items, send trusted friend messages, and run shared friend workflows such as friend IM or mutual learning.',
      'CLI commands are internal runtime tools for the skill layer and do not need to be shown to the owner unless requested.',
      'Use live official reads for exact current friends, agent cards, and relay facts.',
      ...buildStandardRuntimeOwnerLines(standardReport)
    ]
  }
  summary.ownerFacingText = toOwnerFacingText(summary.ownerFacingLines)
  writeJson(onboardingSummaryFile, summary)
  printJson(summary)
}

async function commandGateway(args, rawArgs) {
  const existingGateway = await inspectExistingGateway({
    gatewayBase: args['gateway-base'],
    keyFile: args['key-file'],
    agentId: args['agent-id'],
    gatewayStateFile: args['gateway-state-file']
  })
  if (existingGateway.running && !existingGateway.revisionMatches) {
    throw new Error('An AgentSquared gateway process is already running from an older @agentsquared/cli revision. Use `a2-cli gateway restart --agent-id <fullName> --key-file <runtime-key-file>` instead of reusing it.')
  }
  if (existingGateway.running && existingGateway.healthy) {
    const standardReport = buildStandardRuntimeReport({
      apiBase: clean(args['api-base']) || 'https://api.agentsquared.net',
      agentId: clean(existingGateway.state?.agentId) || clean(args['agent-id']),
      keyFile: clean(existingGateway.state?.keyFile) || clean(args['key-file']),
      detectedHostRuntime: existingGateway.health?.hostRuntime ?? { resolved: resolvedHostRuntimeFromHealth(existingGateway.health) },
      gateway: {
        started: true,
        gatewayBase: existingGateway.gatewayBase,
        health: existingGateway.health
      },
      gatewayHealth: existingGateway.health,
      previousState: existingGateway.state
    })
    printJson({
      alreadyRunning: true,
      gatewayBase: existingGateway.gatewayBase,
      pid: existingGateway.pid,
      health: existingGateway.health,
      standardReport,
      ownerFacingLines: buildStandardRuntimeOwnerLines(standardReport),
      ownerFacingText: toOwnerFacingText(buildStandardRuntimeOwnerLines(standardReport))
    })
    return
  }
  if (existingGateway.running) {
    throw new Error('An AgentSquared gateway process is already running but is not healthy. Use `a2-cli gateway restart --agent-id <fullName> --key-file <runtime-key-file>` instead of starting another instance.')
  }
  await runGateway(rawArgs)
}

async function commandGatewayRestart(args, rawArgs) {
  const context = resolveAgentContext(args)
  const agentId = context.agentId
  const keyFile = context.keyFile
  const gatewayStateFile = clean(args['gateway-state-file']) || context.gatewayStateFile
  const priorState = readGatewayState(gatewayStateFile)
  const priorPid = parsePid(priorState?.gatewayPid)
  let archivedGatewayStateFile = ''
  const gatewayArgs = buildGatewayArgs(args, agentId, keyFile, null)
  const gatewayLogFile = gatewayLogFileFor(keyFile, agentId)

  if (priorPid) {
    try {
      process.kill(priorPid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error
      }
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try {
        process.kill(priorPid, 0)
        await sleep(250)
      } catch (error) {
        if (error?.code === 'ESRCH') {
          break
        }
        throw error
      }
    }
  }

  const priorStateRevision = clean(priorState?.runtimeRevision)
  const stalePriorState = priorState && (!priorStateRevision || priorStateRevision !== currentRuntimeRevision() || !clean(priorState?.gatewayBase))
  if (stalePriorState && !pidExists(priorPid)) {
    archivedGatewayStateFile = archiveGatewayStateFile(gatewayStateFile, 'restart-required')
  }

  fs.mkdirSync(path.dirname(gatewayLogFile), { recursive: true })
  const stdoutFd = fs.openSync(gatewayLogFile, 'a')
  const stderrFd = fs.openSync(gatewayLogFile, 'a')
  const child = spawn(process.execPath, [path.join(ROOT, 'a2_cli.mjs'), 'gateway', ...gatewayArgs], {
    detached: true,
    cwd: ROOT,
    stdio: ['ignore', stdoutFd, stderrFd]
  })
  fs.closeSync(stdoutFd)
  fs.closeSync(stderrFd)
  child.unref()

  let ready
  try {
    ready = await waitForGatewayReady({
      keyFile,
      agentId,
      gatewayStateFile,
      timeoutMs: Number.parseInt(args['gateway-wait-ms'] ?? '30000', 10) || 30000
    })
  } catch (error) {
    throw new Error(`${error.message} Check the gateway log at ${gatewayLogFile}.`)
  }

  const standardReport = buildStandardRuntimeReport({
    apiBase: clean(args['api-base']) || 'https://api.agentsquared.net',
    agentId,
    keyFile,
    detectedHostRuntime: ready.health?.hostRuntime ?? { resolved: resolvedHostRuntimeFromHealth(ready.health) },
    gateway: {
      started: true,
      gatewayBase: ready.gatewayBase,
      health: ready.health
    },
    gatewayHealth: ready.health,
    previousState: priorState
  })

  const ownerFacingLines = buildStandardRuntimeOwnerLines(standardReport)
  printJson({
    restarted: true,
    previousGatewayPid: priorPid,
    gatewayPid: child.pid ?? null,
    gatewayBase: ready.gatewayBase,
    health: ready.health,
    gatewayLogFile,
    archivedGatewayStateFile,
    agentsquaredDir: path.dirname(resolveUserPath(keyFile)),
    standardReport,
    ownerFacingLines,
    ownerFacingText: toOwnerFacingText(ownerFacingLines),
    memoryReminder: {
      required: true,
      instruction: 'Keep the AgentSquared platform introduction, this local AgentSquared directory, the runtime key path, and the latest Runtime Status in the host runtime memory system.'
    }
  })
}

async function commandGatewayHealth(args) {
  const hostOptions = buildCliHostOptions(args)
  const detectedHostRuntime = await detectHostRuntimeEnvironment({
    preferred: hostOptions.preferredHostRuntime,
    openclaw: hostOptions.openclaw,
    hermes: hostOptions.hermes
  })

  let context = null
  let contextError = ''
  try {
    context = resolveAgentContext(args)
  } catch (error) {
    contextError = clean(error?.message)
  }

  let gatewayStatus = {
    discovered: false,
    gatewayStateFile: clean(args['gateway-state-file']),
    gatewayBase: clean(args['gateway-base']),
    running: false,
    healthy: false,
    pid: null,
    revisionMatches: false,
    stateRevision: '',
    expectedRevision: currentRuntimeRevision(),
    state: null,
    health: null,
    error: contextError
  }

  if (context) {
    const existing = await inspectExistingGateway({
      gatewayBase: args['gateway-base'],
      keyFile: context.keyFile,
      agentId: context.agentId,
      gatewayStateFile: clean(args['gateway-state-file']) || context.gatewayStateFile
    })
    gatewayStatus = {
      discovered: Boolean(existing.state || existing.gatewayBase || existing.running),
      gatewayStateFile: existing.stateFile,
      gatewayBase: existing.gatewayBase,
      running: existing.running,
      healthy: existing.healthy,
      pid: existing.pid,
      revisionMatches: existing.revisionMatches,
      stateRevision: existing.stateRevision,
      expectedRevision: existing.expectedRevision,
      state: existing.state,
      health: existing.health,
      error: ''
    }
  }

  const hostCoordination = buildHostCoordinationSummary(detectedHostRuntime, gatewayStatus.health)
  const ready = Boolean(gatewayStatus.healthy && hostCoordination.detectedReady && (hostCoordination.gatewayObservedReady || !gatewayStatus.running))
  const guidance = buildGatewayHealthGuidance({
    detectedHostRuntime,
    hostCoordination,
    gatewayStatus
  })
  const standardReport = context
    ? buildStandardRuntimeReport({
        apiBase: clean(args['api-base']) || 'https://api.agentsquared.net',
        agentId: context.agentId,
        keyFile: context.keyFile,
        detectedHostRuntime,
        gateway: {
          started: gatewayStatus.running,
          gatewayBase: gatewayStatus.gatewayBase,
          health: gatewayStatus.health
        },
        gatewayHealth: gatewayStatus.health,
        previousState: gatewayStatus.state
      })
    : null
  const ownerFacingLines = standardReport
    ? buildStandardRuntimeOwnerLines(standardReport)
    : [
        'Runtime Status:',
        'A2 gateway: not healthy; no local AgentSquared profile context was resolved.',
        `Host runtime adapter: ${hostCoordination.detectedReady ? 'healthy' : 'not healthy'} (${clean(hostCoordination.detectedHostRuntime?.resolved) || 'none'}).`,
        'Official AgentSquared Relay: not checked because no local gateway context was resolved.'
      ]

  printJson({
    ready,
    contextResolved: Boolean(context),
    agentId: clean(context?.agentId),
    keyFile: clean(context?.keyFile),
    hostRuntime: hostCoordination,
    agentsquaredGateway: gatewayStatus,
    officialRelay: standardReport?.gatewayStatus?.relay ?? null,
    standardReport,
    ownerFacingLines,
    ownerFacingText: toOwnerFacingText(ownerFacingLines),
    guidance
  })
}

async function commandFriendList(args) {
  const ctx = await signedRelayContext(args)
  const directory = await getFriendDirectory(ctx.apiBase, ctx.agentId, ctx.bundle, ctx.transport)
  printJson({
    source: 'relay-friend-directory',
    apiBase: ctx.apiBase,
    agentId: ctx.agentId,
    gatewayBase: ctx.gatewayBase,
    usedGatewayTransport: Boolean(ctx.transport),
    directory
  })
}

async function commandFriendMessage(args) {
  const targetAgentId = agentSquaredAgentIdForWire(requireArg(args['target-agent'], '--target-agent is required'), { label: '--target-agent' })
  const text = requireArg(args.text, '--text is required')
  const ownerLanguage = inferOwnerFacingLanguage(text)
  const ownerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const skillFile = clean(args['skill-file'])
  const sharedSkill = skillFile ? loadSharedSkillFile(skillFile) : null
  const explicitSkillName = clean(args['skill-name'] || args.skill)
  if (!explicitSkillName || !skillFile || !sharedSkill?.name) {
    reportMissingFriendWorkflow({ explicitSkillName, skillFile })
    return
  }
  if (normalizeSharedSkillName(explicitSkillName) !== normalizeSharedSkillName(sharedSkill.name)) {
    reportMismatchedFriendWorkflow({
      explicitSkillName,
      sharedSkillName: sharedSkill.name,
      skillFile
    })
    return
  }
  const skillHint = clean(explicitSkillName) || clean(sharedSkill?.name)
  const skillDecision = {
    source: explicitSkillName ? 'explicit' : sharedSkill?.name ? 'shared-skill' : 'none',
    reason: explicitSkillName ? 'explicit-skill-arg' : sharedSkill?.name ? 'shared-skill-file' : 'no-skill-hint'
  }
  const conversationPolicy = resolveOutboundConversationPolicy(sharedSkill)
  const isBackgroundWorker = isTrueFlag(args['background-worker'])

  const gateway = await ensureGatewayForUse(args)
  const shouldUseGatewayJob = !isBackgroundWorker
    && !isTrueFlag(args['friend-msg-sync'])
    && conversationPolicy.maxTurns >= 1

  const context = {
    agentId: gateway.agentId,
    keyFile: gateway.keyFile,
    gatewayStateFile: gateway.gatewayStateFile
  }
  const gatewayBase = gateway.gatewayBase
  const conversationKey = randomRequestId('conversation')
  const sentAt = new Date().toISOString()
  const ownerNotificationDedupeKey = stableDedupeKey(['friend-msg', context.agentId, targetAgentId, skillHint, conversationKey, text])
  const ownerRouteSnapshot = shouldUseGatewayJob
    ? await resolveCliOwnerRouteSnapshot({
        agentId: context.agentId,
        keyFile: context.keyFile,
        args
      })
    : null
  const outboundText = buildSkillOutboundText({
    localAgentId: context.agentId,
    targetAgentId,
    skillName: skillHint,
    originalText: text,
    sentAt
  })

  if (shouldUseGatewayJob) {
    const accepted = await gatewayConnectJob(
      gatewayBase,
      {
        targetAgentId,
        skillHint,
        method: 'message/send',
        message: {
          kind: 'message',
          role: 'user',
          parts: [{ kind: 'text', text: outboundText }]
        },
        metadata: {
          ...(sharedSkill ? { sharedSkill } : {}),
          conversationPolicy,
          originalOwnerText: text,
          conversationKey,
          sentAt,
          turnIndex: 1,
          decision: 'continue',
          stopReason: '',
          final: false,
          finalize: false
        },
        activitySummary: 'Preparing an AgentSquared peer conversation.',
        report: {
          taskId: skillHint,
          summary: `Delivered AgentSquared conversation turn 1 to ${targetAgentId}.`,
          publicSummary: ''
        },
        ownerContext: {
          originalText: text,
          ownerLanguage,
          ownerTimeZone,
          dedupeKey: ownerNotificationDedupeKey,
          startedAt: sentAt,
          ...(ownerRouteSnapshot ?? {})
        }
      },
      {
        timeoutMs: 5000,
        fallbackOnNetworkError: false
      }
    )
    printJson({
      ok: true,
      status: accepted?.alreadyRunning ? 'already-running' : 'accepted',
      backgroundWorker: false,
      gatewayJob: true,
      jobId: accepted?.jobId ?? '',
      conversationKey: accepted?.conversationKey ?? conversationKey,
      conversationMode: 'gateway-job',
      ownerNotification: 'pending',
      ownerFacingMode: accepted?.alreadyRunning ? 'brief' : 'suppress',
      ownerFacingInstruction: accepted?.alreadyRunning
        ? 'Tell the owner only that an AgentSquared exchange is already running. Do not retry, check inbox, wait, or start another AgentSquared message. AgentSquared will push the final conversation result through the owner channel when it is ready.'
        : 'Do not send any owner-facing progress report. AgentSquared gateway accepted the multi-turn exchange and will push the final conversation result through the owner channel when it is ready.',
      ownerFacingText: accepted?.alreadyRunning
        ? 'An AgentSquared exchange is already running.'
        : '',
      ownerFacingLines: [accepted?.alreadyRunning
        ? 'An AgentSquared exchange is already running.'
        : ''].filter(Boolean),
      stdoutNoticeCode: '',
      stdoutLines: []
    })
    return
  }
  const requestedFriendMsgWaitMs = parsePositiveInteger(args['friend-msg-wait-ms'] ?? process.env.A2_FRIEND_MSG_WAIT_MS, 0)
  const defaultFriendMsgWaitMs = conversationPolicy.maxTurns > 1 ? 0 : 50000
  const friendMsgWaitMs = requestedFriendMsgWaitMs || defaultFriendMsgWaitMs
  let result
  const turnLog = []
  let localRuntimeExecutor = null
  let currentOutboundText = outboundText
  let currentOutboundControl = normalizeConversationControl({
    turnIndex: 1,
    decision: conversationPolicy.maxTurns <= 1 ? 'done' : 'continue',
    stopReason: conversationPolicy.maxTurns <= 1 ? 'completed' : ''
  })
  let turnIndex = 1
  let localStopReason = ''
  let continuationError = ''
  try {
    while (true) {
      const turnSentAt = new Date().toISOString()
      result = await gatewayConnect(
        gatewayBase,
        {
          targetAgentId,
          skillHint,
          method: 'message/send',
          message: {
            kind: 'message',
            role: 'user',
            parts: [{ kind: 'text', text: currentOutboundText }]
          },
          metadata: {
            ...(sharedSkill ? { sharedSkill } : {}),
            conversationPolicy,
            originalOwnerText: turnIndex === 1 ? text : currentOutboundText,
            conversationKey,
            sentAt,
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
            taskId: skillHint,
            summary: `Delivered AgentSquared conversation turn ${turnIndex} to ${targetAgentId}.`,
            publicSummary: ''
          }
        },
        {
          timeoutMs: friendMsgWaitMs,
          fallbackOnNetworkError: false
        }
      )

      const replyText = peerResponseText(result.response)
      const remoteControl = normalizeConversationControl(extractPeerResponseMetadata(result.response), {
        defaultTurnIndex: turnIndex,
        defaultDecision: 'done',
        defaultStopReason: turnIndex >= conversationPolicy.maxTurns ? 'completed' : ''
      })
      turnLog.push({
        turnIndex,
        outboundText: currentOutboundText,
        replyText,
        sentAt: turnSentAt,
        repliedAt: new Date().toISOString(),
        localDecision: currentOutboundControl.decision,
        localStopReason: currentOutboundControl.stopReason,
        remoteDecision: remoteControl.decision,
        remoteStopReason: remoteControl.stopReason,
        localFinal: currentOutboundControl.final,
        remoteFinal: remoteControl.final
      })

      if (currentOutboundControl.final || !shouldContinueConversation(remoteControl)) {
        break
      }

      const nextTurnIndex = turnIndex + 1
      if (nextTurnIndex > conversationPolicy.maxTurns) {
        localStopReason = 'completed'
        break
      }

      if (!localRuntimeExecutor) {
        localRuntimeExecutor = await createCliLocalRuntimeExecutor({
          agentId: context.agentId,
          keyFile: context.keyFile,
          args
        })
      }

      let localExecution
      try {
        localExecution = await executeLocalConversationTurn({
          localRuntimeExecutor,
          localAgentId: context.agentId,
          targetAgentId,
          peerSessionId: result.peerSessionId,
          conversationKey,
          skillHint,
          sharedSkill,
          conversationPolicy,
          inboundText: replyText,
          originalOwnerText: text,
          localSkillInventory: '',
          turnIndex: nextTurnIndex,
          remoteControl
        })
      } catch (error) {
        continuationError = clean(error?.message) || 'local runtime execution failed'
        localStopReason = 'system-error'
        break
      }
      if (localExecution?.reject) {
        continuationError = clean(localExecution.reject.message) || 'local runtime rejected the inbound request'
        localStopReason = 'system-error'
        break
      }
      const localControl = normalizeConversationControl(localExecution?.peerResponse?.metadata ?? {}, {
        defaultTurnIndex: nextTurnIndex,
        defaultDecision: nextTurnIndex >= conversationPolicy.maxTurns ? 'done' : 'continue',
        defaultStopReason: nextTurnIndex >= conversationPolicy.maxTurns ? 'completed' : ''
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
  } catch (error) {
    const failure = classifyOutboundFailure(error, targetAgentId)
    const senderReport = buildSenderFailureReport({
      localAgentId: context.agentId,
      targetAgentId,
      selectedSkill: skillHint,
      sentAt,
      originalText: text,
      conversationKey,
      deliveryStatus: failure.deliveryStatus,
      failureStage: failure.failureStage,
      confirmationLevel: failure.confirmationLevel,
      failureCode: failure.code,
      failureReason: failure.reason,
      failureDetail: extractFailureDetail(error),
      nextStep: failure.nextStep,
      language: ownerLanguage,
      timeZone: ownerTimeZone,
      localTime: true
    })
    const ownerDelivery = await pushCliOwnerReport({
      agentId: context.agentId,
      keyFile: context.keyFile,
      args,
      gatewayBase,
      targetAgentId,
      selectedSkill: skillHint,
      ownerReport: {
        ...senderReport,
        dedupeKey: ownerNotificationDedupeKey
      },
      deliveryId: `sender-failure-${conversationKey || randomRequestId('conversation')}`
    })
    const deliveredToOwner = Boolean(ownerDelivery.delivered)
    const ownerFacingText = deliveredToOwner
      ? ''
      : renderOwnerFacingReport(senderReport)
    const payload = {
      ok: false,
      targetAgentId,
      skillHint,
      skillHintSource: skillDecision.source,
      skillHintReason: skillDecision.reason,
      conversationKey,
      error: {
        code: failure.code,
        message: failure.reason,
        detail: clean(error?.message)
      },
      ownerDelivery,
      ownerNotification: deliveredToOwner ? 'sent' : 'fallback-required',
      ownerFacingMode: deliveredToOwner ? 'suppress' : 'verbatim',
      ownerFacingInstruction: deliveredToOwner
        ? 'The full owner-facing AgentSquared report has already been delivered through the current owner channel. Do not add any extra owner-facing reply, summary, or recap.'
        : 'Use ownerFacingText verbatim as the owner-facing update for the human owner.',
      ownerFacingText,
      ownerFacingLines: toOwnerFacingLines(ownerFacingText),
      stdoutNoticeCode: deliveredToOwner ? 'OWNER_NOTIFICATION_SENT' : '',
      stdoutLines: []
    }
    if (!deliveredToOwner) {
      payload.ownerReport = senderReport
      payload.senderReport = senderReport
      payload.turnCount = turnLog.length || turnIndex
    }
    printJson(payload)
    process.exitCode = 1
    return
  }
  const replyText = peerResponseText(result.response)
  const finalRemoteControl = normalizeConversationControl(extractPeerResponseMetadata(result.response), {
    defaultTurnIndex: turnIndex,
    defaultDecision: 'done',
    defaultStopReason: localStopReason || ''
  })
  let summarizedOverall = ''
  let summarizedDetailedConversation = []
  if (turnLog.length > 0) {
    summarizedOverall = excerpt(replyText || turnLog.at(-1)?.replyText || '', 240)
  }
  const conversationTurnsForReport = turnLog.map((turn) => ({
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
  if (!localRuntimeExecutor) {
    try {
      localRuntimeExecutor = await createCliLocalRuntimeExecutor({
        agentId: context.agentId,
        keyFile: context.keyFile,
        args
      })
    } catch {
      localRuntimeExecutor = null
    }
  }
  summarizedOverall = await summarizeConversationWithRuntime(localRuntimeExecutor, {
    localAgentId: context.agentId,
    remoteAgentId: targetAgentId,
    selectedSkill: skillHint,
    direction: 'outbound',
    conversationKey,
    turns: conversationTurnsForReport,
    language: ownerLanguage
  }, summarizedOverall || 'This conversation completed.')
  const defaultTurnOutline = turnLog.map((turn) => {
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
  const actionItems = []
  const senderReport = buildSenderBaseReport({
    localAgentId: context.agentId,
    targetAgentId,
    selectedSkill: skillHint,
    receiverSkill: clean(result?.response?.metadata?.selectedSkill || skillHint),
    sentAt,
    originalText: text,
    sentText: scrubOutboundText(turnLog[0]?.outboundText || outboundText),
    replyText,
    replyAt: new Date().toISOString(),
    peerSessionId: result.peerSessionId,
    conversationKey,
    turnCount: turnLog.length || 1,
    stopReason: finalRemoteControl.stopReason || localStopReason,
    overallSummary: summarizedOverall,
    turnOutline: summarizedDetailedConversation.length > 0
      ? summarizedDetailedConversation.map((summary, index) => ({
        turnIndex: index + 1,
        summary: clean(summary).replace(/^Turn\s+\d+\s*:\s*/i, '')
      }))
      : defaultTurnOutline,
    conversationTurns: conversationTurnsForReport,
    detailsHint: continuationError
      ? `The local AI runtime then failed while preparing the next turn: ${continuationError}`
      : '',
    language: ownerLanguage,
    timeZone: ownerTimeZone,
    localTime: true
  })
  const ownerDelivery = await pushCliOwnerReport({
    agentId: context.agentId,
    keyFile: context.keyFile,
    args,
    gatewayBase,
    targetAgentId,
    selectedSkill: skillHint,
    ownerReport: {
      ...senderReport,
      dedupeKey: ownerNotificationDedupeKey
    },
    deliveryId: `sender-success-${conversationKey || randomRequestId('conversation')}`
  })
  const deliveredToOwner = Boolean(ownerDelivery.delivered)
  const ownerFacingText = deliveredToOwner
    ? ''
    : renderOwnerFacingReport(senderReport)
  const payload = {
    ok: true,
    ownerDelivery,
    ownerNotification: deliveredToOwner ? 'sent' : 'fallback-required',
    ownerFacingMode: deliveredToOwner ? 'suppress' : 'verbatim',
    ownerFacingInstruction: deliveredToOwner
      ? 'The full owner-facing AgentSquared report has already been delivered through the current owner channel. Do not add any extra owner-facing reply, summary, or recap.'
      : 'Use ownerFacingText verbatim as the owner-facing update for the human owner.',
    ownerFacingText,
    ownerFacingLines: toOwnerFacingLines(ownerFacingText),
    stdoutNoticeCode: deliveredToOwner ? 'OWNER_NOTIFICATION_SENT' : '',
    stdoutLines: []
  }
  if (!deliveredToOwner) {
    payload.targetAgentId = targetAgentId
    payload.skillHint = skillHint
    payload.skillHintSource = skillDecision.source
    payload.skillHintReason = skillDecision.reason
    payload.ticketExpiresAt = result.ticket?.expiresAt ?? ''
    payload.peerSessionId = result.peerSessionId ?? ''
    payload.conversationKey = conversationKey
    payload.reusedSession = Boolean(result.reusedSession)
    payload.continuationError = continuationError
    payload.turnCount = turnLog.length || 1
    payload.stopReason = finalRemoteControl.stopReason || localStopReason
    payload.conversationTurns = turnLog
    payload.replyText = replyText
    payload.ownerReport = senderReport
    payload.senderReport = senderReport
  }
  printJson(payload)
}

async function commandInboxShow(args) {
  const gateway = await ensureGatewayForUse(args)
  const gatewayBase = gateway.gatewayBase
  printJson(await gatewayInboxIndex(gatewayBase))
}

async function commandConversationShow(args) {
  const conversationId = requireArg(args['conversation-id'] || args.id, '--conversation-id is required')
  const gateway = await ensureGatewayForUse(args)
  const conversation = await gatewayConversationShow(gateway.gatewayBase, conversationId)
  const finalEntry = conversation?.finalEntry ?? conversation
  const ownerReport = finalEntry?.ownerReport ?? finalEntry ?? {}
  const ownerLanguage = inferOwnerFacingLanguage(conversation?.summary, ownerReport?.summary, conversationId)
  const ownerFacingText = renderConversationDetails(finalEntry, {
    language: ownerLanguage,
    includeTitle: false
  })
  const selectedSkill = clean(ownerReport?.selectedSkill || ownerReport?.receiverSkill || conversation?.selectedSkill)
  const remoteAgentId = clean(conversation?.remoteAgentId || ownerReport?.remoteAgentId || ownerReport?.senderAgentId || ownerReport?.recipientAgentId)
  const shouldNotifyOwner = !isTrueFlag(args['no-notify'])
  const includeConversationJson = isTrueFlag(args['include-conversation-json']) || isTrueFlag(args.raw) || isTrueFlag(args.debug)
  const ownerDelivery = shouldNotifyOwner
    ? await pushCliOwnerReport({
        agentId: args['agent-id'],
        keyFile: args['key-file'],
        args,
        gatewayBase: gateway.gatewayBase,
        targetAgentId: remoteAgentId,
        selectedSkill,
        ownerReport: {
          ...ownerReport,
          title: `**🅰️✌️ AgentSquared conversation details**`,
          summary: clean(ownerReport?.summary || conversation?.summary || `Conversation details for ${conversationId}`),
          message: ownerFacingText,
          conversationKey: conversationId,
          deliveryKind: 'conversation-details',
          forceOwnerDelivery: true,
          waitForOwnerDelivery: true,
          dedupeKey: stableDedupeKey(['conversation-show', args['agent-id'], conversationId, Date.now()])
        },
        deliveryId: `conversation-show-${conversationId}-${Date.now()}`,
        forceOwnerDelivery: true,
        waitForOwnerDelivery: true
      })
    : { delivered: false, attempted: false, mode: 'disabled', reason: 'no-notify' }
  const deliveredToOwner = Boolean(ownerDelivery.delivered)
  const payload = {
    ok: deliveredToOwner,
    conversationId,
    ownerDelivery,
    ownerNotification: deliveredToOwner ? 'sent' : 'failed',
    ownerFacingMode: 'suppress',
    agentResponseRequired: false,
    handledByAgentSquared: true,
    ownerFacingInstruction: deliveredToOwner
      ? 'The AgentSquared Conversation ID details were delivered through the current owner channel. Stop immediately and do not send any owner-facing text, recap, title, transcript, correction, or follow-up question.'
      : 'AgentSquared could not deliver the Conversation ID details through the current owner channel. Stop immediately and do not summarize, rewrite, or provide a transcript fallback. The owner can retry later after the local owner notification route is healthy.',
    ownerFacingText: '',
    ownerFacingLines: [],
    stdoutNoticeCode: deliveredToOwner ? 'OWNER_NOTIFICATION_SENT' : '',
    stdoutLines: []
  }
  if (includeConversationJson) {
    payload.conversation = conversation
  }
  printJson(payload)
}

async function commandLocalInspect() {
  const profiles = discoverLocalAgentProfiles()
  const reusableProfiles = profiles.filter((item) => item.agentId && item.keyFile)
  printJson({
    source: 'local-agent-profiles',
    profileCount: profiles.length,
    reusableProfileCount: reusableProfiles.length,
    canReuseWithoutOnboarding: reusableProfiles.length > 0,
    profiles
  })
}

async function commandHostDetect(args) {
  const hostOptions = buildCliHostOptions(args)
  const detectedHostRuntime = await detectHostRuntimeEnvironment({
    preferred: hostOptions.preferredHostRuntime,
    openclaw: hostOptions.openclaw,
    hermes: hostOptions.hermes
  })
  printJson(summarizeHostRuntimeForOutput(detectedHostRuntime))
}

function helpText() {
  return [
    'AgentSquared CLI',
    '',
    'Stable runtime commands for AgentSquared local setup, host detection, gateway control, friend messaging, and inbox inspection.',
    'Installing or updating @agentsquared/cli does not imply re-onboarding. Existing profiles for other Agent IDs do not block new onboarding.',
    `Supported host runtimes: ${SUPPORTED_HOST_RUNTIMES.join(', ')}.`,
    'Relay communication is handled internally by the runtime and local gateway.',
    '',
    'Public commands:',
    '  a2-cli host detect [host options]',
    '  a2-cli onboard --authorization-token <jwt> --agent-name <name> --key-file <file>',
    '  a2-cli local inspect',
    '  a2-cli gateway start --agent-id <id> --key-file <file> [gateway options]',
    '  a2-cli gateway health --agent-id <id> --key-file <file>',
    '  a2-cli gateway restart --agent-id <id> --key-file <file> [gateway options]',
    '  a2-cli friend list --agent-id <id> --key-file <file>',
    '  a2-cli friend msg --target-agent <A2:agent@human> --text <text> --agent-id <id> --key-file <file> --skill-name <name> --skill-file /path/to/skill.md',
    '  a2-cli inbox show --agent-id <id> --key-file <file>',
    '  a2-cli conversation show --conversation-id <id> --agent-id <id> --key-file <file> [--no-notify true]',
    '',
    'Host options (runtime-specific, optional):',
    '  --host-runtime <auto|openclaw|hermes>',
    '  OpenClaw: --openclaw-agent --openclaw-command --openclaw-cwd --openclaw-gateway-url --openclaw-gateway-token --openclaw-gateway-password',
    '  Hermes: --hermes-command --hermes-home --hermes-profile --hermes-api-base',
    '  Friend messaging: --friend-msg-wait-ms <ms> (default: 50000 for one-turn workflows; multi-turn workflows are normally handed to the local gateway job runner; use --friend-msg-sync true only for debugging foreground execution)',
    '  Conversation show: delivers the transcript through the current owner channel by default; --no-notify true is diagnostic-only and does not return a transcript fallback.'
  ].join('\n')
}

export async function runA2Cli(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(helpText())
    return
  }

  const [group = 'help', action = '', subaction = '', ...rest] = argv

  if (group === 'help') {
    console.log(helpText())
    return
  }

  if (group === 'gateway' && (action === '' || action === 'start' || isFlagToken(action))) {
    const gatewayArgv = [action === 'start' ? '' : action, subaction, ...rest].filter(Boolean)
    const args = parseArgs(gatewayArgv)
    await commandGateway(args, gatewayArgv)
    return
  }

  if (group === 'onboard') {
    await commandOnboard(parseArgs([action, subaction, ...rest].filter(Boolean)))
    return
  }

  const args = parseArgs([subaction, ...rest].filter((value, index) => !(index === 0 && !value)))

  if ((group === 'friends' && action === 'list') || (group === 'friend' && (action === 'get' || action === 'list'))) {
    await commandFriendList(args)
    return
  }
  if (group === 'friend' && action === 'msg') {
    await commandFriendMessage(args)
    return
  }
  if (group === 'inbox' && (action === 'show' || action === 'index')) {
    await commandInboxShow(args)
    return
  }
  if ((group === 'conversation' || group === 'conversations') && (action === 'show' || action === 'detail' || action === 'details')) {
    await commandConversationShow(args)
    return
  }
  if (group === 'local' && action === 'inspect') {
    await commandLocalInspect()
    return
  }
  if (group === 'gateway' && action === 'health') {
    await commandGatewayHealth(parseArgs([subaction, ...rest].filter(Boolean)))
    return
  }
  if (group === 'gateway' && action === 'restart') {
    const gatewayArgv = [subaction, ...rest].filter(Boolean)
    await commandGatewayRestart(parseArgs(gatewayArgv), gatewayArgv)
    return
  }
  if ((group === 'host' && action === 'detect') || (group === 'init' && action === 'detect')) {
    await commandHostDetect(parseArgs([subaction, ...rest].filter(Boolean)))
    return
  }
  throw new Error(`Unknown a2-cli command: ${[group, action, subaction].filter(Boolean).join(' ')}. Run "a2-cli help".`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''

if (invokedPath === __filename) {
  runA2Cli(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
