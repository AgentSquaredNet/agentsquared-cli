import { createInboundAdapterPipeline, defaultInboundText, hasInboundImages } from '../../lib/runtime/adapter_pipeline.mjs'
import { buildConversationSummaryPrompt, normalizeConversationSummary, parseAgentSquaredOutboundEnvelope } from '../../lib/conversation/templates.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import { createPeerBudget } from '../../lib/runtime/adapters.mjs'
import { CodexClient } from './client.mjs'
import {
  buildCodexCombinedPrompt,
  buildCodexH2AStreamPrompt,
  parseCodexCombinedResult,
  parseCodexTaskResult,
  ownerReportText,
  peerResponseText,
  stableId
} from './helpers.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export function createCodexAdapter({
  localAgentId,
  conversationStore = null,
  codexPath = '/Applications/Codex.app/Contents/Resources/codex',
  timeoutMs = 180000
} = {}) {
  const { consumePeerBudget } = createPeerBudget()

  async function preflight() {
    const client = new CodexClient({ codexPath, timeoutMs })
    try {
      await client.connect()
      return {
        ok: true,
        transport: 'stdio',
        codexPath
      }
    } catch (error) {
      return {
        ok: false,
        transport: 'stdio',
        error: error.message
      }
    } finally {
      await client.close()
    }
  }

  async function summarizeConversation(context = {}) {
    const client = new CodexClient({ codexPath, timeoutMs })
    try {
      await client.connect()
      const tempThread = await client.threadStart({ ephemeral: true })
      const tempThreadId = tempThread?.id || tempThread?.threadId

      if (!tempThreadId) {
        throw new Error('Failed to start temporary thread for summarization.')
      }

      const prompt = buildConversationSummaryPrompt({
        localAgentId,
        remoteAgentId: context.remoteAgentId,
        selectedSkill: context.selectedSkill,
        direction: context.direction,
        conversationKey: context.conversationKey,
        turns: context.turns,
        language: context.language
      })

      const summaryPromise = new Promise((resolve, reject) => {
        let text = ''
        const unsubscribe = client.onEvent((event) => {
          if (event.method === 'item/agentMessage/delta') {
            text += event.params?.delta || event.params?.contentDelta || ''
          }
          if (event.method === 'turn/completed') {
            unsubscribe()
            if (event.params?.turn?.status === 'failed') {
              reject(new Error(event.params?.turn?.error?.message || 'Summarization turn failed'))
            } else {
              resolve(text)
            }
          }
        })
      })

      await client.turnStart(tempThreadId, prompt + '\nReturn only the concise owner-facing summary text.')
      const summaryText = await summaryPromise
      
      return normalizeConversationSummary(scrubOutboundText(summaryText))
    } catch (error) {
      console.warn(`[Codex Summarize] Warning during conversation summary: ${error.message}`)
      return 'Conversation summarized with fallback text.'
    } finally {
      await client.close()
    }
  }

  async function resolveOrCreateThread(client, conversationKey, {
    ephemeral = false
  } = {}) {
    if (ephemeral) {
      const newThread = await client.threadStart({ ephemeral: true })
      const threadId = newThread?.id || newThread?.threadId
      if (!threadId) {
        throw new Error('Failed to create new ephemeral Codex thread.')
      }
      return threadId
    }
    const threadName = `agentsquared:${conversationKey}`
    let threadId = null

    // 1. Fetch recent threads
    try {
      const response = await client.threadList(50)
      const list = Array.isArray(response) ? response : Array.isArray(response?.threads) ? response.threads : []
      const existing = list.find((t) => clean(t.name) === threadName)
      if (existing) {
        threadId = existing.id || existing.threadId
      }
    } catch (error) {
      console.warn(`[Codex Adapter] Warning fetching thread list: ${error.message}`)
    }

    // 2. Resume if exists, else start new
    if (threadId) {
      await client.threadResume(threadId)
    } else {
      const newThread = await client.threadStart()
      threadId = newThread?.id || newThread?.threadId
      if (!threadId) {
        throw new Error('Failed to create new Codex thread.')
      }
      await client.threadNameSet(threadId, threadName)
    }

    return threadId
  }

  const { executeInbound } = createInboundAdapterPipeline({
    localAgentId,
    runtimeAdapter: 'codex',
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
    executeWithRuntime: (pipelineBody) => {
      const client = new CodexClient({ codexPath, timeoutMs })
      return (async () => {
        try {
          await client.connect()
          return await pipelineBody({ client })
        } finally {
          await client.close()
        }
      })()
    },
    wrapError: (error) => {
      const wrapped = new Error(`Codex execution failed: ${error.message}`, { cause: error })
      wrapped.code = 500
      wrapped.a2RuntimeAdapter = 'codex'
      wrapped.a2FailureKind = 'codex-runtime-error'
      wrapped.a2NoFallback = true
      return wrapped
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
      const { client } = runtimeContext
      const channelKind = clean(metadata?.channelKind).toLowerCase()
      
      if (hasInboundImages(item)) {
        const error = new Error('Codex adapter does not support image input yet.')
        error.code = 400
        error.detailCode = 'runtime_multimodal_unsupported'
        throw error
      }

      const threadId = await resolveOrCreateThread(client, conversationKey, {
        ephemeral: channelKind === 'h2a' || channelKind === 'api'
      })
      const prompt = buildCodexCombinedPrompt({
        localAgentId,
        remoteAgentId,
        selectedSkill,
        item,
        conversationTranscript,
        senderSkillInventory: clean(metadata?.localSkillInventory)
      })

      let lastTokenUsage = null
      const executionPromise = new Promise((resolve, reject) => {
        let text = ''
        const unsubscribe = client.onEvent((event) => {
          if (event.method === 'thread/tokenUsage/updated') {
            lastTokenUsage = event.params?.tokenUsage
          }
          if (event.method === 'item/agentMessage/delta') {
            text += event.params?.delta || event.params?.contentDelta || ''
          }
          if (event.method === 'turn/completed') {
            unsubscribe()
            const turnStatus = event.params?.turn?.status
            if (turnStatus === 'failed') {
              const err = new Error(event.params?.turn?.error?.message || 'Codex combined execution turn failed')
              reject(err)
            } else {
              resolve({ text, lastTokenUsage })
            }
          }
        })
      })

      await client.turnStart(threadId, prompt)
      const { text: resultText, lastTokenUsage: finalTokenUsage } = await executionPromise

      const parsed = parseCodexCombinedResult(resultText, {
        defaultSkill: selectedSkill,
        remoteAgentId,
        inboundId,
        defaultTurnIndex: conversationControl.turnIndex,
        defaultDecision,
        defaultStopReason
      })

      if (finalTokenUsage) {
        const last = finalTokenUsage.last || finalTokenUsage.total || {}
        const usage = {
          runtime: 'codex',
          usageMode: 'four_tier',
          accurate: true,
          inputTokens: last.inputTokens ?? 0,
          outputTokens: last.outputTokens ?? 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: last.cachedInputTokens ?? last.cacheReadInputTokens ?? 0
        }
        if (parsed.peerResponse) {
          parsed.peerResponse.usage = usage
          parsed.peerResponse.metadata = {
            ...(parsed.peerResponse.metadata ?? {}),
            usage
          }
        }
        if (parsed.ownerReport) {
          parsed.ownerReport.usage = usage
        }
      }

      return {
        parsed,
        runtimeMetadata: {
          codexThreadId: threadId,
          codexPath
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
      const { client } = runtimeContext
      const channelKind = clean(item?.request?.params?.metadata?.channelKind).toLowerCase()

      if (hasInboundImages(item)) {
        const error = new Error('Codex adapter does not support image input yet.')
        error.code = 400
        error.detailCode = 'runtime_multimodal_unsupported'
        throw error
      }

      const threadId = await resolveOrCreateThread(client, conversationKey, {
        ephemeral: channelKind === 'h2a' || channelKind === 'api'
      })
      const prompt = buildCodexH2AStreamPrompt({
        localAgentId,
        selectedSkill,
        item,
        conversationTranscript,
        conversationControl
      })

      let lastTokenUsage = null
      const executionPromise = new Promise((resolve, reject) => {
        let text = ''
        const unsubscribe = client.onEvent((event) => {
          if (event.method === 'thread/tokenUsage/updated') {
            lastTokenUsage = event.params?.tokenUsage
          }
          if (event.method === 'item/agentMessage/delta') {
            const delta = event.params?.delta || event.params?.contentDelta || ''
            text += delta
            if (delta && typeof emitStreamEvent === 'function') {
              void emitStreamEvent({
                type: 'text_delta',
                delta,
                source: 'codex',
                createdAt: new Date().toISOString()
              })
            }
          }
          if (event.method === 'turn/completed') {
            unsubscribe()
            const turnStatus = event.params?.turn?.status
            if (turnStatus === 'failed') {
              const err = new Error(event.params?.turn?.error?.message || 'Codex H2A stream turn failed')
              reject(err)
            } else {
              resolve({ text, lastTokenUsage })
            }
          }
        })
      })

      await client.turnStart(threadId, prompt)
      const { text: replyText, lastTokenUsage: finalTokenUsage } = await executionPromise

      let usage = null
      if (finalTokenUsage) {
        const last = finalTokenUsage.last || finalTokenUsage.total || {}
        usage = {
          runtime: 'codex',
          usageMode: 'four_tier',
          accurate: true,
          inputTokens: last.inputTokens ?? 0,
          outputTokens: last.outputTokens ?? 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: last.cachedInputTokens ?? last.cacheReadInputTokens ?? 0
        }
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
              finalize: defaultDecision === 'done',
              ...(usage ? { usage } : {})
            },
            ...(usage ? { usage } : {})
          },
          ownerSummary: replyText
        },
        runtimeMetadata: {
          codexThreadId: threadId,
          codexPath,
          stream: true,
          inboundId
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
      return { delivered: false, attempted: false, mode: 'codex', reason: 'empty-owner-report' }
    }
    
    // Codex does not support external IM channels, print locally to system log / stdout
    console.log(`[Codex Owner Report] Summary of skill ${selectedSkill}: \n${summary}`)
    
    return {
      delivered: true,
      attempted: true,
      mode: 'codex',
      reason: 'printed-to-local-console'
    }
  }

  async function destroySession({
    runtimeSessionId = ''
  } = {}) {
    return {
      ok: true,
      mode: 'codex',
      runtimeSessionId: clean(runtimeSessionId),
      reason: 'ephemeral-thread-released-on-client-close'
    }
  }

  return {
    id: 'codex',
    mode: 'codex',
    transport: 'stdio',
    codexPath,
    preflight,
    executeInbound,
    destroySession,
    pushOwnerReport,
    summarizeConversation
  }
}
