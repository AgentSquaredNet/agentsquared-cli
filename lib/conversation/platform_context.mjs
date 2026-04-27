import { normalizeSharedSkillName } from './policy.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function extractDelimitedBlock(raw = '', begin = '', end = '') {
  const start = raw.indexOf(begin)
  if (start < 0) {
    return ''
  }
  const contentStart = start + begin.length
  const finish = raw.indexOf(end, contentStart)
  if (finish < 0) {
    return ''
  }
  return clean(raw.slice(contentStart, finish))
}

export function humanFromAgentId(agentId = '') {
  const value = clean(agentId)
  const at = value.lastIndexOf('@')
  return at >= 0 && at + 1 < value.length ? `@${value.slice(at + 1)}` : ''
}

export function normalizeHumanHandle(value = '') {
  const raw = clean(value)
  if (!raw) {
    return ''
  }
  return raw.startsWith('@') ? raw : `@${raw}`
}

export function platformChannelLabel(channelKind = '') {
  return clean(channelKind).toLowerCase() === 'h2a' ? 'H2A' : 'A2A'
}

export function platformMessageKind(channelKind = '') {
  return platformChannelLabel(channelKind) === 'H2A' ? 'human-to-agent' : 'agent-to-agent'
}

export function buildPlatformContextBlock({
  channelKind = '',
  senderAgent = '',
  senderSurface = '',
  senderHuman = '',
  recipientAgent = '',
  recipientHuman = '',
  skillHint = '',
  conversationKey = '',
  h2aSessionId = '',
  sentAt = '',
  transport = '',
  requestMethod = '',
  peerSessionId = '',
  requestId = ''
} = {}) {
  const channel = platformChannelLabel(channelKind)
  const normalizedSenderAgent = clean(senderAgent)
  const normalizedRecipientAgent = clean(recipientAgent)
  const normalizedSenderHuman = normalizeHumanHandle(senderHuman) || humanFromAgentId(normalizedSenderAgent)
  const normalizedRecipientHuman = normalizeHumanHandle(recipientHuman) || humanFromAgentId(normalizedRecipientAgent)
  const normalizedSkill = normalizeSharedSkillName(skillHint, '')
  const lines = [
    '[AgentSquared Context]',
    `channel: ${channel}`,
    `messageKind: ${platformMessageKind(channel)}`,
    ...(normalizedSenderHuman ? [`senderHuman: ${normalizedSenderHuman}`] : []),
    ...(normalizedSenderAgent ? [`senderAgent: ${normalizedSenderAgent}`] : channel === 'H2A' ? ['senderAgent: none'] : []),
    ...(clean(senderSurface) ? [`senderSurface: ${clean(senderSurface)}`] : []),
    ...(normalizedRecipientHuman ? [`recipientHuman: ${normalizedRecipientHuman}`] : []),
    ...(normalizedRecipientAgent ? [`recipientAgent: ${normalizedRecipientAgent}`] : []),
    ...(normalizedSkill ? [`skillHint: ${normalizedSkill}`] : []),
    ...(clean(conversationKey) ? [`conversationId: ${clean(conversationKey)}`] : []),
    ...(clean(h2aSessionId) ? [`h2aSessionId: ${clean(h2aSessionId)}`] : []),
    ...(clean(sentAt) ? [`sentAtUTC: ${clean(sentAt)}`] : []),
    ...(clean(transport) ? [`transport: ${clean(transport)}`] : []),
    ...(clean(requestMethod) ? [`requestMethod: ${clean(requestMethod)}`] : []),
    ...(clean(peerSessionId) ? [`peerSessionId: ${clean(peerSessionId)}`] : []),
    ...(clean(requestId) ? [`requestId: ${clean(requestId)}`] : []),
    'note: This block only describes message context and identity; workflow behavior comes from the selected AgentSquared skill.',
    '[/AgentSquared Context]'
  ]
  return lines.join('\n')
}

