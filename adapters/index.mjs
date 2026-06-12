import { createOpenClawAdapter, parseOpenClawTaskResult } from './openclaw/adapter.mjs'
import { detectOpenClawHostEnvironment } from './openclaw/detect.mjs'
import { createHermesAdapter } from './hermes/adapter.mjs'
import { detectHermesHostEnvironment } from './hermes/detect.mjs'
import { detectParentRuntimeHint } from './hermes/common.mjs'
import { createCodexAdapter } from './codex/adapter.mjs'
import { detectCodexHostEnvironment } from './codex/detect.mjs'
import { createClaudeCodeAdapter } from './claudecode/adapter.mjs'
import { detectClaudeCodeHostEnvironment } from './claudecode/detect.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export const SUPPORTED_HOST_RUNTIMES = ['codex', 'claudecode', 'hermes', 'openclaw']

function confidenceScore(confidence = '') {
  switch (clean(confidence).toLowerCase()) {
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    default:
      return 0
  }
}

function detectionScore(detection = null) {
  const base = confidenceScore(detection?.confidence)
  if (!detection?.detected) {
    return base
  }
  if (detection?.apiServerHealthy || detection?.rpcHealthy || detection?.codexCommandAvailable || detection?.authHealthy) {
    return base + 3
  }
  if (detection?.gatewayServiceInstalled) {
    return base + 1
  }
  return base
}

export async function detectHostRuntimeEnvironment({
  preferred = 'auto',
  openclaw = {},
  hermes = {},
  codex = {},
  claudecode = {}
} = {}) {
  const normalizedPreferred = clean(preferred).toLowerCase() || 'auto'
  if (normalizedPreferred === 'codex') {
    const detection = await detectCodexHostEnvironment(codex)
    return {
      ...detection,
      requested: 'codex',
      resolved: detection?.detected ? 'codex' : 'none',
      explicit: true
    }
  }
  if (normalizedPreferred === 'claudecode') {
    const detection = await detectClaudeCodeHostEnvironment(claudecode)
    return {
      ...detection,
      requested: 'claudecode',
      resolved: detection?.detected ? 'claudecode' : 'none',
      explicit: true
    }
  }
  if (normalizedPreferred === 'openclaw') {
    const detection = await detectOpenClawHostEnvironment(openclaw)
    return {
      ...detection,
      requested: 'openclaw',
      resolved: detection?.detected ? 'openclaw' : 'none',
      explicit: true
    }
  }
  if (normalizedPreferred === 'hermes') {
    const detection = await detectHermesHostEnvironment(hermes)
    return {
      ...detection,
      requested: 'hermes',
      resolved: detection?.detected ? 'hermes' : 'none',
      explicit: true
    }
  }
  if (normalizedPreferred && normalizedPreferred !== 'auto' && normalizedPreferred !== 'none') {
    return {
      id: 'none',
      detected: false,
      requested: normalizedPreferred,
      resolved: 'none',
      confidence: 'low',
      reason: `unsupported-host-runtime:${normalizedPreferred}`,
      supported: SUPPORTED_HOST_RUNTIMES
    }
  }
  if (normalizedPreferred === 'none') {
    return {
      id: 'none',
      detected: false,
      requested: 'none',
      resolved: 'none',
      confidence: 'high',
      reason: 'host-runtime-disabled'
    }
  }

  const parentRuntimeHint = detectParentRuntimeHint()
  const [codexDetection, claudeCodeDetection, hermesDetection, openclawDetection] = await Promise.all([
    detectCodexHostEnvironment(codex),
    detectClaudeCodeHostEnvironment(claudecode),
    detectHermesHostEnvironment(hermes),
    detectOpenClawHostEnvironment(openclaw)
  ])
  const candidates = [
    { id: 'codex', detection: codexDetection },
    { id: 'claudecode', detection: claudeCodeDetection },
    { id: 'hermes', detection: hermesDetection },
    { id: 'openclaw', detection: openclawDetection }
  ].filter((candidate) => candidate.detection?.detected)

  if (parentRuntimeHint) {
    const hinted = candidates.find((candidate) => candidate.id === parentRuntimeHint)
    if (hinted) {
      return {
        ...hinted.detection,
        requested: 'auto',
        resolved: hinted.id,
        parentRuntimeHint,
        candidates: {
          codex: codexDetection,
          claudecode: claudeCodeDetection,
          hermes: hermesDetection,
          openclaw: openclawDetection
        }
      }
    }
  }

  if (candidates.length === 0) {
    return {
      ...codexDetection,
      requested: 'auto',
      resolved: 'none',
      parentRuntimeHint,
      candidates: {
        codex: codexDetection,
        claudecode: claudeCodeDetection,
        hermes: hermesDetection,
        openclaw: openclawDetection
      }
    }
  }

  const winner = [...candidates].sort((left, right) => {
    const scoreDelta = detectionScore(right.detection) - detectionScore(left.detection)
    if (scoreDelta !== 0) {
      return scoreDelta
    }
    if (left.id === 'codex') {
      return -1
    }
    if (right.id === 'codex') {
      return 1
    }
    if (left.id === 'claudecode') {
      return -1
    }
    if (right.id === 'claudecode') {
      return 1
    }
    if (left.id === 'hermes') {
      return -1
    }
    return 1
  })[0]
  if (winner?.detection) {
    return {
      ...winner.detection,
      requested: 'auto',
      resolved: winner.id,
      parentRuntimeHint,
        candidates: {
          codex: codexDetection,
          claudecode: claudeCodeDetection,
          hermes: hermesDetection,
          openclaw: openclawDetection
        }
      }
  }
  return {
    id: 'none',
    detected: false,
    requested: 'auto',
    resolved: 'none',
    confidence: 'low',
    reason: 'no-supported-host-runtime-detected',
    parentRuntimeHint,
    candidates: {
      codex: codexDetection,
      claudecode: claudeCodeDetection,
      hermes: hermesDetection,
      openclaw: openclawDetection
    }
  }
}

export function createHostRuntimeAdapter({
  hostRuntime = 'none',
  localAgentId,
  openclaw = {},
  hermes = {},
  codex = {},
  claudecode = {}
} = {}) {
  const normalizedHostRuntime = clean(hostRuntime).toLowerCase() || 'none'
  if (normalizedHostRuntime === 'codex') {
    return createCodexAdapter({
      localAgentId,
      ...codex
    })
  }
  if (normalizedHostRuntime === 'claudecode') {
    return createClaudeCodeAdapter({
      localAgentId,
      ...claudecode
    })
  }
  if (normalizedHostRuntime === 'openclaw') {
    return createOpenClawAdapter({
      localAgentId,
      ...openclaw
    })
  }
  if (normalizedHostRuntime === 'hermes') {
    return createHermesAdapter({
      localAgentId,
      ...hermes
    })
  }
  return null
}

export {
  createOpenClawAdapter,
  parseOpenClawTaskResult,
  createClaudeCodeAdapter
}
