function clean(value) {
  return `${value ?? ''}`.trim()
}

export const PLATFORM_MAX_TURNS = 20

const VALID_DECISIONS = new Set(['continue', 'done'])

const VALID_STOP_REASONS = new Set([
  'completed',
  'safety-block',
  'system-error'
])

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value ?? ''}`, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

function extractFrontmatter(text = '') {
  const match = `${text ?? ''}`.match(/^---\n([\s\S]*?)\n---/)
  return match?.[1] ?? ''
}

function readFrontmatterValue(frontmatter = '', key = '') {
  const match = `${frontmatter}`.match(new RegExp(`^\\s*${clean(key)}\\s*:\\s*(.+)\\s*$`, 'm'))
  return clean(match?.[1] ?? '').replace(/^["']|["']$/g, '')
}

export function normalizeSharedSkillName(value = '', fallback = '') {
  return clean(value).toLowerCase() || clean(fallback).toLowerCase()
}

export function clampConversationMaxTurns(value, fallback = 1) {
  const boundedFallback = Math.max(1, Math.min(PLATFORM_MAX_TURNS, parsePositiveInteger(fallback, 1) || 1))
  const parsed = parsePositiveInteger(value, boundedFallback)
  return Math.max(1, Math.min(PLATFORM_MAX_TURNS, parsed || boundedFallback))
}

export function parseSkillDocumentPolicy(text = '', {
  fallbackName = ''
} = {}) {
  const frontmatter = extractFrontmatter(text)
  const name = normalizeSharedSkillName(readFrontmatterValue(frontmatter, 'name'), fallbackName)
  const maxTurns = clampConversationMaxTurns(
    readFrontmatterValue(frontmatter, 'maxTurns') || readFrontmatterValue(frontmatter, 'max_turns'),
    1
  )
  return {
    name,
    maxTurns
  }
}

export function resolveSkillMaxTurns(skillName = '', sharedSkill = null) {
  const normalizedSkill = normalizeSharedSkillName(skillName)
  const sharedSkillName = normalizeSharedSkillName(sharedSkill?.name)
  if (sharedSkillName && normalizedSkill && sharedSkillName === normalizedSkill) {
    return clampConversationMaxTurns(sharedSkill?.maxTurns, 1)
  }
  if (sharedSkillName && !normalizedSkill) {
    return clampConversationMaxTurns(sharedSkill?.maxTurns, 1)
  }
  return 1
}

export function normalizeConversationControl(raw = {}, {
  defaultTurnIndex = 1,
  defaultDecision = 'done',
  defaultStopReason = ''
} = {}) {
  const turnIndex = Math.max(1, parsePositiveInteger(raw?.turnIndex, defaultTurnIndex || 1) || 1)
  const normalizedDecision = clean(raw?.decision).toLowerCase()
  const normalizedDefaultDecision = clean(defaultDecision).toLowerCase()
  const decision = VALID_DECISIONS.has(normalizedDecision)
    ? clean(raw?.decision).toLowerCase()
    : VALID_DECISIONS.has(normalizedDefaultDecision)
      ? normalizedDefaultDecision
      : 'done'
  const normalizedStopReason = clean(raw?.stopReason).toLowerCase()
  const normalizedDefaultStopReason = clean(defaultStopReason).toLowerCase()
  const stopReason = VALID_STOP_REASONS.has(normalizedStopReason)
    ? normalizedStopReason
    : VALID_STOP_REASONS.has(normalizedDefaultStopReason)
      ? normalizedDefaultStopReason
      : ''
  return {
    turnIndex,
    decision,
    stopReason,
    final: decision !== 'continue'
  }
}

export function shouldContinueConversation(control = {}) {
  const normalized = normalizeConversationControl(control)
  return normalized.decision === 'continue'
}

export function resolveInboundConversationIdentity(item = {}) {
  const metadata = item?.request?.params?.metadata
  const normalizedMetadata = metadata && typeof metadata === 'object' ? metadata : {}
  const explicitConversationKey = clean(normalizedMetadata.conversationKey)
  if (explicitConversationKey) {
    return {
      conversationKey: explicitConversationKey,
      mailboxKey: `conversation:${explicitConversationKey}`
    }
  }
  throw Object.assign(new Error('conversationKey is required for inbound AgentSquared conversations'), { code: 400 })
}