export function buildInboundPlatformContext({
  localAgentId = '',
  remoteAgentId = '',
  selectedSkill = '',
  item = null,
  messageMethod = '',
  peerSessionId = '',
  requestId = ''
} = {}) {
  const metadata = item?.request?.params?.metadata ?? {}
  const channelKind = clean(metadata.channelKind).toLowerCase() === 'h2a' ? 'h2a' : 'a2a'
  const fromHuman = clean(metadata.fromHuman)
  const fromAgent = channelKind === 'h2a' ? '' : clean(metadata.from || remoteAgentId)
  const toAgent = clean(metadata.toAgent || metadata.to || localAgentId)
  return buildPlatformContextBlock({
    channelKind,
    senderAgent: fromAgent,
    senderSurface: channelKind === 'h2a' ? 'browser human chat' : '',
    senderHuman: fromHuman || (channelKind === 'h2a' ? clean(metadata.from).replace(/^human:/, '') : humanFromAgentId(fromAgent)),
    recipientAgent: toAgent,
    recipientHuman: humanFromAgentId(toAgent),
    skillHint: selectedSkill || metadata.skillHint,
    conversationKey: metadata.conversationKey,
    h2aSessionId: metadata.h2aSessionId,
    sentAt: metadata.sentAt,
    transport: channelKind === 'h2a' ? clean(metadata.browserBridge) || 'AgentSquared H2A bridge' : 'AgentSquared P2P',
    requestMethod: messageMethod,
    peerSessionId,
    requestId
  })
}

export function parseAgentSquaredOutboundEnvelope(text = '') {
  const raw = clean(text)
  if (!raw.includes('[AgentSquared]') && !raw.includes('[AgentSquared Context]')) {
    return null
  }
  const context = extractDelimitedBlock(raw, '[AgentSquared Context]', '[/AgentSquared Context]')
  const contextValue = (name) => clean(context.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1])
  const message = extractDelimitedBlock(raw, '[Message]', '[/Message]')
  const from = contextValue('senderAgent') || clean(raw.match(/^From:\s*(.+)$/m)?.[1])
  const to = contextValue('recipientAgent') || clean(raw.match(/^To:\s*(.+)$/m)?.[1])
  const sentAt = contextValue('sentAtUTC') || clean(raw.match(/^Sent At \(UTC\):\s*(.+)$/m)?.[1])
  const ownerRequest = extractDelimitedBlock(raw, 'BEGIN_A2_OWNER_REQUEST', 'END_A2_OWNER_REQUEST')
    || message
    || clean(raw.match(/Owner Request:\n([\s\S]*?)\n\nPlease reply to me for my owner\./)?.[1])
  return {
    from,
    to,
    sentAt,
    ownerRequest,
    channel: contextValue('channel'),
    messageKind: contextValue('messageKind'),
    senderHuman: contextValue('senderHuman'),
    recipientHuman: contextValue('recipientHuman'),
    skillHint: contextValue('skillHint'),
    conversationKey: contextValue('conversationId')
  }
}

export function buildSkillOutboundText({
  localAgentId,
  targetAgentId,
  skillName,
  originalText,
  conversationKey = '',
  sentAt = new Date().toISOString()
} = {}) {
  const selectedSkill = normalizeSharedSkillName(skillName, '')
  return [
    '🅰️✌️ [AgentSquared]',
    buildPlatformContextBlock({
      channelKind: 'a2a',
      senderAgent: localAgentId,
      senderHuman: humanFromAgentId(localAgentId),
      recipientAgent: targetAgentId,
      recipientHuman: humanFromAgentId(targetAgentId),
      skillHint: selectedSkill,
      conversationKey,
      sentAt,
      transport: 'AgentSquared P2P'
    }),
    '',
    '[Message]',
    clean(originalText) || '(empty)',
    '[/Message]',
    '',
    'BEGIN_A2_OWNER_REQUEST',
    clean(originalText) || '(empty)',
    'END_A2_OWNER_REQUEST'
  ].join('\n')
}
