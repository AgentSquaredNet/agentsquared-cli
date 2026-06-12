import crypto from 'node:crypto'

import { parseAgentSquaredOutboundEnvelope, renderOwnerFacingReport } from '../../lib/conversation/templates.mjs'
import { buildInboundPlatformContext } from '../../lib/conversation/platform_context.mjs'
import { normalizeConversationControl } from '../../lib/conversation/policy.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function excerpt(text, maxLength = 240) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function textParts(value) {
  if (!value) {
    return []
  }
  if (typeof value === 'string') {
    return [clean(value)].filter(Boolean)
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => textParts(item))
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.parts)) {
      return value.parts.flatMap((part) => textParts(part?.text ?? part?.value ?? part))
    }
    if (typeof value.text === 'string') {
      return [clean(value.text)].filter(Boolean)
    }
    if (typeof value.value === 'string') {
      return [clean(value.value)].filter(Boolean)
    }
    if (typeof value.content === 'string') {
      return [clean(value.content)].filter(Boolean)
    }
    if (Array.isArray(value.content)) {
      return value.content.flatMap((item) => textParts(item))
    }
  }
  return []
}

function flattenText(value) {
  return textParts(value).filter(Boolean).join('\n').trim()
}

function extractJsonBlock(text) {
  const trimmed = clean(text)
  if (!trimmed) {
    throw new Error('Claude Code returned an empty response.')
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1)
  }
  throw new Error(`Claude Code response did not contain a JSON object: ${excerpt(trimmed, 400)}`)
}

function decodeEscapedJsonCandidate(text) {
  const trimmed = clean(text)
  if (!trimmed) {
    return ''
  }
  return trimmed
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function tryParseJsonCandidate(candidate, seen = new Set()) {
  const trimmed = clean(candidate)
  if (!trimmed || seen.has(trimmed)) {
    return null
  }
  seen.add(trimmed)
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'string') {
      return tryParseJsonCandidate(parsed, seen)
    }
    return parsed
  } catch {
    // continue
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    const parsed = tryParseJsonCandidate(fenced[1].trim(), seen)
    if (parsed) return parsed
  }
  const decoded = decodeEscapedJsonCandidate(trimmed)
  if (decoded && decoded !== trimmed) {
    const parsed = tryParseJsonCandidate(decoded, seen)
    if (parsed) return parsed
  }
  return null
}

