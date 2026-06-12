import { createInboundAdapterPipeline, defaultInboundText, hasInboundImages } from '../../lib/runtime/adapter_pipeline.mjs'
import { buildConversationSummaryPrompt, normalizeConversationSummary, parseAgentSquaredOutboundEnvelope } from '../../lib/conversation/templates.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import { createPeerBudget } from '../../lib/runtime/adapters.mjs'
import { CodexClient, resolveCodexThreadId } from './client.mjs'
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
  const resolvedCodexPath = clean(codexPath) || '/Applications/Codex.app/Contents/Resources/codex'
  const { consumePeerBudget } = createPeerBudget()

  async function preflight() {
    const client = new CodexClient({ codexPath: resolvedCodexPath, timeoutMs })
    try {
      await client.connect()
      return {
        ok: true,
        transport: 'stdio',
        codexPath: resolvedCodexPath
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
    const client = new CodexClient({ codexPath: resolvedCodexPath, timeoutMs })
    try {
      await client.connect()
      const tempThread = await client.threadStart({ ephemeral: true })
      const tempThreadId = resolveCodexThreadId(tempThread)

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

      const { text: summaryText } = await runCodexTurn(
        client,
        tempThreadId,
        prompt + '\nReturn only the concise owner-facing summary text.',
        { label: 'Codex summarization turn' }
      )
      
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
      const threadId = resolveCodexThreadId(newThread)
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
        threadId = resolveCodexThreadId(existing)
      }
    } catch (error) {
      console.warn(`[Codex Adapter] Warning fetching thread list: ${error.message}`)
    }

    // 2. Resume if exists, else start new
    if (threadId) {
      await client.threadResume(threadId)
    } else {
      const newThread = await client.threadStart()
      threadId = resolveCodexThreadId(newThread)
      if (!threadId) {
        throw new Error('Failed to create new Codex thread.')
      }
      await client.threadNameSet(threadId, threadName)
    }

    return threadId
  }

  async function runCodexTurn(client, threadId, prompt, {
    label = 'Codex turn',
    emitStreamEvent = null
  } = {}) {
    let unsubscribe = () => {}
    let settled = false
    let timer = null
    let text = ''
    let lastTokenUsage = null

    const executionPromise = new Promise((resolve, reject) => {
      function cleanup() {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        unsubscribe()
      }

      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`${label} timed out after ${timeoutMs}ms`))
      }, Math.max(1000, timeoutMs))

      unsubscribe = client.onEvent((event) => {
        if (settled) {
          return
        }
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
          cleanup()
          const turnStatus = event.params?.turn?.status
          if (turnStatus === 'failed') {
            reject(new Error(event.params?.turn?.error?.message || `${label} failed`))
          } else {
            resolve({ text, lastTokenUsage })
          }
        }
      })
    })

    try {
      await client.turnStart(threadId, prompt)
      return await executionPromise
    } catch (error) {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        unsubscribe()
      }
      throw error
    }
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
      const client = new CodexClient({ codexPath: resolvedCodexPath, timeoutMs })
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

      const { text: resultText, lastTokenUsage: finalTokenUsage } = await runCodexTurn(
        client,
        threadId,
        prompt,
        { label: 'Codex combined execution turn' }
      )

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
          codexPath: resolvedCodexPath
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

      const { text: replyText, lastTokenUsage: finalTokenUsage } = await runCodexTurn(
        client,
        threadId,
        prompt,
        {
          label: 'Codex H2A stream turn',
          emitStreamEvent
        }
      )

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
          codexPath: resolvedCodexPath,
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
    codexPath: resolvedCodexPath,
    preflight,
    executeInbound,
    destroySession,
    pushOwnerReport,
    summarizeConversation
  }
}
