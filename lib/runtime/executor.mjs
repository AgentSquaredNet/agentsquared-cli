import fs from 'node:fs'
import path from 'node:path'
import { extractInboundText } from '../routing/agent_router.mjs'
import { normalizeConversationControl, normalizeSharedSkillName } from '../conversation/policy.mjs'
import { createHostRuntimeAdapter } from '../../adapters/index.mjs'
import { safeAgentId } from '../shared/paths.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export function resolveEphemeralRuntimeSessionId(responseMetadata = {}, requestMetadata = {}) {
  return clean(
    responseMetadata.runtimeSessionId
    || responseMetadata.openclawSessionKey
    || responseMetadata.hermesSessionId
    || responseMetadata.hermesConversationId
    || responseMetadata.codexThreadId
    || responseMetadata.claudeCodeSessionId
    || requestMetadata.runtimeSessionId
    || requestMetadata.conversationKey
  )
}

function nowISO() {
  return new Date().toISOString()
}

function normalizeOwnerDeliveryResult(result = null) {
  const reason = clean(result?.reason)
  const delivered = Boolean(result?.delivered)
  const timedOut = /timeout/i.test(reason)
  return {
    attempted: Boolean(result?.attempted ?? true),
    delivered,
    status: delivered ? 'sent' : timedOut ? 'maybe_sent' : 'failed',
    mode: clean(result?.mode) || 'host',
    reason,
    stdout: result?.stdout ?? '',
    ownerRoute: result?.ownerRoute ?? null,
    payload: result?.payload ?? null,
    deliveredAt: delivered ? nowISO() : '',
    lastError: delivered ? '' : reason
  }
}

function buildTextMessageResult(text, metadata = {}) {
  return {
    message: {
      kind: 'message',
      role: 'agent',
      parts: [{ kind: 'text', text: clean(text) }]
    },
    metadata
  }
}

function excerpt(text, maxLength = 180) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function normalizePeerResponse(value, metadata = {}) {
  if (typeof value === 'string') {
    return buildTextMessageResult(value, metadata)
  }
  if (value && typeof value === 'object') {
    return {
      ...value,
      metadata: {
        ...(value.metadata ?? {}),
        ...metadata
      }
    }
  }
  return null
}

export function normalizeExecutionResult(raw, {
  selectedSkill,
  mailboxKey
} = {}) {
  const baseMetadata = {
    selectedSkill: clean(selectedSkill),
    mailboxKey: clean(mailboxKey)
  }

  if (typeof raw === 'string') {
    const conversation = normalizeConversationControl({}, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: 'completed'
    })
    return {
      peerResponse: buildTextMessageResult(raw, {
        ...baseMetadata,
        turnIndex: conversation.turnIndex,
        decision: conversation.decision,
        stopReason: conversation.stopReason,
        final: conversation.final,
        finalize: conversation.final
      }),
      ownerReport: null
    }
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('local runtime executor returned an invalid result')
  }

  if (raw.reject && typeof raw.reject === 'object') {
    return {
      reject: {
        code: Number.parseInt(`${raw.reject.code ?? 500}`, 10) || 500,
        message: clean(raw.reject.message) || 'local runtime rejected the inbound request'
      }
    }
  }

  const directPeerResponse = normalizePeerResponse(raw.peerResponse, baseMetadata)
  if (directPeerResponse) {
    const conversation = normalizeConversationControl({
      ...(raw.peerResponse?.metadata ?? {}),
      ...(raw ?? {})
    }, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: ''
    })
    return {
      peerResponse: {
        ...directPeerResponse,
        metadata: {
          ...(directPeerResponse.metadata ?? {}),
          turnIndex: conversation.turnIndex,
          decision: conversation.decision,
          stopReason: conversation.stopReason,
          final: conversation.final,
          finalize: conversation.final
        }
      },
      ownerReport: raw.ownerReport ?? null
    }
  }

  const shorthandPeerResponse = normalizePeerResponse(
    raw.message || raw.result || (raw.parts ? { message: raw } : null),
    baseMetadata
  )
  if (shorthandPeerResponse) {
    const conversation = normalizeConversationControl(raw, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: ''
    })
    return {
      peerResponse: {
        ...shorthandPeerResponse,
        metadata: {
          ...(shorthandPeerResponse.metadata ?? {}),
          turnIndex: conversation.turnIndex,
          decision: conversation.decision,
          stopReason: conversation.stopReason,
          final: conversation.final,
          finalize: conversation.final
        }
      },
      ownerReport: raw.ownerReport ?? null
    }
  }

  throw new Error('local runtime executor did not provide peerResponse or reject')
}

