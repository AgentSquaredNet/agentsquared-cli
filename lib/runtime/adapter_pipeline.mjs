import { buildReceiverBaseReport, inferOwnerFacingLanguage } from '../conversation/templates.mjs'
import { normalizeConversationControl, resolveInboundConversationIdentity } from '../conversation/policy.mjs'
import { scrubOutboundText } from './safety.mjs'
import {
  buildReceiverTurnOutline,
  localOwnerTimeZone,
  maxTurnIndexFromOutline
} from './adapters.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export function inboundMessageParts(item = null) {
  const parts = item?.request?.params?.message?.parts
  if (Array.isArray(parts)) {
    return parts.filter((part) => part && typeof part === 'object')
  }
  const text = clean(item?.request?.params?.message?.text)
  return text ? [{ kind: 'text', text }] : []
}

export function inboundImageParts(item = null) {
  return inboundMessageParts(item).filter((part) => clean(part?.kind || part?.type).toLowerCase() === 'image')
}

export function inboundTextParts(item = null) {
  return inboundMessageParts(item)
    .filter((part) => {
      const kind = clean(part?.kind || part?.type).toLowerCase()
      return kind === '' || kind === 'text'
    })
    .map((part) => clean(part?.text))
    .filter(Boolean)
}

export function defaultInboundText(item = null) {
  const text = inboundTextParts(item).join('\n')
  if (text) {
    return text
  }
  return inboundImageParts(item).length > 0 ? '[Image input]' : ''
}

export function hasInboundImages(item = null) {
  return inboundImageParts(item).length > 0
}

function defaultPeerResponseText(peerResponse = null) {
  return clean(peerResponse?.message?.parts?.[0]?.text || peerResponse?.message?.text)
}

function buildPeerResponse({
  basePeerResponse = null,
  peerReplyText = '',
  metadata = {}
} = {}) {
  return {
    ...(basePeerResponse ?? {}),
    message: {
      kind: basePeerResponse?.message?.kind ?? 'message',
      role: basePeerResponse?.message?.role ?? 'agent',
      parts: [{ kind: 'text', text: clean(peerReplyText) }]
    },
    metadata: {
      ...(basePeerResponse?.metadata ?? {}),
      ...metadata
    }
  }
}

function appendConversationTurn({
  conversationStore = null,
  conversationKey = '',
  item = null,
  remoteAgentId = '',
  selectedSkill = '',
  turnIndex = 1,
  inboundText = '',
  replyText = '',
  decision = 'done',
  stopReason = '',
  final = false,
  ownerSummary = '',
  receivedAt = '',
  repliedAt = ''
} = {}) {
  return conversationStore?.appendTurn?.({
    conversationKey,
    peerSessionId: item?.peerSessionId || '',
    requestId: clean(item?.request?.id),
    remoteAgentId,
    selectedSkill,
    turnIndex,
    inboundText,
    replyText,
    decision,
    stopReason,
    final,
    ownerSummary,
    receivedAt,
    repliedAt
  }) ?? null
}

