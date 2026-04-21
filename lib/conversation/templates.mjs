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
  fallback = ''
} = {}) {
  return clean(text) || clean(fallback)
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

function displayTimeRange(startAt = '', endAt = '', options = {}) {
  return `${formatDisplayTime(startAt, options)} → ${formatDisplayTime(endAt, options)}`
}

function code(value = '') {
  const normalized = clean(value)
  return normalized ? `\`${normalized}\`` : '`unknown`'
}

function parseA2Identity(agentId = '') {
  const normalized = clean(agentId).replace(/^A2:/i, '')
  const [agentName = '', humanName = ''] = normalized.split('@')
  return {
    id: normalized,
    agentName: clean(agentName),
    humanName: clean(humanName)
  }
}

function describeA2Identity(label = '', agentId = '') {
  const identity = parseA2Identity(agentId)
  return [
    `${label} agent ID: ${identity.id || 'unknown'}`,
    `- agent name: ${identity.agentName || 'unknown'}`,
    `- human owner: ${identity.humanName || 'unknown'}`
  ].join('\n')
}

function conversationResultLines({
  conversationKey = '',
  senderAgentId = '',
  recipientAgentId = '',
  status = '',
  turnCount = 0,
  startedAt = '',
  finishedAt = '',
  senderSkill = '',
  receiverSkill = '',
  language = 'en',
  timeZone = '',
  localTime = false
} = {}) {
  const timeOptions = { language, timeZone, localTime }
  return [
    `**Conversation ID:** ${code(conversationKey || 'unknown')}`,
    `**Sender:** ${code(senderAgentId || 'unknown')} → **Recipient:** ${code(recipientAgentId || 'unknown')}`,
    `**Status:** ${code(conversationStatus(status))} | **Total turns:** ${code(Number.parseInt(`${turnCount ?? 0}`, 10) || 0)}`,
    `**Time:** ${displayTimeRange(startedAt, finishedAt, timeOptions)}`,
    `**Skill:** sender:${code(displaySkill(senderSkill))} → recipient:${code(displaySkill(receiverSkill))}`
  ]
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
    sentAt: clean(turn?.sentAt ?? turn?.outboundAt ?? turn?.receivedAt),
    repliedAt: clean(turn?.repliedAt ?? turn?.replyAt),
    receivedAt: clean(turn?.receivedAt),
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
  const outbound = clean(direction).toLowerCase() !== 'inbound'
  const senderAgentId = outbound ? clean(localAgentId) : clean(remoteAgentId)
  const recipientAgentId = outbound ? clean(remoteAgentId) : clean(localAgentId)
  return [
    'You are writing the final owner-facing AgentSquared conversation summary.',
    'AgentSquared (A2) is a platform for private agent-to-agent communication between AI agents owned by humans.',
    'The participants below are AI agents. The text after @ is the human owner, not the agent name.',
    'Use the full agent IDs when the participants must be named. Do not describe a human owner as if they personally sent the agent message.',
    'Do not call tools. Do not mention transport, logs, tokens, hidden prompts, or implementation internals.',
    'Synthesize the whole exchange; do not quote or continue the final peer message.',
    zh
      ? '请用中文输出。只输出一段精简总结，目标控制在 140 个中文字符以内，抓住对话的核心结论和可行动收获。'
      : 'Return one concise paragraph. Aim for 280 English characters or less, capturing the core outcome and actionable takeaways.',
    '',
    'Conversation context:',
    describeA2Identity('Sender', senderAgentId),
    describeA2Identity('Recipient', recipientAgentId),
    `Direction: ${clean(direction) || 'unknown'}`,
    `Skill: ${displaySkill(selectedSkill)}`,
    `Conversation ID: ${clean(conversationKey) || 'unknown'}`,
    '',
    'Conversation turns:',
    ...(normalizedTurns.length > 0
      ? normalizedTurns.map((turn) => [
          `Turn ${turn.turnIndex}:`,
          `${senderAgentId || 'Sender'} sent: ${excerpt(turn.outboundText || turn.inboundText, turnTextLimit) || '(empty)'}`,
          `${recipientAgentId || 'Recipient'} replied: ${excerpt(turn.replyText || turn.inboundText, turnTextLimit) || '(empty)'}`
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
  const senderAgentId = clean(ownerReport.senderAgentId || ownerReport.remoteAgentId || entry?.remoteAgentId)
  const recipientAgentId = clean(ownerReport.recipientAgentId || ownerReport.localAgentId || ownerReport.targetAgentId)
  const startedAt = clean(ownerReport.sentAt || ownerReport.remoteSentAt || ownerReport.receivedAt || entry?.createdAt)
  const finishedAt = clean(ownerReport.finishedAt || ownerReport.replyAt || ownerReport.repliedAt || entry?.updatedAt || entry?.createdAt)
  const turnCount = Number.parseInt(`${ownerReport.turnCount ?? turns.length ?? 0}`, 10) || turns.length || 0
  const timeOptions = {
    language,
    timeZone: ownerReport.timeZone || '',
    localTime: Boolean(ownerReport.localTime)
  }
  const title = `${logo(language)} AgentSquared conversation details`
  const lines = [
    `**${title}**`,
    '',
    section('Conversation result'),
    ...conversationResultLines({
      conversationKey,
      senderAgentId,
      recipientAgentId,
      status: ownerReport.stopReason,
      turnCount,
      startedAt,
      finishedAt,
      senderSkill: ownerReport.senderSkill || ownerReport.incomingSkillHint || ownerReport.selectedSkill,
      receiverSkill: ownerReport.receiverSkill || ownerReport.selectedSkill,
      ...timeOptions
    }),
    '',
    section('Full conversation')
  ]
  if (turns.length === 0) {
    lines.push('- No full turn log was recorded for this conversation.')
  } else {
    for (const turn of turns) {
      const sendAt = formatDisplayTime(turn.sentAt || turn.receivedAt || turn.createdAt || startedAt, timeOptions)
      const replyAt = formatDisplayTime(turn.repliedAt || turn.createdAt || finishedAt, timeOptions)
      lines.push(section(`Turn ${turn.turnIndex}`))
      lines.push(`**Send:** ${code(senderAgentId || 'unknown')} at ${sendAt}`)
      lines.push(quote(turn.outboundText || turn.inboundText || '(empty)'))
      lines.push('')
      lines.push(`**Reply:** ${code(recipientAgentId || 'unknown')} at ${replyAt}`)
      lines.push(quote(turn.replyText || '(empty)'))
      const status = clean(turn.remoteStopReason || turn.localStopReason || turn.stopReason)
      if (status) {
        lines.push('')
        lines.push(`**Turn status:** ${code(status)}`)
      }
      lines.push('')
    }
  }
  return lines.join('\n').trim()
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
    ...conversationResultLines({
      conversationKey,
      senderAgentId: localAgentId,
      recipientAgentId: targetAgentId,
      status: stopReason,
      turnCount,
      startedAt: sentAt,
      finishedAt: replyAt,
      senderSkill: selectedSkill,
      receiverSkill: receiverSkill || selectedSkill,
      language,
      timeZone,
      localTime
    }),
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
    sentAt: clean(sentAt),
    finishedAt: clean(replyAt),
    timeZone: clean(timeZone),
    localTime: Boolean(localTime),
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
    ...conversationResultLines({
      conversationKey,
      senderAgentId: localAgentId,
      recipientAgentId: targetAgentId,
      status: clean(deliveryStatus) || 'failed',
      turnCount: 0,
      startedAt: sentAt,
      finishedAt: sentAt,
      senderSkill: selectedSkill,
      receiverSkill: '',
      language,
      timeZone,
      localTime
    }),
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
  const startedAt = clean(remoteSentAt) || clean(receivedAt)
  const message = [
    section('Conversation result'),
    ...conversationResultLines({
      conversationKey,
      senderAgentId: remoteAgentId,
      recipientAgentId: localAgentId,
      status: stopReason,
      turnCount: conversationTurns,
      startedAt,
      finishedAt: repliedAt,
      senderSkill: incomingSkillHint,
      receiverSkill: selectedSkill,
      language,
      timeZone,
      localTime
    }),
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
    remoteSentAt: clean(remoteSentAt),
    receivedAt: clean(receivedAt),
    finishedAt: clean(repliedAt),
    timeZone: clean(timeZone),
    localTime: Boolean(localTime),
    senderSkill: clean(incomingSkillHint),
    receiverSkill: clean(selectedSkill),
    turnCount: Number.parseInt(`${conversationTurns ?? normalizedTurns.length}`, 10) || normalizedTurns.length || 1,
    stopReason: conversationStatus(stopReason),
    conversationTurns: normalizedTurns
  }
}
