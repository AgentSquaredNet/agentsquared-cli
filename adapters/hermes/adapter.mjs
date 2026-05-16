import { spawnSync } from 'node:child_process'

import { buildConversationSummaryPrompt, normalizeConversationSummary } from '../../lib/conversation/templates.mjs'
import { buildInboundPlatformContext } from '../../lib/conversation/platform_context.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import { createInboundAdapterPipeline } from '../../lib/runtime/adapter_pipeline.mjs'
import { checkHermesApiServerHealth, extractHermesResponseText, postHermesResponse, postHermesResponseStream } from './api_client.mjs'
import { buildHermesProcessEnv } from './common.mjs'
import { detectHermesHostEnvironment } from './detect.mjs'
import { readHermesEnv } from './env.mjs'
import { ensureHermesApiServerEnv } from './env.mjs'
import { probeHermesMcp, resolveHermesOwnerTargetViaMcp, sendHermesOwnerMessageViaMcp } from './mcp_client.mjs'
import {
  buildHermesCombinedPrompt,
  hermesConversationName,
  HERMES_STRUCTURED_NO_TOOLS_INSTRUCTIONS,
  ownerReportText,
  parseHermesCombinedResult
} from './helpers.mjs'
import {
  createPeerBudget
} from '../../lib/runtime/adapters.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function h2aInboundText(item = null) {
  return clean(item?.request?.params?.message?.parts?.[0]?.text || item?.request?.params?.message?.text || '')
}

function buildH2AStreamInstructions({
  localAgentId = '',
  selectedSkill = '',
  item = null
} = {}) {
  const metadata = item?.request?.params?.metadata ?? {}
  const remoteHuman = clean(metadata.fromHuman || clean(metadata.from).replace(/^human:/, ''))
  const localHuman = clean(localAgentId).includes('@') ? clean(localAgentId).split('@').pop() : ''
  return [
    'You are the local agent replying to a human through AgentSquared H2A.',
    'Do not call tools.',
    'Reply directly to the human in natural language.',
    'Do not wrap the answer in JSON, Markdown metadata, or AgentSquared control fields.',
    'Use the AgentSquared Context in the user input as the authoritative identity and session context.',
    'The senderHuman is the current human user. Address or refer to that person only as senderHuman when a name is needed.',
    'The recipientHuman is the owner of the local agent, not necessarily the person currently chatting.',
    'Never assume the current human user is the recipientHuman or local owner unless senderHuman and recipientHuman are identical.',
    `Local AgentSquared agent: ${clean(localAgentId) || 'unknown'}.`,
    ...(localHuman ? [`Local owner human: @${localHuman}.`] : []),
    ...(remoteHuman ? [`Current human user: @${remoteHuman}.`] : []),
    `Selected skill: ${clean(selectedSkill) || 'human-agent-chat'}.`
  ].join('\n')
}

function buildH2AStreamPrompt({
  localAgentId = '',
  selectedSkill = '',
  item = null,
  conversationTranscript = ''
} = {}) {
  const text = h2aInboundText(item)
  const transcript = clean(conversationTranscript)
  const platformContext = buildInboundPlatformContext({
    localAgentId,
    remoteAgentId: clean(item?.remoteAgentId),
    selectedSkill,
    item,
    messageMethod: clean(item?.request?.method),
    peerSessionId: clean(item?.peerSessionId),
    requestId: clean(item?.request?.id)
  })
  return [
    platformContext,
    transcript ? `Conversation so far:\n${transcript}` : '',
    `Human message:\n${text}`
  ].filter(Boolean).join('\n\n')
}

async function emitTextDelta(emitStreamEvent, {
  delta = '',
  source = ''
} = {}) {
  const text = `${delta ?? ''}`
  if (!text || typeof emitStreamEvent !== 'function') {
    return
  }
  await emitStreamEvent({
    type: 'text_delta',
    delta: text,
    source,
    createdAt: new Date().toISOString()
  })
}