export function createLocalRuntimeExecutor({
  agentId,
  mode = 'none',
  hostRuntime = 'none',
  conversationStore = null,
  openclawStateDir = '',
  openclawCommand = 'openclaw',
  openclawCwd = '',
  openclawConfigPath = '',
  openclawAgent = '',
  openclawSessionPrefix = 'agentsquared:',
  openclawTimeoutMs = 180000,
  openclawGatewayUrl = '',
  openclawGatewayToken = '',
  openclawGatewayPassword = '',
  hermesCommand = 'hermes',
  hermesHome = '',
  hermesProfile = '',
  hermesApiBase = '',
  hermesTimeoutMs = 180000,
  codexCommand = '',
  codexTimeoutMs = 180000,
  claudeCommand = 'claude',
  claudeCwd = '',
  claudeModel = '',
  claudeTimeoutMs = 180000,
  claudeMaxTurns = 3,
  claudeSettingSources = 'none'
} = {}) {
  const normalizedMode = clean(mode).toLowerCase() || 'none'
  const normalizedHostRuntime = clean(hostRuntime).toLowerCase() || 'none'
  const hostAdapter = normalizedMode === 'host'
    ? createHostRuntimeAdapter({
        hostRuntime: normalizedHostRuntime || 'none',
        localAgentId: agentId,
        openclaw: {
          conversationStore,
          stateDir: openclawStateDir,
          openclawAgent,
          command: openclawCommand,
          cwd: openclawCwd,
          configPath: openclawConfigPath,
          sessionPrefix: openclawSessionPrefix,
          timeoutMs: openclawTimeoutMs,
          gatewayUrl: openclawGatewayUrl,
          gatewayToken: openclawGatewayToken,
          gatewayPassword: openclawGatewayPassword
        },
        hermes: {
          conversationStore,
          command: hermesCommand,
          hermesHome,
          hermesProfile,
          apiBase: hermesApiBase,
          timeoutMs: hermesTimeoutMs
        },
        codex: {
          conversationStore,
          codexPath: codexCommand,
          timeoutMs: codexTimeoutMs
        },
        claudecode: {
          conversationStore,
          claudeCommand,
          cwd: claudeCwd,
          model: claudeModel,
          timeoutMs: claudeTimeoutMs,
          maxTurns: claudeMaxTurns,
          settingSources: claudeSettingSources
        }
      })
    : null

  async function executeViaHost(context) {
    if (!hostAdapter) {
      throw new Error('host runtime adapter was not configured')
    }
    const metadata = context?.item?.request?.params?.metadata ?? {}
    const channelKind = clean(metadata.channelKind).toLowerCase() || 'a2a'
    let normalized = null
    try {
      normalized = normalizeExecutionResult(
        await hostAdapter.executeInbound(context),
        context
      )
      return normalized
    } finally {
      if ((channelKind === 'h2a' || channelKind === 'api') && typeof hostAdapter.destroySession === 'function') {
        const responseMetadata = normalized?.peerResponse?.metadata ?? {}
        const runtimeSessionId = resolveEphemeralRuntimeSessionId(responseMetadata, metadata)
        void hostAdapter.destroySession({
          channelKind,
          runtimeSessionId,
          conversationKey: clean(metadata.conversationKey),
          reason: 'ephemeral-channel-complete'
        }).catch(() => {})
      }
    }
  }

  async function rejectExecution() {
    return {
      reject: {
        code: 503,
        message: 'no local agent runtime adapter is configured; inbound request cannot be handled yet'
      }
    }
  }

  const execute = normalizedMode === 'host'
    ? executeViaHost
    : rejectExecution

  execute.mode = normalizedMode
  execute.summarizeConversation = async (context = {}) => {
    if (!hostAdapter?.summarizeConversation) {
      return ''
    }
    return clean(await hostAdapter.summarizeConversation(context))
  }
  execute.preflight = async () => {
    if (!hostAdapter?.preflight) {
      return { ok: normalizedMode !== 'host', mode: normalizedMode }
    }
    return hostAdapter.preflight()
  }
  return execute
}

