function clean(value) {
  return `${value ?? ''}`.trim()
}

export function nowMs() {
  return Date.now()
}

export function localOwnerTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function excerpt(text, maxLength = 140) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

export function buildReceiverTurnOutline(turns = [], expectedTurnCount = 1) {
  const normalizedTurns = Array.isArray(turns) ? turns : []
  const turnMap = new Map()
  let maxSeenTurnIndex = 0
  for (const turn of normalizedTurns) {
    const turnIndex = Number.parseInt(`${turn?.turnIndex ?? 0}`, 10) || 0
    if (turnIndex > 0) {
      maxSeenTurnIndex = Math.max(maxSeenTurnIndex, turnIndex)
      turnMap.set(turnIndex, turn)
    }
  }
  const maxTurnCount = Math.max(1, Number.parseInt(`${expectedTurnCount ?? 1}`, 10) || 1, maxSeenTurnIndex)
  return Array.from({ length: maxTurnCount }, (_, index) => {
    const displayTurnIndex = index + 1
    const turn = turnMap.get(displayTurnIndex)
    if (!turn) {
      return {
        turnIndex: displayTurnIndex,
        summary: 'Earlier turn details were not preserved in the current live transcript, but this conversation continued.'
      }
    }
    const inbound = excerpt(turn.inboundText)
    const reply = excerpt(turn.replyText)
    const isFinalTurn = Boolean(turn.final) || clean(turn.decision).toLowerCase() === 'done'
    return {
      turnIndex: displayTurnIndex,
      summary: [
        inbound ? `remote said "${inbound}"` : 'remote sent a message',
        reply ? `I replied "${reply}"` : 'I replied',
        isFinalTurn && clean(turn.stopReason) ? `(final stop: ${clean(turn.stopReason)})` : ''
      ].filter(Boolean).join(' ')
    }
  })
}

export function maxTurnIndexFromOutline(turnOutline = []) {
  const normalized = Array.isArray(turnOutline) ? turnOutline : []
  return normalized.reduce((maxSeen, item, index) => {
    const turnIndex = Number.parseInt(`${item?.turnIndex ?? index + 1}`, 10) || (index + 1)
    return Math.max(maxSeen, turnIndex)
  }, 0)
}

export function createPeerBudget({ budgetWindowMs = 10 * 60 * 1000, maxWindowTurns = 30 } = {}) {
  const peerBudget = new Map()

  function consumePeerBudget({ remoteAgentId = '' } = {}) {
    const key = clean(remoteAgentId).toLowerCase() || 'unknown'
    const currentTime = nowMs()
    const existing = peerBudget.get(key)
    const recentEvents = (existing?.events ?? []).filter((event) => currentTime - event.at <= budgetWindowMs)
    const nextCount = recentEvents.length + 1
    recentEvents.push({ at: currentTime })
    peerBudget.set(key, { events: recentEvents })
    return {
      windowTurns: nextCount,
      overBudget: nextCount > maxWindowTurns
    }
  }

  return { consumePeerBudget }
}
