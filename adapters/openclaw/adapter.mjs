import { withOpenClawGatewayClient } from './ws_client.mjs'
import { buildReceiverBaseReport, inferOwnerFacingLanguage, parseAgentSquaredOutboundEnvelope } from '../../lib/conversation/templates.mjs'
import { normalizeConversationControl, resolveConversationMaxTurns, resolveInboundConversationIdentity } from '../../lib/conversation/policy.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import {
  buildOpenClawCombinedPrompt,
  buildOpenClawSafetyPrompt,
  buildOpenClawTaskPrompt,
  latestAssistantText,
  normalizeSessionList,
  OPENCLAW_AGENT_SQUARED_NO_TOOLS_PROMPT,
  ownerReportText,
  parseOpenClawCombinedResult,
  parseOpenClawTaskResult,
  peerResponseText,
  readOpenClawRunId,
  readOpenClawStatus,
  resolveOwnerRouteFromSessions,
  stableId
} from './helpers.mjs'
import {
  excerpt,
  localOwnerTimeZone,
  buildReceiverTurnOutline,
  maxTurnIndexFromOutline,
  createPeerBudget
} from '../../lib/runtime/adapters.mjs'

export {
  buildOpenClawCombinedPrompt,
  buildOpenClawSafetyPrompt,
  buildOpenClawTaskPrompt,
  parseOpenClawCombinedResult,
  parseOpenClawTaskResult
}

function clean(value) {
  return `${value ?? ''}`.trim()
}

