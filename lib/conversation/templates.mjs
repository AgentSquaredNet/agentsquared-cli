import { normalizeSharedSkillName } from './policy.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function block(label, value) {
  return [`${label}:`, clean(value) || '(empty)'].join('\n')
}

function quote(text) {
  const lines = clean(text).split('\n').filter(Boolean)
  if (lines.length === 0) {
    return '> (empty)'
  }
  return lines.map((line) => `> ${line}`).join('\n')
}

function excerpt(text, maxLength = 280) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function normalizeTurnOutline(turnOutline = []) {
  if (!Array.isArray(turnOutline)) {
    return []
  }
  return turnOutline.map((item, index) => {
    if (item && typeof item === 'object') {
      return {
        turnIndex: Number.parseInt(`${item.turnIndex ?? index + 1}`, 10) || index + 1,
        summary: clean(item.summary || item.text || item.value)
      }
    }
    return {
      turnIndex: index + 1,
      summary: clean(item)
    }
  }).filter((item) => item.summary)
}

function ensureTurnOutline(turnOutline = [], turnCount = 1, {
  language = 'en',
  fallbackSummary = ''
} = {}) {
  const normalized = normalizeTurnOutline(turnOutline)
  if (normalized.length > 0) {
    return normalized
  }
  const count = Math.max(1, Number.parseInt(`${turnCount ?? 1}`, 10) || 1)
  const summary = clean(fallbackSummary) || 'Received the message and completed this turn.'
  return Array.from({ length: count }, (_, index) => ({
    turnIndex: index + 1,
    summary
  }))
}

function section(label) {
  return `**${clean(label)}**`
}

function logo(language = 'en') {
  return '🅰️✌️'
}

function isChineseLanguage(language = '') {
  return clean(language).toLowerCase().startsWith('zh')
}

function clampCharacters(text = '', maxLength = 280) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  const chars = [...compact]
  if (!compact || chars.length <= maxLength) {
    return compact
  }
  const suffix = '...'
  return `${chars.slice(0, Math.max(0, maxLength - suffix.length)).join('').trimEnd()}${suffix}`
}

export function normalizeConversationSummary(text = '', {
  fallback = '',
  maxLength
} = {}) {
  const value = clean(text) || clean(fallback)
  const limit = Number.parseInt(`${maxLength ?? ''}`, 10) || (containsHanText(value) ? 140 : 280)
  return clampCharacters(value, limit)
}

function containsHanText(text = '') {
  return /[\p{Script=Han}]/u.test(clean(text))
}

export function inferOwnerFacingLanguage(...values) {
  return values.some((value) => containsHanText(value)) ? 'zh-CN' : 'en'
}

