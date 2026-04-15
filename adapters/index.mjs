import { createOpenClawAdapter, parseOpenClawTaskResult } from './openclaw/adapter.mjs'
import { detectOpenClawHostEnvironment } from './openclaw/detect.mjs'
import { createHermesAdapter } from './hermes/adapter.mjs'
import { detectHermesHostEnvironment } from './hermes/detect.mjs'
import { detectParentRuntimeHint } from './hermes/common.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export const SUPPORTED_HOST_RUNTIMES = ['openclaw', 'hermes']

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
  if (detection?.apiServerHealthy || detection?.rpcHealthy) {
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
  hermes = {}
} = {}) {
  const normalizedPreferred = clean(preferred).toLowerCase() || 'auto'
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
  const [openclawDetection, hermesDetection] = await Promise.all([
    detectOpenClawHostEnvironment(openclaw),
    detectHermesHostEnvironment(hermes)
  ])
  const candidates = [
    { id: 'openclaw', detection: openclawDetection },
    { id: 'hermes', detection: hermesDetection }
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
          openclaw: openclawDetection,
          hermes: hermesDetection
        }
      }
    }
  }

  if (candidates.length === 0) {
    return {
      ...openclawDetection,
      requested: 'auto',
      resolved: 'none',
      parentRuntimeHint,
      candidates: {
        openclaw: openclawDetection,
        hermes: hermesDetection
      }
    }
  }

  const winner = [...candidates].sort((left, right) => {
    const scoreDelta = detectionScore(right.detection) - detectionScore(left.detection)
    if (scoreDelta !== 0) {
      return scoreDelta
    }
    if (left.id === 'openclaw') {
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
        openclaw: openclawDetection,
        hermes: hermesDetection
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
      openclaw: openclawDetection,
      hermes: hermesDetection
    }
  }
}

export function createHostRuntimeAdapter({
  hostRuntime = 'none',
  localAgentId,
  openclaw = {},
  hermes = {}
} = {}) {
  const normalizedHostRuntime = clean(hostRuntime).toLowerCase() || 'none'
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
  parseOpenClawTaskResult
}