function buildRateLimitResult({
  localAgentId = '',
  remoteAgentId = '',
  incomingSkillHint = '',
  selectedSkill = '',
  runtimeAdapter = '',
  item = null,
  conversationStore = null,
  conversationKey = '',
  displayInboundText = '',
  receivedAt = '',
  remoteSentAt = '',
  ownerLanguage = 'en',
  ownerTimeZone = 'UTC',
  budget = null,
  extraMetadata = {}
} = {}) {
  const peerReplyText = 'I am pausing this AgentSquared request because this peer has reached the recent conversation window limit. My owner can decide whether to continue later.'
  const conversation = normalizeConversationControl(item?.request?.params?.metadata ?? {}, {
    defaultTurnIndex: 1,
    defaultDecision: 'done',
    defaultStopReason: 'system-error'
  })
  const ownerSummary = `I paused this exchange because the recent peer conversation window was exceeded. Current 10-minute turn count: ${budget?.windowTurns ?? 'unknown'}.`
  const updatedConversation = appendConversationTurn({
    conversationStore,
    conversationKey,
    item,
    remoteAgentId,
    selectedSkill,
    turnIndex: conversation.turnIndex,
    inboundText: displayInboundText,
    replyText: peerReplyText,
    decision: 'done',
    stopReason: 'system-error',
    final: true,
    ownerSummary,
    receivedAt,
    repliedAt: new Date().toISOString()
  })
  const ownerReport = buildReceiverBaseReport({
    localAgentId,
    remoteAgentId,
    incomingSkillHint,
    selectedSkill,
    receivedAt,
    inboundText: displayInboundText,
    peerReplyText,
    repliedAt: new Date().toISOString(),
    skillSummary: ownerSummary,
    conversationTurns: updatedConversation?.turns?.length || conversation.turnIndex,
    stopReason: 'system-error',
    conversationTurnDetails: updatedConversation?.turns ?? [],
    detailsAvailableInInbox: true,
    remoteSentAt,
    language: ownerLanguage,
    timeZone: ownerTimeZone,
    localTime: true
  })
  const metadata = {
    selectedSkill,
    runtimeAdapter,
    conversationKey,
    ...extraMetadata,
    turnIndex: conversation.turnIndex,
    decision: 'done',
    stopReason: 'system-error',
    final: true,
    finalize: true
  }
  return {
    selectedSkill,
    peerResponse: buildPeerResponse({
      peerReplyText,
      metadata
    }),
    ownerReport: {
      ...ownerReport,
      selectedSkill,
      runtimeAdapter,
      conversationKey,
      ...extraMetadata,
      turnIndex: conversation.turnIndex,
      decision: 'done',
      stopReason: 'system-error',
      final: true,
      finalize: true
    }
  }
}