function nowMs() {
  return Date.now()
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function describeHermesRuntimeError(error = null, seen = new Set()) {
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
  const message = clean(error?.message)
  if (message) {
    parts.push(message)
  }
  const code = clean(error?.code)
  if (code && !parts.some((part) => part.includes(code))) {
    parts.push(code)
  }
  const cause = describeHermesRuntimeError(error?.cause, seen)
  if (cause) {
    parts.push(`cause: ${cause}`)
  }
  return [...new Set(parts)].join('; ')
}

function hermesRuntimeUnavailable(error = null) {
  const lower = describeHermesRuntimeError(error).toLowerCase()
  return Boolean(
    lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('fetch failed')
    || lower.includes('api-server-unreachable')
    || lower.includes('socket hang up')
    || lower.includes('timeout')
    || lower.includes('aborterror')
    || lower.includes('network')
  )
}

async function waitForHermesApiHealthy({
  apiBase = '',
  envVars = {},
  timeoutMs = 20000
} = {}) {
  const startedAt = nowMs()
  while (nowMs() - startedAt < timeoutMs) {
    const check = await checkHermesApiServerHealth({
      apiBase,
      envVars,
      timeoutMs: 2500
    })
    if (check.ok) {
      return check
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return {
    ok: false,
    reason: 'timeout'
  }
}

function runHermesGatewayService(command, {
  hermesHome,
  subcommand = 'restart'
} = {}) {
  const env = buildHermesProcessEnv({ hermesHome })
  return spawnSync(command, ['gateway', subcommand], {
    env,
    encoding: 'utf8'
  })
}

function resolveProvidedHermesOwnerTarget({
  ownerReport = null,
  item = null
} = {}) {
  const target = clean(
    ownerReport?.ownerRoute
    || ownerReport?.ownerTarget
    || item?.ownerRoute
    || item?.ownerTarget
  )
  if (!target) {
    return { target: '', source: 'none' }
  }
  return {
    target,
    source: clean(
      ownerReport?.ownerRouteSource
      || ownerReport?.ownerTargetSource
      || item?.ownerRouteSource
      || item?.ownerTargetSource
    ) || 'agentsquared-owner-context',
    sessionId: clean(
      ownerReport?.ownerRouteSessionId
      || ownerReport?.ownerTargetSessionId
      || item?.ownerRouteSessionId
      || item?.ownerTargetSessionId
    )
  }
}

export async function resolveHermesOwnerTarget(hermesHomeOrOptions = '', options = {}) {
  const opts = typeof hermesHomeOrOptions === 'object' && hermesHomeOrOptions !== null
    ? hermesHomeOrOptions
    : {
        ...options,
        hermesHome: hermesHomeOrOptions
      }
  return resolveHermesOwnerTargetViaMcp({
    command: clean(opts.command) || 'hermes',
    hermesHome: clean(opts.hermesHome),
    timeoutMs: Number.parseInt(`${opts.timeoutMs ?? process.env.A2_HERMES_OWNER_REPORT_TIMEOUT_MS ?? 30000}`, 10) || 30000
  })
}

export function createHermesAdapter({
  localAgentId,
  conversationStore = null,
  command = 'hermes',
  hermesHome = '',
  hermesProfile = '',
  apiBase = '',
  timeoutMs = 180000
} = {}) {
  const { consumePeerBudget } = createPeerBudget()

  async function retryTransientHermesRuntime(fn, {
    stage = 'Hermes execution',
    maxAttempts = 3,
    retryDelayMs = 1000
  } = {}) {
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn({ attempt })
      } catch (error) {
        lastError = error
        if (!hermesRuntimeUnavailable(error) || attempt >= maxAttempts) {
          throw error
        }
        console.warn(`${stage} transient runtime failure on attempt ${attempt}/${maxAttempts}: ${describeHermesRuntimeError(error) || error.message}. Retrying after ${retryDelayMs}ms.`)
        try {
          await preflight()
        } catch {
          // best effort; retry below will surface the real error if Hermes is still unavailable
        }
        await sleep(retryDelayMs)
      }
    }
    throw lastError
  }

  async function detectCurrent() {
    return detectHermesHostEnvironment({
      command,
      hermesHome,
      hermesProfile,
      apiBase
    })
  }

  async function preflight() {
    const detection = await detectCurrent()
    if (!detection.detected) {
      return {
        ok: false,
        mode: 'hermes',
        error: 'Hermes is not installed or no Hermes home/profile could be detected.'
      }
    }
    const envResult = ensureHermesApiServerEnv(detection.hermesHome)
    let latest = await detectCurrent()
    const mcpProbe = await probeHermesMcp({
      command: latest.hermesCommand || command,
      hermesHome: latest.hermesHome,
      timeoutMs: 10000
    })
    if (latest.apiServerHealthy && mcpProbe.ok && !envResult.changed) {
      return {
        ok: true,
        mode: 'hermes',
        detection: latest,
        envConfigured: envResult.changed,
        mcp: mcpProbe
      }
    }
    if (latest.gatewayServiceInstalled) {
      const restart = runHermesGatewayService(command, {
        hermesHome: latest.hermesHome,
        subcommand: 'restart'
      })
      latest = await detectCurrent()
      if (!latest.apiServerHealthy && restart.status !== 0) {
        const start = runHermesGatewayService(command, {
          hermesHome: latest.hermesHome,
          subcommand: 'start'
        })
        latest = await detectCurrent()
        if (!latest.apiServerHealthy && start.status !== 0) {
          return {
            ok: false,
            mode: 'hermes',
            error: clean(restart.stderr || restart.stdout || start.stderr || start.stdout)
              || 'Hermes gateway service exists, but restart/start did not make the API server healthy.'
          }
        }
      }
      const health = await waitForHermesApiHealthy({
        apiBase: latest.apiBase,
        envVars: latest.envVars,
        timeoutMs: 20000
      })
      if (health.ok) {
        latest = await detectCurrent()
        const restartedMcpProbe = await probeHermesMcp({
          command: latest.hermesCommand || command,
          hermesHome: latest.hermesHome,
          timeoutMs: 10000
        })
        if (!restartedMcpProbe.ok) {
          return {
            ok: false,
            mode: 'hermes',
            error: `Hermes API server is healthy, but Hermes MCP server is not available: ${restartedMcpProbe.reason}`,
            detection: latest,
            mcp: restartedMcpProbe
          }
        }
        return {
          ok: true,
          mode: 'hermes',
          detection: latest,
          envConfigured: envResult.changed,
          serviceRestarted: true,
          mcp: restartedMcpProbe
        }
      }
      return {
        ok: false,
        mode: 'hermes',
        error: 'Hermes gateway service is installed, but the API server is still not healthy after restart.'
      }
    }
    return {
      ok: false,
      mode: 'hermes',
      error: latest.apiServerHealthy
        ? `Hermes API server is healthy, but Hermes MCP server is not available: ${mcpProbe.reason}`
        : 'Hermes API server is not healthy and no managed Hermes gateway service is installed. AgentSquared has written the required Hermes .env values. Start Hermes gateway manually, then retry.',
      detection: latest,
      mcp: mcpProbe
    }
  }

  async function summarizeConversation(context = {}) {
    return retryTransientHermesRuntime(async () => {
      const detection = await detectCurrent()
      const envVars = readHermesEnv(detection.hermesHome || hermesHome)
      const summaryTimeoutMs = Math.min(Math.max(Number.parseInt(`${timeoutMs ?? 0}`, 10) || 180000, 120000), 180000)
      const payload = await postHermesResponse({
        apiBase: detection.apiBase,
        envVars,
        timeoutMs: summaryTimeoutMs,
        store: false,
        conversation: hermesConversationName('agentsquared:summary', localAgentId, context.remoteAgentId, context.conversationKey),
        instructions: [
          'You are running inside AgentSquared summary generation.',
          'Do not call tools. Return only the concise owner-facing summary text.'
        ].join('\n'),
        input: buildConversationSummaryPrompt({
          localAgentId,
          remoteAgentId: context.remoteAgentId,
          selectedSkill: context.selectedSkill,
          direction: context.direction,
          conversationKey: context.conversationKey,
          turns: context.turns,
          language: context.language
        })
      })
      return normalizeConversationSummary(scrubOutboundText(extractHermesResponseText(payload)))
    }, { stage: 'Hermes conversation summary', maxAttempts: 2 })
  }

  const { executeInbound } = createInboundAdapterPipeline({
    localAgentId,
    runtimeAdapter: 'hermes',
    conversationStore,
    consumePeerBudget,
    summarizeConversation,
    executeWithRuntime: (pipelineBody) => retryTransientHermesRuntime(async () => {
      const detection = await detectCurrent()
      const envVars = detection.envVars || ensureHermesApiServerEnv(detection.hermesHome).envVars
      return pipelineBody({ detection, envVars })
    }, { stage: 'Hermes inbound execution' }),
    displayInboundText: ({ inboundText, inboundMetadata, inboundConversation }) => (
      inboundConversation.turnIndex > 1
        ? inboundText
        : (clean(inboundMetadata.originalOwnerText) || inboundText)
    ),
    remoteSentAt: ({ inboundMetadata }) => clean(inboundMetadata.sentAt),
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
      const { detection, envVars } = runtimeContext
      const hermesConversation = hermesConversationName('agentsquared:work', localAgentId, remoteAgentId, conversationKey, `${conversationControl.turnIndex}`)
      const taskPayload = await postHermesResponse({
        apiBase: detection.apiBase,
        envVars,
        timeoutMs,
        instructions: HERMES_STRUCTURED_NO_TOOLS_INSTRUCTIONS,
        conversation: hermesConversation,
        input: buildHermesCombinedPrompt({
          localAgentId,
          remoteAgentId,
          selectedSkill,
          item,
          conversationTranscript,
          senderSkillInventory: clean(metadata?.localSkillInventory)
        })
      })
      const parsed = parseHermesCombinedResult(taskPayload, {
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
          hermesConversation,
          hermesApiBase: detection.apiBase
        }
      }
    },
    runH2AStream: async ({
      runtimeContext,
      item,
      selectedSkill,
      conversationKey,
      conversationControl,
      conversationTranscript,
      defaultDecision,
      defaultStopReason,
      inboundId,
      emitStreamEvent
    }) => {
      const { detection, envVars } = runtimeContext
      const hermesConversation = hermesConversationName('agentsquared:h2a-stream', localAgentId, 'human', conversationKey, `${conversationControl.turnIndex}`)
      let streamedText = ''
      const payload = await postHermesResponseStream({
        apiBase: detection.apiBase,
        envVars,
        timeoutMs,
        instructions: buildH2AStreamInstructions({ localAgentId, selectedSkill, item }),
        conversation: hermesConversation,
        input: buildH2AStreamPrompt({ localAgentId, selectedSkill, item, conversationTranscript }),
        onTextDelta: (delta) => {
          streamedText += `${delta ?? ''}`
          return emitTextDelta(emitStreamEvent, { delta, source: 'hermes' })
        }
      })
      const replyText = scrubOutboundText(extractHermesResponseText(payload))
      if (!streamedText && replyText) {
        await emitTextDelta(emitStreamEvent, { delta: replyText, source: 'hermes' })
      } else if (streamedText && replyText.startsWith(streamedText) && replyText.length > streamedText.length) {
        await emitTextDelta(emitStreamEvent, { delta: replyText.slice(streamedText.length), source: 'hermes' })
      }
      return {
        parsed: {
          action: 'allow',
          selectedSkill,
          peerResponse: {
            message: {
              kind: 'message',
              role: 'agent',
              parts: [{ kind: 'text', text: replyText }]
            },
            metadata: {
              turnIndex: conversationControl.turnIndex,
              decision: defaultDecision,
              stopReason: defaultStopReason,
              final: defaultDecision === 'done',
              finalize: defaultDecision === 'done'
            }
          },
          ownerSummary: replyText
        },
        runtimeMetadata: {
          hermesConversation,
          hermesApiBase: detection.apiBase,
          stream: true,
          inboundId
        }
      }
    }
  })

  async function pushOwnerReport({
    item,
    ownerReport
  } = {}) {
    const summary = scrubOutboundText(ownerReportText(ownerReport))
    if (!summary) {
      return {
        delivered: false,
        attempted: false,
        mode: 'hermes',
        reason: 'empty-owner-report'
      }
    }
    return retryTransientHermesRuntime(async () => {
      const detection = await detectCurrent()
      const hermesCommand = detection.hermesCommand || command
      const providedTarget = resolveProvidedHermesOwnerTarget({ ownerReport, item })
      const target = providedTarget.target
        ? providedTarget
        : await resolveHermesOwnerTarget({
            command: hermesCommand,
            hermesHome: detection.hermesHome,
            timeoutMs: Number.parseInt(process.env.A2_HERMES_OWNER_REPORT_TIMEOUT_MS ?? '30000', 10) || 30000
          })
      if (!target.target) {
        return {
          delivered: false,
          attempted: true,
          mode: 'hermes',
          reason: 'owner-route-not-found'
        }
      }
      const delivery = await sendHermesOwnerMessageViaMcp({
        hermesHome: detection.hermesHome,
        command: hermesCommand,
        target: target.target,
        message: summary,
        timeoutMs: Number.parseInt(process.env.A2_HERMES_OWNER_REPORT_TIMEOUT_MS ?? '30000', 10) || 30000
      })
      return {
        ...delivery,
        mode: 'hermes',
        ownerRoute: target.target,
        ownerRouteSource: target.source,
        ownerRouteSessionId: target.sessionId || ''
      }
    }, { stage: 'Hermes owner report' })
  }

  return {
    id: 'hermes',
    mode: 'hermes',
    transport: 'api-server',
    command: clean(command) || 'hermes',
    hermesHome: clean(hermesHome),
    apiBase: clean(apiBase),
    preflight,
    executeInbound,
    pushOwnerReport,
    summarizeConversation
  }
}