export function createOwnerNotifier({
  agentId,
  mode = 'inbox',
  hostRuntime = 'none',
  inbox = null,
  openclawStateDir = '',
  openclawCommand = 'openclaw',
  openclawCwd = '',
  openclawConfigPath = '',
  openclawAgent = '',
  openclawSessionPrefix = 'agentsquared:',
  openclawTimeoutMs = 180000,
  openclawGatewayUrl = '',
  openclawGatewayToken = '',
  openclawGatewayPassword = '',
  hermesCommand = 'hermes',
  hermesHome = '',
  hermesProfile = '',
  hermesApiBase = '',
  hermesTimeoutMs = 180000,
  codexCommand = '',
  codexTimeoutMs = 180000,
  claudeCommand = 'claude',
  claudeCwd = '',
  claudeModel = '',
  claudeTimeoutMs = 180000,
  claudeMaxTurns = 3,
  claudeSettingSources = 'none'
} = {}) {
  const normalizedMode = clean(mode).toLowerCase() || 'inbox'
  const normalizedHostRuntime = clean(hostRuntime).toLowerCase() || 'none'
  const hostAdapter = normalizedMode === 'host'
    ? createHostRuntimeAdapter({
        hostRuntime: normalizedHostRuntime || 'none',
        localAgentId: agentId,
        openclaw: {
          stateDir: openclawStateDir,
          openclawAgent,
          command: openclawCommand,
          cwd: openclawCwd,
          configPath: openclawConfigPath,
          sessionPrefix: openclawSessionPrefix,
          timeoutMs: openclawTimeoutMs,
          gatewayUrl: openclawGatewayUrl,
          gatewayToken: openclawGatewayToken,
          gatewayPassword: openclawGatewayPassword
        },
        hermes: {
          command: hermesCommand,
          hermesHome,
          hermesProfile,
          apiBase: hermesApiBase,
          timeoutMs: hermesTimeoutMs
        },
        codex: {
          codexPath: codexCommand,
          timeoutMs: codexTimeoutMs
        },
        claudecode: {
          claudeCommand,
          cwd: claudeCwd,
          model: claudeModel,
          timeoutMs: claudeTimeoutMs,
          maxTurns: claudeMaxTurns,
          settingSources: claudeSettingSources
        }
      })
    : null
  const deliveredFinalConversationKeys = new Set()
  const pendingFinalConversationKeys = new Set()

  async function notifyViaInbox(context) {
    if (!inbox?.appendEntry) {
      throw new Error('inbox store is required for AgentSquared owner reporting')
    }
    const metadata = context?.item?.request?.params?.metadata || {}
    const isApiCall = clean(metadata.source) === 'openai-compatible-api' || Boolean(metadata.openaiRequestId)

    let acceptedDelivery = {
      mode: 'inbox',
      attempted: false,
      delivered: false,
      status: 'stored',
      reason: 'inbox-only'
    }
    if (isApiCall) {
      acceptedDelivery.status = 'skipped_api'
      acceptedDelivery.reason = 'api-call-notification-suppressed'

      const usage = context?.peerResponse?.metadata?.usage 
        || context?.peerResponse?.usage
        || context?.item?.request?.params?.metadata?.usage
        || null
      if (inbox?.appendApiUsage) {
        inbox.appendApiUsage({
          id: context.item?.inboundId,
          requestId: metadata.openaiRequestId || context.item?.request?.id || '',
          caller: metadata.fromHuman || metadata.from || context.item?.remoteAgentId || 'unknown',
          skill: context.selectedSkill || metadata.toAgent || metadata.to || 'unknown',
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0
        })
      }
    }

    const value = inbox.appendEntry({
      agentId,
      selectedSkill: context.selectedSkill,
      mailboxKey: context.mailboxKey,
      item: context.item,
      ownerReport: context.ownerReport,
      peerResponse: context.peerResponse ?? null,
      ownerDelivery: acceptedDelivery
    })
    return {
      delivered: true,
      mode: 'inbox',
      entryId: value.entry.id,
      totalCount: value.index.totalCount
    }
  }

  async function notifyViaHost(context) {
    const metadata = context?.item?.request?.params?.metadata || {}
    const isApiCall = clean(metadata.source) === 'openai-compatible-api' || Boolean(metadata.openaiRequestId)

    const finalConversationKey = clean(context?.ownerReport?.conversationKey)
    const isFinalOwnerReport = Boolean(context?.ownerReport?.final ?? context?.ownerReport?.finalize)
    const forceOwnerDelivery = Boolean(context?.forceOwnerDelivery || context?.ownerReport?.forceOwnerDelivery)
    const waitForOwnerDelivery = Boolean(context?.waitForOwnerDelivery || context?.ownerReport?.waitForOwnerDelivery)
    const duplicateFinal = isFinalOwnerReport && finalConversationKey
      ? !forceOwnerDelivery && (pendingFinalConversationKeys.has(finalConversationKey)
        || deliveredFinalConversationKeys.has(finalConversationKey)
        || inbox?.findDeliveredFinalConversationReport?.(finalConversationKey))
      : null
    let acceptedDelivery = {
      attempted: false,
      delivered: false,
      status: 'queued',
      mode: normalizedHostRuntime || 'host',
      reason: 'owner-notification-accepted',
      acceptedAt: nowISO()
    }
    let shouldScheduleHostDelivery = Boolean(hostAdapter) && isFinalOwnerReport
    if (isApiCall) {
      acceptedDelivery = {
        delivered: false,
        attempted: false,
        status: 'skipped_api',
        mode: normalizedHostRuntime || 'host',
        reason: 'api-call-notification-suppressed',
        acceptedAt: nowISO()
      }
      shouldScheduleHostDelivery = false

      const usage = context?.peerResponse?.metadata?.usage 
        || context?.peerResponse?.usage
        || context?.item?.request?.params?.metadata?.usage
        || null
      if (inbox?.appendApiUsage) {
        inbox.appendApiUsage({
          id: context.item?.inboundId,
          requestId: metadata.openaiRequestId || context.item?.request?.id || '',
          caller: metadata.fromHuman || metadata.from || context.item?.remoteAgentId || 'unknown',
          skill: context.selectedSkill || metadata.toAgent || metadata.to || 'unknown',
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0
        })
      }
    } else if (!isFinalOwnerReport) {
      acceptedDelivery = {
        delivered: false,
        attempted: false,
        status: 'deferred',
        mode: normalizedHostRuntime || 'host',
        reason: 'final-owner-report-only',
        acceptedAt: nowISO()
      }
      shouldScheduleHostDelivery = false
    } else if (duplicateFinal) {
      acceptedDelivery = {
        delivered: false,
        attempted: false,
        status: 'skipped_duplicate',
        mode: normalizedHostRuntime || 'host',
        reason: 'duplicate-final-report-suppressed'
      }
      shouldScheduleHostDelivery = false
    } else if (!hostAdapter) {
      acceptedDelivery = {
        delivered: false,
        attempted: false,
        status: 'failed',
        mode: normalizedHostRuntime || 'host',
        reason: 'adapter-not-configured'
      }
      shouldScheduleHostDelivery = false
    }

    if (finalConversationKey && context?.ownerReport?.final && shouldScheduleHostDelivery && !forceOwnerDelivery) {
      pendingFinalConversationKeys.add(finalConversationKey)
    }

    const value = inbox.appendEntry({
      agentId,
      selectedSkill: context.selectedSkill,
      mailboxKey: context.mailboxKey,
      item: context.item,
      ownerReport: context.ownerReport,
      peerResponse: context.peerResponse ?? null,
      ownerDelivery: acceptedDelivery
    })

    async function deliverToHost(entryId, totalCount) {
      let ownerResult
      try {
        inbox.updateOwnerDelivery?.(entryId, {
          ...acceptedDelivery,
          attempted: true,
          delivered: false,
          status: 'sending',
          reason: 'owner-notification-sending',
          sendingAt: nowISO()
        })
        ownerResult = await hostAdapter.pushOwnerReport({
          item: context.item,
          selectedSkill: context.selectedSkill,
          ownerReport: context.ownerReport
        })
      } catch (error) {
        ownerResult = {
          delivered: false,
          attempted: true,
          mode: normalizedHostRuntime || 'host',
          reason: clean(error?.message) || 'owner-push-failed'
        }
      }
      const normalized = normalizeOwnerDeliveryResult({
        ...ownerResult,
        mode: clean(ownerResult?.mode) || normalizedHostRuntime || 'host'
      })
      inbox.updateOwnerDelivery?.(entryId, normalized)
      if (finalConversationKey && Boolean(normalized.delivered) && context?.ownerReport?.final && !forceOwnerDelivery) {
        deliveredFinalConversationKeys.add(finalConversationKey)
      }
      if (finalConversationKey && context?.ownerReport?.final && !forceOwnerDelivery) {
        pendingFinalConversationKeys.delete(finalConversationKey)
      }
      return {
        delivered: Boolean(normalized.delivered),
        mode: normalizedHostRuntime || 'host',
        notificationAccepted: true,
        notificationStatus: normalized.status,
        entryId,
        totalCount,
        deliveredToOwner: Boolean(normalized.delivered),
        ownerDelivery: normalized
      }
    }

    if (shouldScheduleHostDelivery) {
      const entryId = value.entry.id
      if (waitForOwnerDelivery) {
        return await deliverToHost(entryId, value.index.totalCount)
      }
      setTimeout(() => {
        void deliverToHost(entryId, value.index.totalCount)
      }, 0)
    } else if (finalConversationKey && context?.ownerReport?.final) {
      pendingFinalConversationKeys.delete(finalConversationKey)
      if (acceptedDelivery.status === 'skipped_duplicate') {
        deliveredFinalConversationKeys.add(finalConversationKey)
      }
    }

    const notificationAccepted = !['skipped_duplicate', 'failed'].includes(acceptedDelivery.status)
    return {
      delivered: true,
      mode: normalizedHostRuntime || 'host',
      notificationAccepted,
      notificationStatus: 'sent',
      entryId: value.entry.id,
      totalCount: value.index.totalCount,
      deliveredToOwner: false,
      ownerDelivery: acceptedDelivery
    }
  }

  const notify = normalizedMode === 'host'
    ? notifyViaHost
    : notifyViaInbox

  notify.mode = normalizedMode
  notify.preflight = async () => ({ ok: true, mode: normalizedMode })
  return notify
}

function buildOwnerSummary(context) {
  const remoteAgentId = clean(context?.item?.remoteAgentId) || 'unknown'
  const selectedSkill = normalizeSharedSkillName(context?.selectedSkill, '')
  const incoming = excerpt(extractInboundText(context?.item))
  if (incoming) {
    return `${remoteAgentId} sent a message: ${incoming}`
  }
  if (selectedSkill) {
    return `${remoteAgentId} opened an inbound ${selectedSkill} request.`
  }
  return `${remoteAgentId} opened an inbound AgentSquared request.`
}
