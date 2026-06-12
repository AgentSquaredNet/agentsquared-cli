import { buildConversationSummaryPrompt, normalizeConversationSummary, parseAgentSquaredOutboundEnvelope } from '../../lib/conversation/templates.mjs'
import { createInboundAdapterPipeline, defaultInboundText, hasInboundImages } from '../../lib/runtime/adapter_pipeline.mjs'
import { createPeerBudget } from '../../lib/runtime/adapters.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import { ClaudeCodeClient } from './client.mjs'
import { detectClaudeCodeHostEnvironment } from './detect.mjs'
import {
  buildClaudeCodeCombinedPrompt,
  buildClaudeCodeH2AStreamPrompt,
  ownerReportText,
  parseClaudeCodeCombinedResult,
  peerResponseText
} from './helpers.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export function createClaudeCodeAdapter({
  localAgentId,
  conversationStore = null,
  claudeCommand = 'claude',
  cwd = '',
  model = '',
  timeoutMs = 180000,
  maxTurns = 3,
  settingSources = 'none',
  queryImpl = null
} = {}) {
  const { consumePeerBudget } = createPeerBudget()
  const clientOptions = {
    claudeCommand,
    cwd,
    model,
    timeoutMs,
    maxTurns,
    settingSources,
    queryImpl
  }
  const sessionByConversationKey = new Map()

  function createClient() {
    return new ClaudeCodeClient(clientOptions)
  }

  async function preflight() {
    const detection = await detectClaudeCodeHostEnvironment({
      command: claudeCommand
    })
    return {
      ok: Boolean(detection?.detected && detection?.authHealthy),
      transport: 'sdk',
      claudeCommand: clean(detection?.claudeCommand) || clean(claudeCommand) || 'claude',
      claudeVersion: clean(detection?.claudeVersion),
      authMode: clean(detection?.authStatus?.authMethod),
      reason: clean(detection?.reason),
      error: detection?.authHealthy === false
        ? clean(detection?.authProbe?.stderr || detection?.authProbe?.stdout || detection?.authProbe?.error || 'claude auth status failed')
        : ''
    }
  }

  async function summarizeConversation(context = {}) {
    try {
      const prompt = buildConversationSummaryPrompt({
        localAgentId,
        remoteAgentId: context.remoteAgentId,
        selectedSkill: context.selectedSkill,
        direction: context.direction,
        conversationKey: context.conversationKey,
        turns: context.turns,
        language: context.language
      })
      const result = await createClient().query(
        `${prompt}\nReturn only the concise owner-facing summary text.`,
        { persistSession: false }
      )
      return normalizeConversationSummary(scrubOutboundText(result.text))
    } catch (error) {
      console.warn(`[Claude Code Summarize] Warning during conversation summary: ${error.message}`)
      return 'Conversation summarized with fallback text.'
    }
  }

  const { executeInbound } = createInboundAdapterPipeline({
    localAgentId,
    runtimeAdapter: 'claudecode',
    conversationStore,
    consumePeerBudget,
    summarizeConversation,
    extractInboundText: (item) => peerResponseText(item?.request?.params?.message) || defaultInboundText(item),
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
    executeWithRuntime: (pipelineBody) => pipelineBody({}),
    wrapError: (error) => {
      const wrapped = new Error(`Claude Code execution failed: ${error.message}`, { cause: error })
      wrapped.code = 500
      wrapped.a2RuntimeAdapter = 'claudecode'
      wrapped.a2FailureKind = 'claudecode-runtime-error'
      wrapped.a2NoFallback = true
      return wrapped
    },
    runCombined: async ({
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
      const channelKind = clean(metadata?.channelKind).toLowerCase()
      if (hasInboundImages(item)) {
        const error = new Error('Claude Code adapter does not support image input yet.')
        error.code = 400
        error.detailCode = 'runtime_multimodal_unsupported'
        throw error
      }

      const statelessChannel = channelKind === 'h2a' || channelKind === 'api'
      const resume = statelessChannel ? '' : clean(sessionByConversationKey.get(conversationKey))
      const prompt = buildClaudeCodeCombinedPrompt({
        localAgentId,
        remoteAgentId,
        selectedSkill,
        item,
        conversationTranscript,
        senderSkillInventory: clean(metadata?.localSkillInventory)
      })
      const result = await createClient().query(prompt, {
        resume,
        persistSession: !statelessChannel
      })
      if (!statelessChannel && clean(result.sessionId)) {
        sessionByConversationKey.set(conversationKey, clean(result.sessionId))
      }

      const parsed = parseClaudeCodeCombinedResult(result.text, {
        defaultSkill: selectedSkill,
        remoteAgentId,
        inboundId,
        defaultTurnIndex: conversationControl.turnIndex,
        defaultDecision,
        defaultStopReason
      })
      if (result.usage) {
        if (parsed.peerResponse) {
          parsed.peerResponse.usage = result.usage
          parsed.peerResponse.metadata = {
            ...(parsed.peerResponse.metadata ?? {}),
            usage: result.usage
          }
        }
        if (parsed.ownerReport) {
          parsed.ownerReport.usage = result.usage
        }
      }

      return {
        parsed,
        runtimeMetadata: {
          claudeCodeSessionId: clean(result.sessionId),
          claudeCommand: clean(claudeCommand) || 'claude'
        }
      }
    },
    runH2AStream: async ({
      item,
      selectedSkill,
      conversationControl,
      conversationTranscript,
      defaultDecision,
      defaultStopReason,
      inboundId,
      emitStreamEvent
    }) => {
      if (hasInboundImages(item)) {
        const error = new Error('Claude Code adapter does not support image input yet.')
        error.code = 400
        error.detailCode = 'runtime_multimodal_unsupported'
        throw error
      }
      const prompt = buildClaudeCodeH2AStreamPrompt({
        localAgentId,
        selectedSkill,
        item,
        conversationTranscript
      })
      const result = await createClient().query(prompt, {
        persistSession: false,
        includePartialMessages: true,
        emitDelta: async (delta) => {
          if (!delta || typeof emitStreamEvent !== 'function') {
            return
          }
          await emitStreamEvent({
            type: 'text_delta',
            delta,
            source: 'claudecode',
            createdAt: new Date().toISOString()
          })
        }
      })
      const metadata = {
        turnIndex: conversationControl.turnIndex,
        decision: defaultDecision,
        stopReason: defaultStopReason,
        final: defaultDecision === 'done',
        finalize: defaultDecision === 'done',
        ...(result.usage ? { usage: result.usage } : {})
      }
      return {
        parsed: {
          action: 'allow',
          selectedSkill,
          peerResponse: {
            message: {
              kind: 'message',
              role: 'agent',
              parts: [{ kind: 'text', text: result.text }]
            },
            metadata,
            ...(result.usage ? { usage: result.usage } : {})
          },
          ownerSummary: result.text
        },
        runtimeMetadata: {
          claudeCodeSessionId: clean(result.sessionId),
          claudeCommand: clean(claudeCommand) || 'claude',
          stream: true,
          inboundId
        }
      }
    }
  })

  async function pushOwnerReport({
    selectedSkill,
    ownerReport
  }) {
    const summary = scrubOutboundText(ownerReportText(ownerReport))
    if (!summary) {
      return { delivered: false, attempted: false, mode: 'claudecode', reason: 'empty-owner-report' }
    }
    console.log(`[Claude Code Owner Report] Summary of skill ${selectedSkill}: \n${summary}`)
    return {
      delivered: true,
      attempted: true,
      mode: 'claudecode',
      reason: 'printed-to-local-console'
    }
  }

  async function destroySession({
    runtimeSessionId = ''
  } = {}) {
    return {
      ok: true,
      mode: 'claudecode',
      runtimeSessionId: clean(runtimeSessionId),
      reason: 'ephemeral-channel-complete'
    }
  }

  return {
    id: 'claudecode',
    mode: 'claudecode',
    transport: 'sdk',
    claudeCommand: clean(claudeCommand) || 'claude',
    preflight,
    executeInbound,
    destroySession,
    pushOwnerReport,
    summarizeConversation
  }
}
