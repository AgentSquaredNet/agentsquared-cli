import fs from 'node:fs'

import {
  buildHermesApiBase,
  detectHermesServiceMode,
  hermesConfigPath,
  hermesEnvPath,
  resolveHermesCommand,
  resolveHermesHome,
  resolveHermesProfileName
} from './common.mjs'
import { checkHermesApiServerHealth } from './api_client.mjs'
import { readHermesEnv } from './env.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export async function detectHermesHostEnvironment({
  command = 'hermes',
  hermesHome = '',
  hermesProfile = '',
  apiBase = ''
} = {}) {
  const commandProbe = resolveHermesCommand(command)
  const resolvedHome = resolveHermesHome({ hermesHome, hermesProfile })
  const envPath = hermesEnvPath(resolvedHome)
  const configPath = hermesConfigPath(resolvedHome)
  const envVars = readHermesEnv(resolvedHome)
  const resolvedApiBase = buildHermesApiBase({ apiBase, envVars })
  const apiCheck = await checkHermesApiServerHealth({
    apiBase: resolvedApiBase,
    envVars,
    timeoutMs: 2500
  })
  const serviceMode = detectHermesServiceMode(resolvedHome)
  const profileName = resolveHermesProfileName(resolvedHome)
  const gatewayPidFile = `${resolvedHome}/gateway.pid`
  const gatewayPid = fs.existsSync(gatewayPidFile)
    ? Number.parseInt(`${fs.readFileSync(gatewayPidFile, 'utf8').trim()}`, 10) || null
    : null
  if (apiCheck.ok) {
    return {
      id: 'hermes',
      detected: true,
      confidence: 'high',
      reason: 'hermes-api-server-health',
      workspaceDir: resolvedHome,
      hermesCommand: commandProbe.command,
      hermesCommandAvailable: commandProbe.available,
      hermesHome: resolvedHome,
      hermesProfile: profileName,
      envPath,
      configPath,
      envVars,
      apiBase: resolvedApiBase,
      apiServerHealthy: true,
      apiServerHealth: apiCheck.health?.payload ?? null,
      apiServerModels: apiCheck.models?.payload ?? null,
      gatewayServiceInstalled: serviceMode.installed,
      gatewayService: serviceMode,
      gatewayPid
    }
  }
  if (commandProbe.available || fs.existsSync(envPath) || fs.existsSync(configPath) || fs.existsSync(resolvedHome)) {
    return {
      id: 'hermes',
      detected: true,
      confidence: commandProbe.available ? 'medium' : 'low',
      reason: commandProbe.available ? 'hermes-command-present' : 'hermes-home-present',
      workspaceDir: resolvedHome,
      hermesCommand: commandProbe.command,
      hermesCommandAvailable: commandProbe.available,
      hermesHome: resolvedHome,
      hermesProfile: profileName,
      envPath,
      configPath,
      envVars,
      apiBase: resolvedApiBase,
      apiServerHealthy: false,
      apiServerProbe: apiCheck,
      gatewayServiceInstalled: serviceMode.installed,
      gatewayService: serviceMode,
      suggested: 'hermes',
      gatewayPid
    }
  }
  return {
    id: 'none',
    detected: false,
    confidence: 'low',
    reason: 'no-hermes-host-runtime-detected',
    suggested: 'hermes'
  }
}
