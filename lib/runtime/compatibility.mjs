import { spawnSync } from 'node:child_process'

export const RUNTIME_VERSIONS = Object.freeze({
  codex: '0.155.1', claudecode: '2.1.277', hermes: '0.21.3', openclaw: '2026.9.5'
})
export const ADAPTER_VERSION = '2.0.0'
export function nodeCompatible(version = process.versions.node) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  return major === 24 && minor >= 16
}
export function runtimeCompatibility(runtime, command) {
  const probe = spawnSync(command, runtime === 'hermes' ? ['version'] : ['--version'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  })
  const actualVersion = probe.status === 0 ? probe.stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null : null
  const expectedVersion = RUNTIME_VERSIONS[runtime]
  return { runtime, adapterVersion: ADAPTER_VERSION, actualVersion, expectedVersion,
    nodeVersion: process.versions.node,
    compatible: nodeCompatible() && actualVersion === expectedVersion,
    missingCapabilities: [] }
}
export function assertRuntimeCompatibility(runtime, command) {
  const result = runtimeCompatibility(runtime, command)
  if (!result.compatible) throw new Error(`Unsupported ${runtime} runtime ${result.actualVersion ?? 'unknown'}; requires ${result.expectedVersion} and Node 24 >=24.16.0 (actual ${result.nodeVersion})`)
  return result
}
export function withCompatibility(detector, runtime, commandOf) {
  return async (options = {}) => {
    const detection = await detector(options)
    const compatibility = runtimeCompatibility(runtime, commandOf(detection, options))
    if (runtime === 'hermes') {
      compatibility.missingCapabilities = ['responses_api', 'run_submission', 'run_status', 'run_events_sse', 'run_stop'].filter(key => detection.apiServerCapabilities?.features?.[key] !== true)
    }
    return { ...detection, compatibility,
      detected: Boolean(detection.detected && compatibility.compatible),
      reason: compatibility.compatible ? detection.reason : `incompatible-${runtime}-version` }
  }
}
