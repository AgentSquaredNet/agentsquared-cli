function clean(value) {
  return `${value ?? ''}`.trim()
}

export function stripAgentSquaredPrefix(value) {
  return clean(value).replace(/^a2\s*[:：]\s*/i, '')
}

export function parseAgentSquaredAgentId(value, {
  required = true,
  label = 'AgentSquared Agent ID'
} = {}) {
  const input = clean(value)
  if (!input) {
    if (required) {
      throw new Error(`${label} is required.`)
    }
    return null
  }
  const platformExplicit = /^a2\s*[:：]/i.test(input)
  const body = stripAgentSquaredPrefix(input)
  if (!body) {
    throw new Error(`${label} must use A2:agentName@humanName or agentName@humanName.`)
  }
  if (body.includes(':') || body.includes('：')) {
    throw new Error(`${label} must be an AgentSquared ID, not a communication-channel target. Use A2:agentName@humanName or agentName@humanName.`)
  }
  const parts = body.split('@')
  if (parts.length !== 2) {
    throw new Error(`${label} must use A2:agentName@humanName or agentName@humanName.`)
  }
  const agentName = clean(parts[0])
  const humanName = clean(parts[1])
  if (!agentName || !humanName || /\s/.test(agentName) || /\s/.test(humanName)) {
    throw new Error(`${label} must use A2:agentName@humanName or agentName@humanName.`)
  }
  const display = `${agentName}@${humanName}`
  return {
    platform: 'a2',
    platformExplicit,
    input,
    display,
    agentName,
    humanName,
    canonical: `${agentName.toLowerCase()}@${humanName.toLowerCase()}`,
    canonicalAgentName: agentName.toLowerCase(),
    canonicalHumanName: humanName.toLowerCase()
  }
}

export function normalizeAgentSquaredAgentId(value, options = {}) {
  return parseAgentSquaredAgentId(value, options)?.canonical || ''
}
