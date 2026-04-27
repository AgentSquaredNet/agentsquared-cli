import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findLocalOfficialSkill, findOfficialSkillsRoot } from '../conversation/local_skills.mjs'
import { getFriendDirectory } from '../transport/relay_http.mjs'
import { currentRuntimeMetadata } from '../runtime/report.mjs'
import { loadRuntimeKeyBundle, publicKeyFingerprint } from '../runtime/keys.mjs'
import { defaultInboxDir, resolveUserPath } from '../shared/paths.mjs'
import { currentRuntimeRevision } from './state.mjs'
import { inspectExistingGateway, resolveAgentContext, resolvedHostRuntimeFromHealth } from './lifecycle.mjs'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '../..')

function clean(value) {
  return `${value ?? ''}`.trim()
}

function safeError(error = null) {
  return clean(error?.message || error)
}

function check(id, label, status, summary, detail = '', fix = null, data = {}) {
  return {
    id,
    label,
    status,
    summary,
    detail: clean(detail),
    ...(fix ? { fix } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {})
  }
}

function worstStatus(checks = []) {
  if (checks.some((item) => item.status === 'fail')) return 'unhealthy'
  if (checks.some((item) => item.status === 'unknown')) return 'unknown'
  if (checks.some((item) => item.status === 'warn')) return 'needs-attention'
  return 'healthy'
}

function statusIcon(status = '') {
  switch (status) {
    case 'ok': return '✓'
    case 'warn': return '!'
    case 'fail': return '×'
    default: return '?'
  }
}