function parseJsonOutput(text, label = 'Claude Code response') {
  const parsed = tryParseJsonCandidate(text)
  if (parsed && typeof parsed === 'object') {
    return parsed
  }
  try {
    return JSON.parse(extractJsonBlock(text))
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error.message}`)
  }
}

function tryParseJsonOutput(text, label = 'Claude Code response') {
  try {
    return { parsed: parseJsonOutput(text, label) }
  } catch (error) {
    return { parsed: null, error }
  }
}

export function stableId(prefix = 'a2', ...parts) {
  const hash = crypto.createHash('sha256')
  for (const part of parts) {
    hash.update(clean(part))
    hash.update('\n')
  }
  return `${clean(prefix) || 'a2'}-${hash.digest('hex').slice(0, 24)}`
}

export function ownerReportText(ownerReport) {
  if (typeof ownerReport === 'string') {
    return clean(ownerReport)
  }
  if (ownerReport && typeof ownerReport === 'object') {
    return renderOwnerFacingReport(ownerReport) || clean(ownerReport.text || ownerReport.message || ownerReport.summary)
  }
  return ''
}

export function peerResponseText(raw) {
  if (typeof raw === 'string') {
    return clean(raw)
  }
  if (raw && typeof raw === 'object') {
    if (typeof raw.peerResponse === 'string') {
      return clean(raw.peerResponse)
    }
    if (typeof raw.reply === 'string') {
      return clean(raw.reply)
    }
    return flattenText(raw.message ?? raw)
  }
  return ''
}

function buildPlainTextFallback(rawText, {
  defaultSkill = '',
  remoteAgentId = '',
  defaultTurnIndex = 1,
  defaultDecision = 'done',
  defaultStopReason = '',
  parseError = null
} = {}) {
  const selectedSkill = clean(defaultSkill)
  const conversation = normalizeConversationControl({}, {
    defaultTurnIndex,
    defaultDecision,
    defaultStopReason
  })
  const peerText = clean(rawText) || 'I need to pause this AgentSquared exchange because my local Claude Code runtime returned an empty response.'
  const reportText = `${clean(remoteAgentId) || 'A remote Agent'} sent an AgentSquared turn and Claude Code replied in plain text.`
  return {
    action: 'allow',
    selectedSkill,
    peerResponse: {
      message: {
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text: peerText }]
      },
      metadata: {
        selectedSkill,
        modelSelectedSkill: '',
        runtimeAdapter: 'claudecode',
        claudeCodeParseFallback: 'plain-text-task-response',
        claudeCodeParseError: clean(parseError?.message),
        turnIndex: conversation.turnIndex,
        decision: conversation.decision,
        stopReason: conversation.stopReason,
        final: conversation.final,
        finalize: conversation.final
      }
    },
    ownerReport: {
      title: `**AgentSquared message from ${clean(remoteAgentId) || 'a remote agent'}**`,
      summary: reportText,
      message: reportText,
      selectedSkill,
      modelSelectedSkill: '',
      runtimeAdapter: 'claudecode',
      claudeCodeParseFallback: 'plain-text-task-response',
      claudeCodeParseError: clean(parseError?.message),
      turnIndex: conversation.turnIndex,
      decision: conversation.decision,
      stopReason: conversation.stopReason,
      final: conversation.final,
      finalize: conversation.final
    },
    ownerSummary: reportText
  }
}

export function parseClaudeCodeCombinedResult(rawText, {
  defaultSkill = '',
  remoteAgentId = '',
  inboundId = '',
  defaultTurnIndex = 1,
  defaultDecision = 'done',
  defaultStopReason = ''
} = {}) {
  const parseResult = tryParseJsonOutput(rawText, 'Claude Code task result')
  if (!parseResult.parsed) {
    return buildPlainTextFallback(rawText, {
      defaultSkill,
      remoteAgentId,
      defaultTurnIndex,
      defaultDecision,
      defaultStopReason,
      parseError: parseResult.error
    })
  }

  const parsed = parseResult.parsed
  const selectedSkill = clean(defaultSkill)
  const modelSelectedSkill = clean(parsed.selectedSkill)
  const peerText = clean(parsed.peerResponse) || clean(parsed.peerResponseText) || clean(parsed.reply)
  if (!peerText) {
    const fallbackText = 'I need to pause this AgentSquared exchange because my local Claude Code runtime could not produce a safe peer response.'
    const conversation = normalizeConversationControl(parsed, {
      defaultTurnIndex,
      defaultDecision: 'done',
      defaultStopReason: 'system-error'
    })
    return {
      action: 'allow',
      selectedSkill,
      peerResponse: {
        message: {
          kind: 'message',
          role: 'agent',
          parts: [{ kind: 'text', text: fallbackText }]
        },
        metadata: {
          selectedSkill,
          modelSelectedSkill,
          runtimeAdapter: 'claudecode',
          claudeCodeParseFallback: 'missing-peer-response',
          turnIndex: conversation.turnIndex,
          decision: 'done',
          stopReason: 'system-error',
          final: true,
          finalize: true
        }
      },
      ownerReport: {
        summary: fallbackText,
        message: fallbackText,
        selectedSkill,
        modelSelectedSkill,
        runtimeAdapter: 'claudecode',
        claudeCodeParseFallback: 'missing-peer-response',
        turnIndex: conversation.turnIndex,
        decision: 'done',
        stopReason: 'system-error',
        final: true,
        finalize: true
      },
      ownerSummary: fallbackText
    }
  }

  const conversation = normalizeConversationControl(parsed, {
    defaultTurnIndex,
    defaultDecision,
    defaultStopReason
  })
  const reportText = clean(parsed.ownerReport) || clean(parsed.ownerReportText) || `${clean(remoteAgentId) || 'A remote agent'} sent an inbound task and I replied.`
  return {
    action: clean(parsed.action) || 'allow',
    reason: clean(parsed.reason),
    selectedSkill,
    peerResponse: {
      message: {
        kind: 'message',
        role: 'agent',
        parts: [{ kind: 'text', text: peerText }]
      },
      metadata: {
        selectedSkill,
        modelSelectedSkill,
        runtimeAdapter: 'claudecode',
        inboundId: clean(inboundId),
        turnIndex: conversation.turnIndex,
        decision: conversation.decision,
        stopReason: conversation.stopReason,
        final: conversation.final,
        finalize: conversation.final
      }
    },
    ownerReport: {
      summary: reportText,
      message: reportText,
      selectedSkill,
      modelSelectedSkill,
      runtimeAdapter: 'claudecode',
      inboundId: clean(inboundId),
      turnIndex: conversation.turnIndex,
      decision: conversation.decision,
      stopReason: conversation.stopReason,
      final: conversation.final,
      finalize: conversation.final
    },
    ownerSummary: reportText
  }
}

export function buildClaudeCodeCombinedPrompt({
  localAgentId = '',
  remoteAgentId = '',
  selectedSkill = '',
  item = null,
  conversationTranscript = '',
  senderSkillInventory = ''
} = {}) {
  const inboundText = peerResponseText(item?.request?.params?.message)
  const metadata = item?.request?.params?.metadata ?? {}
  const parsedEnvelope = parseAgentSquaredOutboundEnvelope(inboundText)
  const platformContext = buildInboundPlatformContext({
    localAgentId,
    remoteAgentId,
    selectedSkill,
    item,
    messageMethod: clean(item?.request?.method),
    peerSessionId: clean(item?.peerSessionId),
    requestId: clean(item?.request?.id)
  })
  return [
    'You are the local Claude Code host runtime for AgentSquared.',
    'You are serving an AgentSquared agent over A2A, H2A, or API. Respect the selected AgentSquared skill and platform context.',
    'Operate in safe read-only mode. Do not write files, run shell commands, modify notebooks, or call MCP tools.',
    platformContext,
    conversationTranscript ? `Conversation so far:\n${conversationTranscript}` : '',
    senderSkillInventory ? `Local skill inventory:\n${senderSkillInventory}` : '',
    parsedEnvelope?.ownerRequest ? `Original owner request:\n${parsedEnvelope.ownerRequest}` : '',
    `Inbound message:\n${inboundText}`,
    `Selected AgentSquared skill: ${clean(selectedSkill) || 'unknown'}.`,
    'Return exactly one JSON object and no extra text.',
    'Schema:',
    JSON.stringify({
      action: 'allow',
      selectedSkill: clean(selectedSkill),
      peerResponse: 'Text reply to the remote peer or human.',
      ownerReport: 'Concise private summary for the local owner.',
      turnIndex: Number.parseInt(`${metadata.turnIndex ?? 1}`, 10) || 1,
      decision: 'done or continue',
      stopReason: 'completed, system-error, skill-unavailable, or empty when continuing',
      final: true
    }, null, 2)
  ].filter(Boolean).join('\n\n')
}

export function buildClaudeCodeH2AStreamPrompt({
  localAgentId = '',
  selectedSkill = '',
  item = null,
  conversationTranscript = ''
} = {}) {
  const inboundText = peerResponseText(item?.request?.params?.message)
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
    'You are the local Claude Code host runtime replying through AgentSquared H2A/API.',
    'Reply directly in natural language. Do not wrap the answer in JSON.',
    'Operate in safe read-only mode. Do not write files, run shell commands, modify notebooks, or call MCP tools.',
    platformContext,
    conversationTranscript ? `Conversation so far:\n${conversationTranscript}` : '',
    `Selected AgentSquared skill: ${clean(selectedSkill) || 'human-agent-chat'}.`,
    `Message:\n${inboundText}`
  ].filter(Boolean).join('\n\n')
}
