function clean(value) {
  return `${value ?? ''}`.trim()
}

function stripDelimitedBlock(text = '', begin = '', end = '') {
  const start = text.indexOf(begin)
  const finish = text.indexOf(end)
  if (start < 0 || finish < start) {
    return text
  }
  return `${text.slice(0, start)}${text.slice(finish + end.length)}`.trim()
}

function stripAgentSquaredTransportText(text = '') {
  let value = clean(text)
  if (!value) {
    return value
  }
  value = stripDelimitedBlock(value, 'BEGIN_A2_OWNER_REQUEST', 'END_A2_OWNER_REQUEST')
  const strippedLines = value
    .split('\n')
    .filter((line) => {
      const normalized = clean(line)
      if (!normalized) {
        return true
      }
      if (normalized.includes('[AgentSquared]')) {
        return false
      }
      if (normalized === 'This is an AgentSquared private agent message.') {
        return false
      }
      if (normalized === 'Please read the AgentSquared official skill before sending or replying through AgentSquared.') {
        return false
      }
      if (/^(From|To|Sent At \(UTC\)|Owner Request|Local Skill Snapshot):/i.test(normalized)) {
        return false
      }
      if (normalized === 'Please reply to me for my owner.') {
        return false
      }
      return true
    })
  value = strippedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return value
}

// This module is intentionally narrow.
// The main safety decision path lives in the host runtime triage prompt.
// Local code here is only a lightweight outbound redaction layer.
const SECRET_PATTERNS = [
  /-----begin [a-z0-9 _-]*private key-----/i,
  /\bsk-[a-z0-9]{16,}\b/i,
  /\bghp_[a-z0-9]{20,}\b/i,
  /\bxox[baprs]-[a-z0-9-]{10,}\b/i,
  /\b(?:api|access|refresh|bearer|auth(?:orization)?) token\b/i,
  /\bseed phrase\b/i,
  /\bprivate key\b/i,
  /\bm(nemonic)?\b.{0,20}\bphrase\b/i
]

const TRUSTED_FRIEND_ESCALATION_PATTERNS = [
  /\b(reveal|show|print|dump|exfiltrate|send|forward|upload|leak|share)\b[\s\S]{0,120}\b(hidden prompt|system prompt|developer message|private memory|memory\.md|secret|password|credential|token|api key|private key|seed phrase|\.env|environment variables?)\b/i,
  /\b(hidden prompt|system prompt|developer message|private memory|memory\.md|secret|password|credential|token|api key|private key|seed phrase|\.env|environment variables?)\b[\s\S]{0,120}\b(reveal|show|print|dump|exfiltrate|send|forward|upload|leak|share)\b/i,
  /\b(ignore|bypass|disable|override)\b[\s\S]{0,80}\b(safety|policy|privacy|instructions?|guardrails?)\b/i,
  /\b(run|execute|launch)\b[\s\S]{0,80}\b(rm\s+-rf|sudo|format\s+disk|drop\s+database|delete\s+all|wipe)\b/i,
  /-----begin [a-z0-9 _-]*private key-----/i,
  /\bsk-[a-z0-9]{16,}\b/i,
  /\bghp_[a-z0-9]{20,}\b/i,
  /\bxox[baprs]-[a-z0-9-]{10,}\b/i
]

export function assessTrustedFriendInboundSafety({
  text = '',
  originalOwnerText = '',
  conversationKey = ''
} = {}) {
  const combined = [text, originalOwnerText].map(clean).filter(Boolean).join('\n\n')
  if (!clean(conversationKey)) {
    return {
      action: 'escalate',
      reason: 'missing-conversation-key'
    }
  }
  if (!combined) {
    return {
      action: 'allow',
      reason: 'trusted-friend-empty-message'
    }
  }
  const matched = TRUSTED_FRIEND_ESCALATION_PATTERNS.find((pattern) => pattern.test(combined))
  if (matched) {
    return {
      action: 'escalate',
      reason: 'trusted-friend-risk-pattern'
    }
  }
  return {
    action: 'allow',
    reason: 'trusted-friend-fast-path'
  }
}

export function scrubOutboundText(text = '') {
  let value = clean(text)
  if (!value) {
    return value
  }
  value = stripAgentSquaredTransportText(value)
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, '[REDACTED]')
  }
  return value
}