function canWriteDir(dirPath = '') {
  const resolved = clean(dirPath) ? resolveUserPath(dirPath) : ''
  if (!resolved) {
    return false
  }
  try {
    fs.mkdirSync(resolved, { recursive: true })
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function transportFromHealth(health = null) {
  if (!health?.peerId || !health?.streamProtocol) {
    return null
  }
  return {
    peerId: health.peerId,
    listenAddrs: health.listenAddrs ?? [],
    relayAddrs: health.relayAddrs ?? [],
    supportedBindings: health.supportedBindings ?? [],
    streamProtocol: health.streamProtocol,
    a2aProtocolVersion: health.a2aProtocolVersion ?? ''
  }
}

function buildOwnerFacingLines(report = {}) {
  const lines = [
    'AgentSquared Doctor',
    `Overall: ${report.status}`
  ]
  for (const item of report.checks ?? []) {
    lines.push(`${statusIcon(item.status)} ${item.label}: ${item.summary}`)
  }
  if ((report.recommendedActions ?? []).length > 0) {
    lines.push('', 'Recommended fix:')
    for (const action of report.recommendedActions) {
      lines.push(`- ${action.summary}`)
    }
  }
  return lines
}

function action(kind, summary, command = '') {
  return {
    kind,
    summary,
    ...(clean(command) ? { command: clean(command) } : {})
  }
}

function rememberAction(out = [], item = null) {
  if (!item) {
    return
  }
  out.push({ ...item })
}

export async function runGatewayDoctor({
  args = {},
  context = null,
  detectedHostRuntime = null
} = {}) {
  const apiBase = clean(args['api-base']) || 'https://api.agentsquared.net'
  const checks = []
  const recommendedActions = []
  const runtime = currentRuntimeMetadata()

  checks.push(check(
    'cli.runtime',
    'CLI Runtime',
    'ok',
    `${runtime.packageName} ${runtime.packageVersion}`,
    `revision ${runtime.runtimeRevision}; node ${process.version}`,
    null,
    {
      packageVersion: runtime.packageVersion,
      runtimeRevision: runtime.runtimeRevision,
      nodeVersion: process.version,
      packageRoot: ROOT
    }
  ))

  let resolvedContext = context
  if (!resolvedContext) {
    try {
      resolvedContext = resolveAgentContext(args)
    } catch (error) {
      const fix = action('pass-agent-context', 'Pass --agent-id and --key-file for the intended local AgentSquared profile.')
      rememberAction(recommendedActions, fix)
      checks.push(check('identity.context', 'Local Identity', 'fail', 'No local AgentSquared profile could be resolved.', safeError(error), fix))
    }
  }

  let keyBundle = null
  if (resolvedContext) {
    try {
      keyBundle = loadRuntimeKeyBundle(resolvedContext.keyFile)
      const hasPublicKey = Boolean(clean(keyBundle?.publicKey))
      const hasPrivateKey = Boolean(clean(keyBundle?.privateKeyPem))
      checks.push(check(
        'identity.key',
        'Local Identity',
        hasPublicKey && hasPrivateKey ? 'ok' : 'fail',
        hasPublicKey && hasPrivateKey
          ? `key matches local profile ${resolvedContext.agentId}`
          : 'runtime key is incomplete',
        resolvedContext.keyFile,
        hasPublicKey && hasPrivateKey ? null : action('restore-key', 'Restore the original runtime-key.json. Do not delete or regenerate it for the same Agent ID.'),
        {
          agentId: resolvedContext.agentId,
          keyFile: resolvedContext.keyFile,
          publicKeyFingerprint: hasPublicKey ? publicKeyFingerprint(keyBundle) : ''
        }
      ))
    } catch (error) {
      const fix = action('restore-key', 'Restore the original runtime-key.json. If it is gone, register and activate a new Agent ID.')
      rememberAction(recommendedActions, fix)
      checks.push(check('identity.key', 'Local Identity', 'fail', 'runtime key could not be read', safeError(error), fix, {
        agentId: resolvedContext.agentId,
        keyFile: resolvedContext.keyFile
      }))
    }
  }

  let gateway = null
  if (resolvedContext) {
    try {
      gateway = await inspectExistingGateway({
        gatewayBase: args['gateway-base'],
        keyFile: resolvedContext.keyFile,
        agentId: resolvedContext.agentId,
        gatewayStateFile: clean(args['gateway-state-file']) || resolvedContext.gatewayStateFile
      })
      let status = 'fail'
      let summary = 'gateway is not running'
      let fix = action('restart-gateway', 'Restart the local A2 gateway.', `a2-cli gateway restart --agent-id ${resolvedContext.agentId} --key-file ${resolvedContext.keyFile}`)
      if (gateway.running && gateway.healthy && gateway.revisionMatches) {
        status = 'ok'
        summary = `healthy at ${gateway.gatewayBase}`
        fix = null
      } else if (gateway.running && !gateway.revisionMatches) {
        status = 'warn'
        summary = 'gateway is running older CLI code'
      } else if (gateway.running && !gateway.healthy) {
        summary = 'gateway process exists but health check failed'
      } else if (gateway.state && !gateway.running) {
        summary = 'gateway state exists but process is not running'
      }
      rememberAction(recommendedActions, fix)
      checks.push(check('gateway.process', 'Gateway Process', status, summary, gateway.stateFile, fix, {
        pid: gateway.pid,
        gatewayBase: gateway.gatewayBase,
        stateRevision: gateway.stateRevision,
        expectedRevision: gateway.expectedRevision || currentRuntimeRevision(),
        revisionMatches: gateway.revisionMatches,
        healthy: gateway.healthy
      }))
    } catch (error) {
      const fix = action('restart-gateway', 'Restart the local A2 gateway after checking the profile paths.')
      rememberAction(recommendedActions, fix)
      checks.push(check('gateway.process', 'Gateway Process', 'unknown', 'gateway state could not be inspected', safeError(error), fix))
    }
  }

  const hostResolved = clean(detectedHostRuntime?.resolved || detectedHostRuntime?.id || resolvedHostRuntimeFromHealth(gateway?.health))
  const hostReady = Boolean(
    detectedHostRuntime?.apiServerHealthy
    || detectedHostRuntime?.rpcHealthy
    || detectedHostRuntime?.agentsList
    || detectedHostRuntime?.overviewStatus
    || detectedHostRuntime?.gatewayHealth
    || gateway?.health?.startupChecks?.hostRuntime?.ok
  )
  checks.push(check(
    'host.runtime',
    'Host Runtime',
    hostResolved && hostResolved !== 'none'
      ? (hostReady ? 'ok' : 'warn')
      : 'fail',
    hostResolved && hostResolved !== 'none'
      ? `${hostResolved}${hostReady ? ' adapter reachable' : ' detected but not fully healthy'}`
      : 'no supported local host runtime detected',
    clean(detectedHostRuntime?.reason) || clean(gateway?.health?.startupChecks?.hostRuntime?.error),
    hostResolved && hostResolved !== 'none'
      ? null
      : action('install-host-runtime', 'Install or start a supported host runtime such as Hermes or OpenClaw.')
  ))

  const skillsRoot = clean(args['skills-dir']) || findOfficialSkillsRoot()
  const friendSkill = findLocalOfficialSkill('friend-im')
  const mutualSkill = findLocalOfficialSkill('agent-mutual-learning')
  const h2aSkill = findLocalOfficialSkill('human-agent-chat')
  const skillsOk = Boolean(friendSkill.available && mutualSkill.available && h2aSkill.available)
  if (!skillsOk) {
    rememberAction(recommendedActions, action('update-skills', 'Run `a2-cli update` or update the official AgentSquared Skills checkout.'))
  }
  checks.push(check(
    'skills.official',
    'Official Skills',
    skillsOk ? 'ok' : 'fail',
    skillsOk
      ? 'friend-im, agent-mutual-learning, and human-agent-chat are installed'
      : 'one or more official A2 skills are missing',
    skillsRoot || 'official Skills checkout was not found',
    skillsOk ? null : action('update-skills', 'Run `a2-cli update` or reinstall the official AgentSquared Skills checkout.'),
    {
      skillsRoot,
      friendIm: friendSkill.available,
      agentMutualLearning: mutualSkill.available,
      humanAgentChat: h2aSkill.available
    }
  ))

  if (resolvedContext) {
    const inboxDir = clean(args['inbox-dir']) || defaultInboxDir(resolvedContext.keyFile, resolvedContext.agentId)
    const writable = canWriteDir(inboxDir)
    checks.push(check(
      'inbox.storage',
      'Inbox Storage',
      writable ? 'ok' : 'fail',
      writable ? 'inbox directory is writable' : 'inbox directory is not writable',
      inboxDir,
      writable ? null : action('fix-inbox', 'Fix local filesystem permissions for the AgentSquared inbox directory.')
    ))
  }

  if (resolvedContext && keyBundle) {
    const transport = transportFromHealth(gateway?.health)
    const startedAt = Date.now()
    try {
      const directory = await getFriendDirectory(apiBase, resolvedContext.agentId, keyBundle, transport)
      checks.push(check(
        'relay.signed',
        'Relay',
        'ok',
        `signed relay request succeeded in ${Date.now() - startedAt}ms`,
        `${apiBase}/api/relay/friends`,
        null,
        {
          friendCount: Array.isArray(directory?.friends) ? directory.friends.length : undefined
        }
      ))
    } catch (error) {
      const code = Number.parseInt(`${error?.statusCode ?? 0}`, 10) || 0
      const status = code === 401 || code === 403 || code >= 500 ? 'fail' : 'unknown'
      const fix = code === 401 || code === 403
        ? action('check-identity', 'Check that the runtime key belongs to this Agent ID and that relay registration is still valid.')
        : action('retry-relay', 'Retry after relay/network health recovers. If it persists, run gateway doctor again with debug logs.')
      rememberAction(recommendedActions, fix)
      checks.push(check('relay.signed', 'Relay', status, 'signed relay request failed', safeError(error), fix, {
        statusCode: code || null,
        apiBase
      }))
    }
  }

  const status = worstStatus(checks)
  const report = {
    ok: status === 'healthy' || status === 'needs-attention',
    status,
    agentId: clean(resolvedContext?.agentId),
    apiBase,
    checks,
    recommendedActions
  }
  report.ownerFacingLines = buildOwnerFacingLines(report)
  report.ownerFacingText = report.ownerFacingLines.join('\n')
  return report
}
