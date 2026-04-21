import { withOpenClawGatewayClient } from './ws_client.mjs'
import { buildConversationSummaryPrompt, normalizeConversationSummary, parseAgentSquaredOutboundEnvelope } from '../../lib/conversation/templates.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import { createInboundAdapterPipeline } from '../../lib/runtime/adapter_pipeline.mjs'
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

  async function summarizeConversation(context = {}) {
    return retryTransientOpenClawRuntime(async () => withGateway(async (client) => {
      const summaryTimeoutMs = Math.min(Math.max(Number.parseInt(`${timeoutMs ?? 0}`, 10) || 180000, 120000), 180000)
      const sessionKey = stableId(
        'agentsquared-summary',
        localAgentId,
        context.remoteAgentId,
        context.conversationKey,
        `${context.turns?.length ?? 0}`
      )
      const accepted = await requestOpenClaw(client, 'agent', {
        agentId: agentName,
        sessionKey,
        message: buildConversationSummaryPrompt({
          localAgentId,
          remoteAgentId: context.remoteAgentId,
          selectedSkill: context.selectedSkill,
          direction: context.direction,
          conversationKey: context.conversationKey,
          turns: context.turns,
          language: context.language
        }),
        extraSystemPrompt: [
          OPENCLAW_AGENT_SQUARED_NO_TOOLS_PROMPT,
          'Return only the concise owner-facing summary text.'
        ].join('\n'),
        idempotencyKey: stableId('agentsquared-summary-run', localAgentId, context.conversationKey, `${context.turns?.length ?? 0}`)
      }, timeoutMs, 'conversation summary request', { openclawAgent: agentName, localAgentId })
      const runId = readOpenClawRunId(accepted)
      if (!runId) {
        throw new Error('OpenClaw summary call did not return a runId.')
      }
      const waited = await requestOpenClaw(client, 'agent.wait', {
        runId,
        timeoutMs: summaryTimeoutMs
      }, summaryTimeoutMs + 1000, 'conversation summary wait')
      const history = await requestOpenClaw(client, 'chat.history', {
        sessionKey,
        limit: 6
      }, timeoutMs, 'conversation summary history')
      return normalizeConversationSummary(scrubOutboundText(resolveFinalAssistantResultText({
        waited,
        history,
        runId,
        label: 'OpenClaw conversation summary',
        sessionKey
      })))
    }), { stage: 'OpenClaw conversation summary', maxAttempts: 2 })
  }

  async function resolveOwnerRoute(client) {
    return resolveOwnerRouteFromSessions(await listSessions(client), {
      agentName
    })
  }

  const { executeInbound } = createInboundAdapterPipeline({
    localAgentId,
    runtimeAdapter: 'openclaw',
    conversationStore,
    consumePeerBudget,
    summarizeConversation,
    extractInboundText: (item) => peerResponseText(item?.request?.params?.message),
    displayInboundText: ({ item, inboundText, inboundMetadata, inboundConversation }) => {
      const parsedEnvelope = parseAgentSquaredOutboundEnvelope(inboundText)
      return inboundConversation.turnIndex > 1
        ? inboundText
        : (clean(inboundMetadata.originalOwnerText) || clean(parsedEnvelope?.ownerRequest) || inboundText)
    },
    remoteSentAt: ({ inboundText, inboundMetadata }) => {
      const parsedEnvelope = parseAgentSquaredOutboundEnvelope(inboundText)
      return clean(inboundMetadata.sentAt) || clean(parsedEnvelope?.sentAt)
    },
    peerResponseText,
    rateLimitMetadata: ({ budget }) => ({
      safetyDecision: 'rate-limit',
      safetyReason: 'peer-conversation-window-exceeded',
      windowTurns: budget?.windowTurns
    }),
    executeWithRuntime: (pipelineBody) => retryTransientOpenClawRuntime(
      async () => withGateway(async (client, gatewayContext) => pipelineBody({ client, gatewayContext })),
      { stage: 'OpenClaw inbound execution' }
    ),
    wrapError: (error) => {
      if (clean(error?.runtimeAdapter) === 'openclaw') {
        return error
      }
      return wrapOpenClawRuntimeError('inbound execution', error)
    },
    runCombined: async ({
      runtimeContext,
      item,
      selectedSkill,
      remoteAgentId,
      conversationKey,
      conversationControl,
      conversationTranscript,
      metadata,
      defaultDecision,
      defaultStopReason,
      inboundId
    }) => {
      const { client, gatewayContext } = runtimeContext
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
        idempotencyKey: `agentsquared-agent-${inboundId || randomId('inbound')}`
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
        inboundId,
        defaultTurnIndex: conversationControl.turnIndex,
        defaultDecision,
        defaultStopReason
      })
      return {
        parsed,
        runtimeMetadata: {
          openclawRunId: runId,
          openclawSessionKey: sessionKey,
          openclawGatewayUrl: gatewayContext.gatewayUrl
        }
      }
    }
  })

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
    pushOwnerReport,
    summarizeConversation
  }
}