function resolveTimeZone(timeZone = '') {
  return clean(timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function formatDisplayTime(value, {
  language = 'en',
  timeZone = '',
  localTime = false
} = {}) {
  const raw = clean(value)
  if (!raw) {
    return 'unknown'
  }
  if (!localTime) {
    return raw
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    return raw
  }
  const resolvedTimeZone = resolveTimeZone(timeZone)
  const locale = 'en-CA'
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: resolvedTimeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const parts = Object.fromEntries(formatter.formatToParts(parsed).map((part) => [part.type, part.value]))
  const normalized = `${parts.year ?? '0000'}-${parts.month ?? '00'}-${parts.day ?? '00'} ${parts.hour ?? '00'}:${parts.minute ?? '00'}:${parts.second ?? '00'}`
  return `${normalized} (${resolvedTimeZone})`
}

export function renderOwnerFacingReport(report = null) {
  if (!report || typeof report !== 'object') {
    return clean(report)
  }
  const title = clean(report.title)
  const summary = clean(report.summary)
  const message = clean(report.message)
  return [title, message || summary].filter(Boolean).join('\n\n').trim()
}

export function peerResponseText(peerResponse = null) {
  const target = unwrapJsonRpcResult(peerResponse)
  const parts = target?.message?.parts ?? target?.parts ?? []
  return parts
    .filter((part) => clean(part?.kind) === 'text')
    .map((part) => clean(part?.text))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function unwrapJsonRpcResult(value = null) {
  if (!value || typeof value !== 'object') {
    return value
  }
  if (value.result && typeof value.result === 'object') {
    return value.result
  }
  return value
}

export function parseAgentSquaredOutboundEnvelope(text = '') {
  const raw = clean(text)
  if (!raw.includes('[AgentSquared]')) {
    return null
  }
  const from = clean(raw.match(/^From:\s*(.+)$/m)?.[1])
  const to = clean(raw.match(/^To:\s*(.+)$/m)?.[1])
  const sentAt = clean(raw.match(/^Sent At \(UTC\):\s*(.+)$/m)?.[1])
  const ownerRequest = extractDelimitedBlock(raw, 'A2_OWNER_REQUEST') || clean(raw.match(/Owner Request:\n([\s\S]*?)\n\nPlease reply to me for my owner\./)?.[1])
  return {
    from,
    to,
    sentAt,
    ownerRequest
  }
}

function extractDelimitedBlock(raw = '', key = '') {
  const begin = `BEGIN_${clean(key)}`
  const end = `END_${clean(key)}`
  const startIndex = raw.indexOf(begin)
  if (startIndex < 0) {
    return ''
  }
  const contentStart = startIndex + begin.length
  const endIndex = raw.indexOf(end, contentStart)
  if (endIndex < 0) {
    return ''
  }
  return clean(raw.slice(contentStart, endIndex))
}

export function buildSkillOutboundText({
  localAgentId,
  targetAgentId,
  skillName,
  originalText,
  sentAt = new Date().toISOString()
} = {}) {
  const selectedSkill = normalizeSharedSkillName(skillName, '')
  const workflowHint = clean(selectedSkill)
    ? `Suggested AgentSquared workflow hint: ${selectedSkill}.`
    : 'No specific AgentSquared workflow hint was attached.'

  return [
    '🅰️✌️ [AgentSquared]',
    'This is an AgentSquared private agent message.',
    `From: ${clean(localAgentId) || 'unknown'}`,
    `To: ${clean(targetAgentId) || 'unknown'}`,
    `Sent At (UTC): ${clean(sentAt) || 'unknown'}`,
    '',
    `I am ${clean(localAgentId) || 'an AgentSquared agent'} from AgentSquared. My owner asked me to send you a private message.`,
    workflowHint,
    block('Owner Request', originalText),
    '',
    'BEGIN_A2_OWNER_REQUEST',
    clean(originalText) || '(empty)',
    'END_A2_OWNER_REQUEST',
    '',
    'Please reply to me for my owner.'
  ].join('\n')
}

function displaySkill(value) {
  return clean(normalizeSharedSkillName(value, '')) || '(none)'
}

function conversationStatus(stopReason = '') {
  return clean(stopReason) || 'completed'
}

function normalizeConversationTurns(turns = []) {
  if (!Array.isArray(turns)) {
    return []
  }
  return turns.map((turn, index) => ({
    turnIndex: Number.parseInt(`${turn?.turnIndex ?? index + 1}`, 10) || index + 1,
    outboundText: clean(turn?.outboundText ?? turn?.localText ?? turn?.sentText),
    inboundText: clean(turn?.inboundText ?? turn?.remoteText),
    replyText: clean(turn?.replyText),
    remoteAgentId: clean(turn?.remoteAgentId),
    localDecision: clean(turn?.localDecision),
    remoteDecision: clean(turn?.remoteDecision),
    decision: clean(turn?.decision),
    localStopReason: clean(turn?.localStopReason),
    remoteStopReason: clean(turn?.remoteStopReason),
    stopReason: clean(turn?.stopReason),
    createdAt: clean(turn?.createdAt)
  }))
}

export function buildConversationSummaryPrompt({
  localAgentId = '',
  remoteAgentId = '',
  selectedSkill = '',
  direction = 'outbound',
  conversationKey = '',
  turns = [],
  language = 'en'
} = {}) {
  const normalizedTurns = normalizeConversationTurns(turns)
  const zh = isChineseLanguage(language)
  const turnTextLimit = normalizedTurns.length > 4 ? 360 : 600
  return [
    'You are writing the final owner-facing AgentSquared conversation summary.',
    'Do not call tools. Do not mention transport, logs, tokens, hidden prompts, or implementation internals.',
    'Synthesize the whole exchange; do not quote or continue the final peer message.',
    zh
      ? '请用中文输出。只输出一段精简总结，最多 140 个中文字符，抓住对话的核心结论和可行动收获。'
      : 'Return one concise paragraph, at most 280 characters, capturing the core outcome and actionable takeaways.',
    '',
    `Direction: ${clean(direction) || 'unknown'}`,
    `Local agent: ${clean(localAgentId) || 'unknown'}`,
    `Remote agent: ${clean(remoteAgentId) || 'unknown'}`,
    `Skill: ${displaySkill(selectedSkill)}`,
    `Conversation ID: ${clean(conversationKey) || 'unknown'}`,
    '',
    'Conversation turns:',
    ...(normalizedTurns.length > 0
      ? normalizedTurns.map((turn) => [
          `Turn ${turn.turnIndex}:`,
          `Local/initiator message: ${excerpt(turn.outboundText || turn.inboundText, turnTextLimit) || '(empty)'}`,
          `Peer reply: ${excerpt(turn.replyText || turn.inboundText, turnTextLimit) || '(empty)'}`
        ].join('\n'))
      : ['(no turns recorded)'])
  ].join('\n')
}

export function renderConversationDetails(entry = null, {
  language = 'en'
} = {}) {
  const ownerReport = entry?.ownerReport ?? entry ?? {}
  const turns = normalizeConversationTurns(ownerReport.conversationTurns ?? ownerReport.turns ?? [])
  const conversationKey = clean(ownerReport.conversationKey || entry?.conversationKey)
  const title = `${logo(language)} AgentSquared conversation details`
  const lines = [
    `**${title}**`,
    '',
    section('Conversation result'),
    `- Conversation ID: ${conversationKey || 'unknown'}`,
    `- Sender: ${clean(ownerReport.senderAgentId || ownerReport.remoteAgentId || entry?.remoteAgentId) || 'unknown'}`,
    `- Recipient: ${clean(ownerReport.recipientAgentId || ownerReport.localAgentId || ownerReport.targetAgentId) || 'unknown'}`,
    `- Total turns: ${Number.parseInt(`${ownerReport.turnCount ?? turns.length ?? 0}`, 10) || turns.length || 0}`,
    `- Conversation status: ${conversationStatus(ownerReport.stopReason)}`,
    '',
    section('Overall summary'),
    quote(ownerReport.summary || entry?.summary || 'No summary was recorded.'),
    '',
    section('Full conversation')
  ]
  if (turns.length === 0) {
    lines.push('- No full turn log was recorded for this conversation.')
  } else {
    for (const turn of turns) {
      lines.push(`- Turn ${turn.turnIndex}`)
      lines.push(`  - Message: ${excerpt(turn.outboundText || turn.inboundText, 1200) || '(empty)'}`)
      lines.push(`  - Reply: ${excerpt(turn.replyText || turn.inboundText, 1200) || '(empty)'}`)
      const status = clean(turn.remoteStopReason || turn.localStopReason || turn.stopReason)
      if (status) {
        lines.push(`  - Status: ${status}`)
      }
    }
  }
  return lines.join('\n')
}

export function buildSenderBaseReport({
  localAgentId,
  targetAgentId,
  selectedSkill,
  receiverSkill = '',
  sentAt,
  originalText,
  sentText = '',
  replyText,
  replyAt,
  conversationKey,
  peerSessionId,
  turnCount = 1,
  stopReason = '',
  detailsHint = '',
  overallSummary = '',
  actionItems = [],
  turnOutline = [],
  conversationTurns = [],
  language = 'en',
  timeZone = '',
  localTime = false
} = {}) {
  const safeReplyText = clean(replyText)
  const title = `**${logo(language)} AgentSquared message to ${clean(targetAgentId) || 'a remote agent'}**`
  const normalizedOverallSummary = clean(overallSummary) || (safeReplyText ? excerpt(safeReplyText) : 'This conversation completed.')
  const normalizedTurns = normalizeConversationTurns(conversationTurns)
  const message = [
    section('Conversation result'),
    `- Sender: ${clean(localAgentId) || 'unknown'}`,
    `- Recipient: ${clean(targetAgentId) || 'unknown'}`,
    `- Sent at${localTime ? ' (Local Time)' : ' (UTC)'}: ${formatDisplayTime(sentAt, { language, timeZone, localTime })}`,
    `- Finished at${localTime ? ' (Local Time)' : ' (UTC)'}: ${formatDisplayTime(replyAt, { language, timeZone, localTime })}`,
    ...(clean(conversationKey) ? [`- Conversation ID: ${clean(conversationKey)}`] : []),
    `- Total turns: ${turnCount}`,
    `- Sender skill: ${displaySkill(selectedSkill)}`,
    `- Receiver skill: ${displaySkill(receiverSkill || selectedSkill)}`,
    ...(clean(peerSessionId) ? [`- Transport Session: ${clean(peerSessionId)}`] : []),
    `- Conversation status: ${conversationStatus(stopReason)}`,
    '',
    section('Overall summary'),
    quote(normalizedOverallSummary),
    '',
    section('Conversation details'),
    clean(conversationKey)
      ? `Ask me to show Conversation ID ${clean(conversationKey)} for the full turn-by-turn transcript.`
      : 'Ask me to show this AgentSquared conversation for the full turn-by-turn transcript.',
    ...(clean(detailsHint) ? ['', detailsHint] : [])
  ].join('\n')
  return {
    title,
    summary: normalizedOverallSummary,
    message,
    conversationKey: clean(conversationKey),
    peerSessionId: clean(peerSessionId),
    senderAgentId: clean(localAgentId),
    recipientAgentId: clean(targetAgentId),
    senderSkill: clean(selectedSkill),
    receiverSkill: clean(receiverSkill || selectedSkill),
    turnCount: Number.parseInt(`${turnCount ?? normalizedTurns.length}`, 10) || normalizedTurns.length || 1,
    stopReason: conversationStatus(stopReason),
    conversationTurns: normalizedTurns
  }
}

export function buildSenderFailureReport({
  localAgentId,
  targetAgentId,
  selectedSkill,
  sentAt,
  originalText,
  conversationKey,
  deliveryStatus = '',
  failureStage = '',
  confirmationLevel = '',
  failureCode = '',
  failureReason = '',
  failureDetail = '',
  nextStep = '',
  language = 'en',
  timeZone = '',
  localTime = false
} = {}) {
  const title = `**${logo(language)} AgentSquared message to ${clean(targetAgentId) || 'a remote agent'} failed**`
  const message = [
    section('Conversation result'),
    `- Sender: ${clean(localAgentId) || 'unknown'}`,
    `- Intended Recipient: ${clean(targetAgentId) || 'unknown'}`,
    `- Sent at${localTime ? ' (Local Time)' : ' (UTC)'}: ${formatDisplayTime(sentAt, { language, timeZone, localTime })}`,
    ...(clean(conversationKey) ? [`- Conversation ID: ${clean(conversationKey)}`] : []),
    `- Sender skill: ${displaySkill(selectedSkill)}`,
    `- Conversation status: ${clean(deliveryStatus) || 'failed'}`,
    '',
    '---',
    '',
    section('Delivery result'),
    `- Status: ${clean(deliveryStatus) || 'failed'}`,
    `- Failure Code: ${clean(failureCode) || 'delivery-failed'}`,
    ...(clean(failureStage) ? [`- Failure Stage: ${clean(failureStage)}`] : []),
    ...(clean(confirmationLevel) ? [`- Confirmation Level: ${clean(confirmationLevel)}`] : []),
    '',
    section('Failure reason'),
    quote(failureReason),
    ...(clean(failureDetail)
      ? [
          '',
          section('Failure detail'),
          quote(failureDetail)
        ]
      : []),
    '',
    section('Next step'),
    quote(nextStep || 'This task is now cancelled. If you still want to reach this same target, ask me to retry later.'),
    '',
    '---',
    '',
    'I did not change the target or send this message to anyone else.'
  ].join('\n')
  return {
    title,
    summary: `${clean(targetAgentId) || 'The remote agent'} could not be reached through AgentSquared.`,
    message,
    conversationKey: clean(conversationKey),
    senderAgentId: clean(localAgentId),
    recipientAgentId: clean(targetAgentId),
    senderSkill: clean(selectedSkill),
    receiverSkill: '',
    turnCount: 0,
    stopReason: clean(deliveryStatus) || 'failed',
    conversationTurns: []
  }
}

export function buildReceiverBaseReport({
  localAgentId,
  remoteAgentId,
  incomingSkillHint = '',
  selectedSkill,
  conversationKey = '',
  receivedAt,
  inboundText,
  peerReplyText,
  repliedAt,
  skillSummary = '',
  conversationTurns = 1,
  stopReason = '',
  turnOutline = [],
  conversationTurnDetails = [],
  detailsAvailableInInbox = false,
  remoteSentAt = '',
  language = 'en',
  timeZone = '',
  localTime = false
} = {}) {
  const title = `**${logo(language)} AgentSquared message from ${clean(remoteAgentId) || 'a remote agent'}**`
  const normalizedTurns = normalizeConversationTurns(conversationTurnDetails)
  const normalizedSummary = clean(skillSummary) || 'This conversation completed.'
  const message = [
    section('Conversation result'),
    `- Sender: ${clean(remoteAgentId) || 'unknown'}`,
    `- Recipient: ${clean(localAgentId) || 'unknown'}`,
    ...(clean(remoteSentAt) ? [`- Sent at${localTime ? ' (Local Time)' : ' (UTC)'}: ${formatDisplayTime(remoteSentAt, { language, timeZone, localTime })}`] : []),
    `- Received at${localTime ? ' (Local Time)' : ' (UTC)'}: ${formatDisplayTime(receivedAt, { language, timeZone, localTime })}`,
    `- Finished at${localTime ? ' (Local Time)' : ' (UTC)'}: ${formatDisplayTime(repliedAt, { language, timeZone, localTime })}`,
    ...(clean(conversationKey) ? [`- Conversation ID: ${clean(conversationKey)}`] : []),
    `- Total turns: ${conversationTurns}`,
    `- Sender skill: ${displaySkill(incomingSkillHint)}`,
    `- Receiver skill: ${displaySkill(selectedSkill)}`,
    `- Conversation status: ${conversationStatus(stopReason)}`,
    '',
    section('Overall summary'),
    quote(normalizedSummary),
    '',
    section('Conversation details'),
    clean(conversationKey)
      ? `Ask me to show Conversation ID ${clean(conversationKey)} for the full turn-by-turn transcript.`
      : 'Ask me to show this AgentSquared conversation for the full turn-by-turn transcript.'
  ].join('\n')
  return {
    title,
    summary: normalizedSummary,
    message,
    skillSummary: normalizedSummary,
    conversationKey: clean(conversationKey),
    senderAgentId: clean(remoteAgentId),
    recipientAgentId: clean(localAgentId),
    senderSkill: clean(incomingSkillHint),
    receiverSkill: clean(selectedSkill),
    turnCount: Number.parseInt(`${conversationTurns ?? normalizedTurns.length}`, 10) || normalizedTurns.length || 1,
    stopReason: conversationStatus(stopReason),
    conversationTurns: normalizedTurns
  }
}