export function createInboundAdapterPipeline({
  localAgentId = '',
  runtimeAdapter = '',
  conversationStore = null,
  consumePeerBudget,
  summarizeConversation,
  executeWithRuntime,
  runCombined,
  runH2AStream = null,
  extractInboundText = defaultInboundText,
  displayInboundText,
  remoteSentAt,
  peerResponseText = defaultPeerResponseText,
  rateLimitMetadata = () => ({}),
  wrapError = null
} = {}) {
  // Shared A2A inbound lifecycle. Runtime adapters provide only host-specific
  // hooks for message extraction, model execution, parsing, and error wrapping.
  async function executeInbound({
    item,
    selectedSkill,
    emitStreamEvent = null
  } = {}) {
    const remoteAgentId = clean(item?.remoteAgentId)
    const inboundMetadata = item?.request?.params?.metadata ?? {}
    const incomingSkillHint = clean(item?.suggestedSkill || inboundMetadata?.skillHint)
    const receivedAt = new Date().toISOString()
    const inboundText = clean(extractInboundText(item))
    const multimodalParts = inboundMessageParts(item)
    const inboundConversation = normalizeConversationControl(inboundMetadata, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: ''
    })
    const normalizedDisplayInboundText = clean(typeof displayInboundText === 'function'
      ? displayInboundText({ item, inboundText, inboundMetadata, inboundConversation })
      : '')
      || (inboundConversation.turnIndex > 1
        ? inboundText
        : (clean(inboundMetadata.originalOwnerText) || inboundText))
    const normalizedRemoteSentAt = clean(typeof remoteSentAt === 'function'
      ? remoteSentAt({ item, inboundText, inboundMetadata, inboundConversation })
      : '')
    const ownerLanguage = inferOwnerFacingLanguage(normalizedDisplayInboundText, inboundText)
    const ownerTimeZone = localOwnerTimeZone()
    const conversationIdentity = resolveInboundConversationIdentity(item)
    const conversationKey = clean(conversationIdentity.conversationKey)

    const pipelineBody = async (runtimeContext = {}) => {
      const metadata = inboundMetadata
      const isH2A = clean(metadata?.channelKind).toLowerCase() === 'h2a'
      const isAPI = clean(metadata?.channelKind).toLowerCase() === 'api'
      const statelessChannel = isH2A || isAPI
      const effectiveConversationStore = statelessChannel ? null : conversationStore
      const budget = consumePeerBudget?.({ remoteAgentId }) ?? { overBudget: false, windowTurns: 0 }
      if (budget.overBudget) {
        const rateLimited = buildRateLimitResult({
          localAgentId,
          remoteAgentId,
          incomingSkillHint,
          selectedSkill,
          runtimeAdapter,
          item,
          conversationStore: effectiveConversationStore,
          conversationKey,
          displayInboundText: normalizedDisplayInboundText,
          receivedAt,
          remoteSentAt: normalizedRemoteSentAt,
          ownerLanguage,
          ownerTimeZone,
          budget,
          extraMetadata: typeof rateLimitMetadata === 'function' ? rateLimitMetadata({ budget }) : {}
        })
        return statelessChannel ? { ...rateLimited, ownerReport: null } : rateLimited
      }

      const existingConversation = effectiveConversationStore?.getConversation?.(conversationKey) ?? null
      const h2aDefaultTurnIndex = Math.max(1, (existingConversation?.turns?.length || 0) + 1)
      const conversationControl = normalizeConversationControl(inboundMetadata, {
        defaultTurnIndex: isH2A ? h2aDefaultTurnIndex : 1,
        defaultDecision: 'done',
        defaultStopReason: ''
      })
      if (!isH2A && !isAPI && conversationControl.turnIndex === 1) {
        effectiveConversationStore?.endConversation?.(conversationKey)
      }
      const liveConversation = effectiveConversationStore?.ensureConversation?.({
        conversationKey,
        peerSessionId: item?.peerSessionId || '',
        remoteAgentId,
        selectedSkill
      }) ?? null
      const conversationTranscript = statelessChannel ? '' : (effectiveConversationStore?.transcript?.(liveConversation?.conversationKey || conversationKey) ?? '')
      const localSkillMaxTurns = Math.max(1, Number.parseInt(`${metadata?.localSkillMaxTurns ?? item?.localSkill?.maxTurns ?? 1}`, 10) || 1)
      const defaultShouldContinue = !statelessChannel
        && !conversationControl.final
        && conversationControl.turnIndex < localSkillMaxTurns
      const streamEnabled = Boolean(metadata?.stream?.enabled)
      const runRuntime = (isH2A || isAPI) && streamEnabled && typeof runH2AStream === 'function'
        ? runH2AStream
        : runCombined
      const { parsed, runtimeMetadata = {} } = await runRuntime({
        runtimeContext,
        item,
        selectedSkill,
        localAgentId,
        remoteAgentId,
        conversationKey,
        conversationControl,
        conversationTranscript,
        metadata,
        defaultDecision: defaultShouldContinue ? 'continue' : 'done',
        defaultStopReason: conversationControl.final ? 'completed' : '',
        inboundId: clean(item?.inboundId),
        emitStreamEvent,
        multimodalParts
      })

      if (parsed.action !== 'allow') {
        const safetyStopReason = 'safety-block'
        const peerReplyText = scrubOutboundText(peerResponseText(parsed.peerResponse))
        const conversation = normalizeConversationControl(parsed?.peerResponse?.metadata ?? {}, {
          defaultTurnIndex: conversationControl.turnIndex,
          defaultDecision: 'done',
          defaultStopReason: safetyStopReason
        })
        const ownerSummary = clean(parsed.ownerSummary || parsed.ownerReport?.summary)
        const updatedConversation = appendConversationTurn({
          conversationStore: effectiveConversationStore,
          conversationKey,
          item,
          remoteAgentId,
          selectedSkill,
          turnIndex: conversation.turnIndex,
          inboundText: normalizedDisplayInboundText,
          replyText: peerReplyText,
          decision: conversation.decision,
          stopReason: safetyStopReason,
          final: true,
          ownerSummary,
          receivedAt,
          repliedAt: new Date().toISOString()
        })
        const ownerReport = buildReceiverBaseReport({
          localAgentId,
          remoteAgentId,
          incomingSkillHint,
          selectedSkill,
          conversationKey,
          receivedAt,
          inboundText: normalizedDisplayInboundText,
          peerReplyText,
          repliedAt: new Date().toISOString(),
          skillSummary: ownerSummary,
          conversationTurns: updatedConversation?.turns?.length || conversation.turnIndex,
          stopReason: safetyStopReason,
          conversationTurnDetails: updatedConversation?.turns ?? [],
          detailsAvailableInInbox: true,
          remoteSentAt: normalizedRemoteSentAt,
          language: ownerLanguage,
          timeZone: ownerTimeZone,
          localTime: true
        })
        const metadata = {
          selectedSkill,
          runtimeAdapter,
          conversationKey,
          safetyDecision: parsed.action,
          safetyReason: clean(parsed.reason),
          turnIndex: conversation.turnIndex,
          decision: conversation.decision,
          stopReason: safetyStopReason,
          final: true,
          finalize: true
        }
        return {
          selectedSkill,
          peerResponse: buildPeerResponse({
            basePeerResponse: parsed.peerResponse,
            peerReplyText,
            metadata
          }),
          ownerReport: statelessChannel ? null : {
            ...ownerReport,
            selectedSkill,
            runtimeAdapter,
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

      const conversation = normalizeConversationControl(parsed?.peerResponse?.metadata ?? inboundMetadata, {
        defaultTurnIndex: 1,
        defaultDecision: 'done',
        defaultStopReason: ''
      })
      const safePeerReplyText = scrubOutboundText(peerResponseText(parsed.peerResponse))
      const safeOwnerSummary = scrubOutboundText(clean(parsed.ownerSummary || parsed.ownerReport?.summary))
      const updatedConversation = appendConversationTurn({
        conversationStore: effectiveConversationStore,
        conversationKey,
        item,
        remoteAgentId,
        selectedSkill: parsed.selectedSkill,
        turnIndex: conversation.turnIndex,
        inboundText: normalizedDisplayInboundText,
        replyText: safePeerReplyText,
        decision: conversation.decision,
        stopReason: conversation.stopReason,
        final: conversation.final,
        ownerSummary: safeOwnerSummary,
        receivedAt,
        repliedAt: new Date().toISOString()
      })
      const turnOutline = buildReceiverTurnOutline(updatedConversation?.turns ?? [], conversation.turnIndex)
      const effectiveConversationTurns = Math.max(
        updatedConversation?.turns?.length || 0,
        conversation.turnIndex,
        maxTurnIndexFromOutline(turnOutline)
      ) || 1
      const reportLanguage = inferOwnerFacingLanguage(normalizedDisplayInboundText, safePeerReplyText, safeOwnerSummary)
      const summarizedOwnerReport = conversation.final
        ? statelessChannel
          ? safeOwnerSummary
          : await summarizeConversation({
            localAgentId,
            remoteAgentId,
            selectedSkill: parsed.selectedSkill,
            direction: 'inbound',
            conversationKey,
            turns: updatedConversation?.turns ?? [],
            language: reportLanguage
          }).catch(() => safeOwnerSummary)
        : safeOwnerSummary
      const ownerReport = buildReceiverBaseReport({
        localAgentId,
        remoteAgentId,
        incomingSkillHint,
        selectedSkill: parsed.selectedSkill,
        conversationKey,
        receivedAt,
        inboundText: normalizedDisplayInboundText,
        peerReplyText: safePeerReplyText,
        repliedAt: new Date().toISOString(),
        skillSummary: summarizedOwnerReport || safeOwnerSummary,
        conversationTurns: effectiveConversationTurns,
        stopReason: conversation.stopReason,
        turnOutline,
        conversationTurnDetails: updatedConversation?.turns ?? [],
        detailsAvailableInInbox: true,
        remoteSentAt: normalizedRemoteSentAt,
        language: reportLanguage,
        timeZone: ownerTimeZone,
        localTime: true
      })
      if (conversation.final) {
        effectiveConversationStore?.closeConversation?.(updatedConversation?.conversationKey || liveConversation?.conversationKey || conversationKey, safeOwnerSummary)
      }
      const finalMetadata = {
        ...(parsed.peerResponse?.metadata ?? {}),
        incomingSkillHint,
        conversationKey,
        ...runtimeMetadata,
        turnIndex: conversation.turnIndex,
        decision: conversation.decision,
        stopReason: conversation.stopReason,
        final: conversation.final,
        finalize: conversation.final
      }
      return {
        ...parsed,
        peerResponse: buildPeerResponse({
          basePeerResponse: parsed.peerResponse,
          peerReplyText: safePeerReplyText,
          metadata: finalMetadata
        }),
        ownerReport: statelessChannel ? null : {
          ...ownerReport,
          incomingSkillHint,
          selectedSkill: parsed.selectedSkill,
          conversationKey,
          runtimeAdapter,
          ...runtimeMetadata,
          turnIndex: conversation.turnIndex,
          decision: conversation.decision,
          stopReason: conversation.stopReason,
          final: conversation.final,
          finalize: conversation.final
        }
      }
    }

    try {
      return await executeWithRuntime(pipelineBody)
    } catch (error) {
      if (typeof wrapError === 'function') {
        throw wrapError(error)
      }
      throw error
    }
  }

  return { executeInbound }
}