function randomId(prefix = 'a2') {
  return `${clean(prefix) || 'a2'}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function nowMs() {
  return Date.now()
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function describeOpenClawError(error = null, seen = new Set()) {
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
  const code = clean(error.code || error.detailCode)
  if (code && !parts.some((part) => part.includes(code))) {
    parts.push(code)
  }
  const cause = describeOpenClawError(error.cause, seen)
  if (cause) {
    parts.push(`cause: ${cause}`)
  }
  return [...new Set(parts)].join('; ')
}

function openClawGatewayUnavailable(error = null) {
  const lower = describeOpenClawError(error).toLowerCase()
  return Boolean(
    lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('gateway closed')
    || lower.includes('abnormal closure')
    || lower.includes('gateway socket is not open')
    || lower.includes('open timed out')
    || lower.includes('connect challenge timed out')
    || lower.includes('websocket')
  )
}

function wrapOpenClawRuntimeError(stage, error) {
  const detail = describeOpenClawError(error)
  const message = `OpenClaw runtime failed during ${clean(stage) || 'gateway request'}: ${detail || 'unknown error'}`
  const wrapped = new Error(message, { cause: error })
  wrapped.code = openClawGatewayUnavailable(error)
    ? 503
    : (Number.parseInt(`${error?.code ?? ''}`, 10) || 500)
  wrapped.a2OpenClawStage = clean(stage)
  wrapped.a2RuntimeStage = clean(stage)
  wrapped.runtimeAdapter = 'openclaw'
  wrapped.a2RuntimeAdapter = 'openclaw'
  wrapped.a2FailureKind = 'openclaw-runtime-error'
  wrapped.a2NoFallback = true
  wrapped.detail = detail
  return wrapped
}

async function requestOpenClaw(client, method, params, timeoutMs, stage, {
  openclawAgent = '',
  localAgentId = ''
} = {}) {
  try {
    return await client.request(method, params, timeoutMs)
  } catch (error) {
    const reframed = method === 'agent'
      ? reframeOpenClawAgentError(error, { openclawAgent, localAgentId })
      : error
    throw wrapOpenClawRuntimeError(stage || method, reframed)
  }
}



function reframeOpenClawAgentError(error, {
  openclawAgent = '',
  localAgentId = ''
} = {}) {
  const message = clean(error?.message)
  if (!message) {
    return error
  }
  if (message.toLowerCase().includes('unknown agent id')) {
    return new Error(
      `OpenClaw rejected agent id "${clean(openclawAgent)}". AgentSquared needs a real local OpenClaw agent id here, not the AgentSquared id "${clean(localAgentId)}". Configure --openclaw-agent explicitly or make sure OpenClaw exposes a default agent (usually from agents.list[]; fallback is often "main"). Original error: ${message}`
    )
  }
  return error
}

function resolveFinalAssistantResultText({
  waited = null,
  history = null,
  runId = '',
  label = 'OpenClaw run',
  sessionKey = ''
} = {}) {
  const fromWaited = latestAssistantText(waited, { runId })
  if (clean(fromWaited)) {
    return fromWaited
  }
  const fromHistory = latestAssistantText(history, { runId })
  if (clean(fromHistory)) {
    return fromHistory
  }
  throw new Error(`${clean(label) || 'OpenClaw run'} did not produce a final assistant message for session ${clean(sessionKey) || 'unknown'}.`)
}


export function createOpenClawAdapter({
  localAgentId,
  openclawAgent = '',
  conversationStore = null,
  command = 'openclaw',
  cwd = '',
  configPath = '',
  stateDir = '',
  sessionPrefix = 'agentsquared:',
  timeoutMs = 180000,
  gatewayUrl = '',
  gatewayToken = '',
  gatewayPassword = ''
} = {}) {
  const agentName = clean(openclawAgent)
  if (!agentName) {
    throw new Error(`openclaw agent name is required for ${clean(localAgentId) || 'the local AgentSquared agent'}`)
  }
  const { consumePeerBudget } = createPeerBudget()

  async function retryTransientOpenClawRuntime(fn, {
    stage = 'OpenClaw execution',
    maxAttempts = 3,
    retryDelayMs = 1000
  } = {}) {
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn({ attempt })
      } catch (error) {
        lastError = error
        if (!openClawGatewayUnavailable(error) || attempt >= maxAttempts) {
          throw error
        }
        console.warn(`${stage} transient runtime failure on attempt ${attempt}/${maxAttempts}: ${describeOpenClawError(error) || error.message}. Retrying after ${retryDelayMs}ms.`)
        await sleep(retryDelayMs)
      }
    }
    throw lastError
  }

  async function withGateway(fn) {
    return withOpenClawGatewayClient({
      command,
      cwd,
      configPath,
      stateDir,
      gatewayUrl,
      gatewayToken,
      gatewayPassword,
      requestTimeoutMs: timeoutMs
    }, fn)
  }

  async function listSessions(client) {
    return normalizeSessionList(await requestOpenClaw(client, 'sessions.list', {}, timeoutMs, 'sessions list'))
  }

  async function preflight() {
    return withGateway(async (client, gatewayContext) => {
      const health = await requestOpenClaw(client, 'health', {}, Math.min(timeoutMs, 15000), 'health check')
      return {
        ok: Boolean(health?.ok),
        gatewayUrl: gatewayContext.gatewayUrl,
        authMode: gatewayContext.authMode,
        health
      }
    })
  }

  async function resolveOwnerRoute(client) {
    return resolveOwnerRouteFromSessions(await listSessions(client), {
      agentName
    })
  }

  async function executeInbound({
    item,
    selectedSkill
  }) {
    const remoteAgentId = clean(item?.remoteAgentId)
    const incomingSkillHint = clean(item?.suggestedSkill || item?.request?.params?.metadata?.skillHint)
    const receivedAt = new Date().toISOString()
    const inboundText = peerResponseText(item?.request?.params?.message)
    const inboundMetadata = item?.request?.params?.metadata ?? {}
    const parsedEnvelope = parseAgentSquaredOutboundEnvelope(inboundText)
    const inboundConversation = normalizeConversationControl(inboundMetadata, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: ''
    })
    const displayInboundText = inboundConversation.turnIndex > 1
      ? inboundText
      : (clean(inboundMetadata.originalOwnerText) || clean(parsedEnvelope?.ownerRequest) || inboundText)
    const remoteSentAt = clean(inboundMetadata.sentAt) || clean(parsedEnvelope?.sentAt)
    const ownerLanguage = inferOwnerFacingLanguage(displayInboundText, inboundText)
    const ownerTimeZone = localOwnerTimeZone()
    const conversationIdentity = resolveInboundConversationIdentity(item)
    const conversationKey = clean(conversationIdentity.conversationKey)
    try {
      return await retryTransientOpenClawRuntime(async () => withGateway(async (client, gatewayContext) => {
        const budget = consumePeerBudget({
          remoteAgentId
        })
        if (budget.overBudget) {
          const peerReplyText = 'I am pausing this AgentSquared request because this peer has reached the recent conversation window limit. My owner can decide whether to continue later.'
          const conversation = normalizeConversationControl(item?.request?.params?.metadata ?? {}, {
            defaultTurnIndex: 1,
            defaultDecision: 'done',
            defaultStopReason: 'system-error'
          })
          const updatedConversation = conversationStore?.appendTurn?.({
            conversationKey,
            peerSessionId: item?.peerSessionId || '',
            requestId: clean(item?.request?.id),
            remoteAgentId,
            selectedSkill,
            turnIndex: conversation.turnIndex,
            inboundText: displayInboundText,
            replyText: peerReplyText,
            decision: 'done',
            stopReason: 'system-error',
            final: true,
            ownerSummary: `I paused this exchange because the recent peer conversation window was exceeded. Current 10-minute turn count: ${budget.windowTurns}.`
          }) ?? null
          const ownerReport = buildReceiverBaseReport({
            localAgentId,
            remoteAgentId,
            incomingSkillHint,
            selectedSkill,
            receivedAt,
            inboundText: displayInboundText,
            peerReplyText,
            repliedAt: new Date().toISOString(),
            skillSummary: `I paused this exchange because the recent peer conversation window was exceeded. Current 10-minute turn count: ${budget.windowTurns}.`,
            conversationTurns: updatedConversation?.turns?.length || conversation.turnIndex,
            stopReason: 'system-error',
            detailsAvailableInInbox: true,
            remoteSentAt,
            language: ownerLanguage,
            timeZone: ownerTimeZone,
            localTime: true
          })
          return {
            selectedSkill,
            peerResponse: {
              message: {
                kind: 'message',
                role: 'agent',
                parts: [{ kind: 'text', text: peerReplyText }]
              },
              metadata: {
                selectedSkill,
                runtimeAdapter: 'openclaw',
                conversationKey,
                safetyDecision: 'rate-limit',
                safetyReason: 'peer-conversation-window-exceeded',
                windowTurns: budget.windowTurns,
                turnIndex: conversation.turnIndex,
                decision: 'done',
                stopReason: 'system-error',
                final: true,
                finalize: true
              }
            },
            ownerReport: {
              ...ownerReport,
              selectedSkill,
              runtimeAdapter: 'openclaw',
              conversationKey,
              safetyDecision: 'rate-limit',
              safetyReason: 'peer-conversation-window-exceeded',
              windowTurns: budget.windowTurns,
              turnIndex: conversation.turnIndex,
              decision: 'done',
              stopReason: 'system-error',
              final: true,
              finalize: true
            }
          }
        }

        const liveConversationState = normalizeConversationControl(item?.request?.params?.metadata ?? {}, {
          defaultTurnIndex: 1,
          defaultDecision: 'done',
          defaultStopReason: ''
        })
        const metadata = item?.request?.params?.metadata ?? {}
        if (liveConversationState.turnIndex === 1) {
          conversationStore?.endConversation?.(conversationKey)
        }
        const liveConversation = conversationStore?.ensureConversation?.({
          conversationKey,
          peerSessionId: item?.peerSessionId || '',
          remoteAgentId,
          selectedSkill
        }) ?? null
        const conversationTranscript = conversationStore?.transcript?.(liveConversation?.conversationKey || conversationKey) ?? ''
        const localSkillMaxTurns = resolveConversationMaxTurns({
          conversationPolicy: metadata?.conversationPolicy ?? null,
          sharedSkill: metadata?.sharedSkill ?? null,
          fallback: 1
        })
        const defaultShouldContinue = !liveConversationState.final
          && liveConversationState.turnIndex < localSkillMaxTurns
        const sessionKey = stableId(
          'agentsquared-work',
          localAgentId,
          remoteAgentId,
          conversationKey,
          item?.request?.params?.metadata?.turnIndex || '1',
          item?.inboundId
        )
        const prompt = buildOpenClawCombinedPrompt({
          localAgentId,
          remoteAgentId,
          selectedSkill,
          item,
          conversationTranscript,
          senderSkillInventory: clean(metadata?.localSkillInventory)
        })

        const accepted = await requestOpenClaw(client, 'agent', {
          agentId: agentName,
          sessionKey,
          message: prompt,
          extraSystemPrompt: OPENCLAW_AGENT_SQUARED_NO_TOOLS_PROMPT,
          idempotencyKey: `agentsquared-agent-${clean(item?.inboundId) || randomId('inbound')}`
        }, timeoutMs, 'task agent request', { openclawAgent: agentName, localAgentId })
        const runId = readOpenClawRunId(accepted)
        if (!runId) {
          throw new Error('OpenClaw agent call did not return a runId.')
        }

        const waited = await requestOpenClaw(client, 'agent.wait', {
          runId,
          timeoutMs
        }, timeoutMs + 1000, 'task agent wait')
        const status = readOpenClawStatus(waited).toLowerCase()
        if (status && status !== 'ok' && status !== 'completed' && status !== 'done') {
          throw new Error(`OpenClaw agent.wait returned ${status || 'an unknown status'} for run ${runId}.`)
        }

        const history = await requestOpenClaw(client, 'chat.history', {
          sessionKey,
          limit: 12
        }, timeoutMs, 'task chat history')
        const resultText = resolveFinalAssistantResultText({
          waited,
          history,
          runId,
          label: 'OpenClaw inbound task',
          sessionKey
        })

        const parsed = parseOpenClawCombinedResult(resultText, {
          defaultSkill: selectedSkill,
          remoteAgentId,
          inboundId: clean(item?.inboundId),
          defaultTurnIndex: liveConversationState.turnIndex,
          defaultDecision: defaultShouldContinue ? 'continue' : 'done',
          defaultStopReason: liveConversationState.final ? 'completed' : ''
        })
        if (parsed.action !== 'allow') {
          const safetyStopReason = 'safety-block'
          const peerReplyText = scrubOutboundText(peerResponseText(parsed.peerResponse))
          const conversation = normalizeConversationControl(parsed?.peerResponse?.metadata ?? {}, {
            defaultTurnIndex: liveConversationState.turnIndex,
            defaultDecision: 'done',
            defaultStopReason: safetyStopReason
          })
          const updatedConversation = conversationStore?.appendTurn?.({
            conversationKey,
            peerSessionId: item?.peerSessionId || '',
            requestId: clean(item?.request?.id),
            remoteAgentId,
            selectedSkill,
            turnIndex: conversation.turnIndex,
            inboundText: displayInboundText,
            replyText: peerReplyText,
            decision: conversation.decision,
            stopReason: safetyStopReason,
            final: true,
            ownerSummary: clean(parsed.ownerSummary || parsed.ownerReport?.summary)
          }) ?? null
          const ownerReport = buildReceiverBaseReport({
            localAgentId,
            remoteAgentId,
            incomingSkillHint,
            selectedSkill,
            receivedAt,
            inboundText: displayInboundText,
            peerReplyText,
            repliedAt: new Date().toISOString(),
            skillSummary: clean(parsed.ownerSummary || parsed.ownerReport?.summary),
            conversationTurns: updatedConversation?.turns?.length || conversation.turnIndex,
            stopReason: safetyStopReason,
            detailsAvailableInInbox: true,
            remoteSentAt,
            language: ownerLanguage,
            timeZone: ownerTimeZone,
            localTime: true
          })
          return {
            selectedSkill,
            peerResponse: {
              ...parsed.peerResponse,
              message: {
                kind: parsed.peerResponse?.message?.kind ?? 'message',
                role: parsed.peerResponse?.message?.role ?? 'agent',
                parts: [{ kind: 'text', text: peerReplyText }]
              },
              metadata: {
                ...(parsed.peerResponse?.metadata ?? {}),
                selectedSkill,
                runtimeAdapter: 'openclaw',
                conversationKey,
                safetyDecision: parsed.action,
                safetyReason: clean(parsed.reason),
                turnIndex: conversation.turnIndex,
                decision: conversation.decision,
                stopReason: safetyStopReason,
                final: true,
                finalize: true
              }
            },
            ownerReport: {
              ...ownerReport,
              selectedSkill,
              runtimeAdapter: 'openclaw',
              conversationKey,
              safetyDecision: parsed.action,
              safetyReason: clean(parsed.reason),
              turnIndex: conversation.turnIndex,
              decision: conversation.decision,
              stopReason: safetyStopReason,
              final: true,
              finalize: true
            }
          }
        }

        const conversation = normalizeConversationControl(parsed?.peerResponse?.metadata ?? item?.request?.params?.metadata ?? {}, {
          defaultTurnIndex: 1,
          defaultDecision: 'done',
          defaultStopReason: ''
        })
        const safePeerReplyText = scrubOutboundText(peerResponseText(parsed.peerResponse))
        const safeOwnerSummary = scrubOutboundText(clean(parsed.ownerSummary || parsed.ownerReport?.summary))
        const updatedConversation = conversationStore?.appendTurn?.({
          conversationKey,
          peerSessionId: item?.peerSessionId || '',
          requestId: clean(item?.request?.id),
          remoteAgentId,
          selectedSkill: parsed.selectedSkill,
          turnIndex: conversation.turnIndex,
          inboundText: displayInboundText,
          replyText: safePeerReplyText,
          decision: conversation.decision,
          stopReason: conversation.stopReason,
          final: conversation.final,
          ownerSummary: safeOwnerSummary
        }) ?? null
        const turnOutline = buildReceiverTurnOutline(updatedConversation?.turns ?? [], conversation.turnIndex)
        const effectiveConversationTurns = Math.max(
          updatedConversation?.turns?.length || 0,
          conversation.turnIndex,
          maxTurnIndexFromOutline(turnOutline)
        ) || 1
        const ownerReport = buildReceiverBaseReport({
          localAgentId,
          remoteAgentId,
          incomingSkillHint,
          selectedSkill: parsed.selectedSkill,
          conversationKey,
          receivedAt,
          inboundText: displayInboundText,
          peerReplyText: safePeerReplyText,
          repliedAt: new Date().toISOString(),
          skillSummary: safeOwnerSummary,
          conversationTurns: effectiveConversationTurns,
          stopReason: conversation.stopReason,
          turnOutline,
          detailsAvailableInInbox: true,
          remoteSentAt,
          language: inferOwnerFacingLanguage(displayInboundText, safePeerReplyText, safeOwnerSummary),
          timeZone: ownerTimeZone,
          localTime: true
        })
        if (conversation.final) {
          conversationStore?.closeConversation?.(updatedConversation?.conversationKey || liveConversation?.conversationKey || conversationKey, safeOwnerSummary)
        }
        return {
          ...parsed,
          peerResponse: {
            ...parsed.peerResponse,
            message: {
              kind: parsed.peerResponse?.message?.kind ?? 'message',
              role: parsed.peerResponse?.message?.role ?? 'agent',
              parts: [{ kind: 'text', text: safePeerReplyText }]
            },
            metadata: {
              ...(parsed.peerResponse?.metadata ?? {}),
              incomingSkillHint,
              conversationKey,
              openclawRunId: runId,
              openclawSessionKey: sessionKey,
              openclawGatewayUrl: gatewayContext.gatewayUrl,
              turnIndex: conversation.turnIndex,
              decision: conversation.decision,
              stopReason: conversation.stopReason,
              final: conversation.final,
              finalize: conversation.final
            }
          },
          ownerReport: {
            ...ownerReport,
            incomingSkillHint,
            selectedSkill: parsed.selectedSkill,
            conversationKey,
            runtimeAdapter: 'openclaw',
            openclawRunId: runId,
            openclawSessionKey: sessionKey,
            openclawGatewayUrl: gatewayContext.gatewayUrl,
            turnIndex: conversation.turnIndex,
            decision: conversation.decision,
            stopReason: conversation.stopReason,
            final: conversation.final,
            finalize: conversation.final
          }
        }
      }), { stage: 'OpenClaw inbound execution' })
    } catch (error) {
      if (clean(error?.runtimeAdapter) === 'openclaw') {
        throw error
      }
      throw wrapOpenClawRuntimeError('inbound execution', error)
    }
  }

  async function pushOwnerReport({
    item,
    selectedSkill,
    ownerReport
  }) {
    const summary = scrubOutboundText(ownerReportText(ownerReport))
    if (!summary) {
      return { delivered: false, attempted: false, mode: 'openclaw', reason: 'empty-owner-report' }
    }

    return retryTransientOpenClawRuntime(async () => withGateway(async (client) => {
      const ownerRoute = await resolveOwnerRoute(client)
      if (!ownerRoute?.channel || !ownerRoute?.to) {
        return { delivered: false, attempted: true, mode: 'openclaw', reason: 'owner-route-not-found' }
      }
      const conversationKey = clean(ownerReport?.conversationKey)
      const reportTurnIndex = clean(ownerReport?.turnIndex)
      const isFinalReport = Boolean(ownerReport?.final)
      const idempotencyKey = stableId(
        'agentsquared-owner',
        isFinalReport && conversationKey
          ? `final:${conversationKey}`
          : conversationKey
            ? `${conversationKey}:${reportTurnIndex || clean(item?.request?.params?.metadata?.turnIndex) || clean(item?.inboundId)}`
            : clean(ownerReport?.openclawRunId) || clean(item?.inboundId) || clean(selectedSkill),
        clean(ownerRoute.sessionKey),
        clean(ownerRoute.channel),
        clean(ownerRoute.to)
      )
      const payload = await requestOpenClaw(client, 'send', {
        to: clean(ownerRoute.to),
        channel: clean(ownerRoute.channel),
        ...(clean(ownerRoute.accountId) ? { accountId: clean(ownerRoute.accountId) } : {}),
        ...(clean(ownerRoute.threadId) ? { threadId: clean(ownerRoute.threadId) } : {}),
        ...(clean(ownerRoute.sessionKey) ? { sessionKey: clean(ownerRoute.sessionKey) } : {}),
        message: summary,
        idempotencyKey
      }, timeoutMs, 'owner report send')
      return {
        delivered: true,
        attempted: true,
        mode: 'openclaw',
        payload,
        ownerRoute,
        idempotencyKey
      }
    }), { stage: 'OpenClaw owner report' })
  }

  return {
    id: 'openclaw',
    mode: 'openclaw',
    transport: 'gateway-ws',
    command: clean(command) || 'openclaw',
    agent: agentName,
    sessionPrefix: clean(sessionPrefix) || 'agentsquared:',
    gatewayUrl: clean(gatewayUrl),
    preflight,
    executeInbound,
    pushOwnerReport
  }
}
