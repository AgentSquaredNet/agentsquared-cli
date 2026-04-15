import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { resolveUserPath } from '../../lib/shared/paths.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function activeProfileFile(defaultRoot) {
  return path.join(defaultRoot, 'active_profile')
}

export function defaultHermesRoot() {
  return path.join(process.env.HOME || os.homedir(), '.hermes')
}

export function readActiveHermesProfile(defaultRoot = defaultHermesRoot()) {
  try {
    const name = fs.readFileSync(activeProfileFile(defaultRoot), 'utf8').trim()
    return name || 'default'
  } catch {
    return 'default'
  }
}

export function resolveHermesHome({
  hermesHome = '',
  hermesProfile = '',
  env = process.env
} = {}) {
  const explicitHome = clean(hermesHome)
  if (explicitHome) {
    return resolveUserPath(explicitHome)
  }
  const explicitProfile = clean(hermesProfile)
  const envHome = clean(env.HERMES_HOME)
  if (envHome) {
    return resolveUserPath(envHome)
  }
  const root = defaultHermesRoot()
  const profileName = explicitProfile || readActiveHermesProfile(root)
  if (!profileName || profileName === 'default') {
    return root
  }
  return path.join(root, 'profiles', profileName)
}

export function resolveHermesProfileName(hermesHome = '') {
  const home = resolveUserPath(hermesHome || defaultHermesRoot())
  const root = resolveUserPath(defaultHermesRoot())
  if (home === root) {
    return 'default'
  }
  const profilesRoot = path.join(root, 'profiles')
  const relative = path.relative(profilesRoot, home)
  const parts = relative.split(path.sep).filter(Boolean)
  if (parts.length === 1 && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(parts[0])) {
    return parts[0]
  }
  return 'custom'
}

export function hermesEnvPath(hermesHome = '') {
  return path.join(resolveUserPath(hermesHome || defaultHermesRoot()), '.env')
}

export function hermesConfigPath(hermesHome = '') {
  return path.join(resolveUserPath(hermesHome || defaultHermesRoot()), 'config.yaml')
}

export function hermesProjectRoot(hermesHome = '') {
  return path.join(resolveUserPath(hermesHome || defaultHermesRoot()), 'hermes-agent')
}

export function hermesPythonPath(hermesHome = '') {
  const projectRoot = hermesProjectRoot(hermesHome)
  const venvPython = path.join(projectRoot, 'venv', 'bin', 'python')
  return fs.existsSync(venvPython) ? venvPython : 'python3'
}

export function hermesChannelDirectoryPath(hermesHome = '') {
  return path.join(resolveUserPath(hermesHome || defaultHermesRoot()), 'channel_directory.json')
}

export function readHermesChannelDirectory(hermesHome = '') {
  const filePath = hermesChannelDirectoryPath(hermesHome)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return { updated_at: null, platforms: {} }
  }
}

export function hermesServiceNameForHome(hermesHome = '') {
  const home = resolveUserPath(hermesHome || defaultHermesRoot())
  const root = resolveUserPath(defaultHermesRoot())
  if (home === root) {
    return 'hermes-gateway'
  }
  const profilesRoot = path.join(root, 'profiles')
  const relative = path.relative(profilesRoot, home)
  const parts = relative.split(path.sep).filter(Boolean)
  if (parts.length === 1 && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(parts[0])) {
    return `hermes-gateway-${parts[0]}`
  }
  return `hermes-gateway-${crypto.createHash('sha256').update(home).digest('hex').slice(0, 8)}`
}

export function hermesSystemdUnitPaths(hermesHome = '') {
  const serviceName = hermesServiceNameForHome(hermesHome)
  return {
    user: path.join(process.env.HOME || os.homedir(), '.config', 'systemd', 'user', `${serviceName}.service`),
    system: path.join('/etc/systemd/system', `${serviceName}.service`)
  }
}

export function hermesLaunchdPlistPath(hermesHome = '') {
  const serviceName = hermesServiceNameForHome(hermesHome)
  const suffix = serviceName === 'hermes-gateway' ? '' : serviceName.replace(/^hermes-gateway-/, '-')
  return path.join(process.env.HOME || os.homedir(), 'Library', 'LaunchAgents', `ai.hermes.gateway${suffix}.plist`)
}

export function detectHermesServiceMode(hermesHome = '') {
  const unitPaths = hermesSystemdUnitPaths(hermesHome)
  const launchdPath = hermesLaunchdPlistPath(hermesHome)
  return {
    installed: Boolean(
      fs.existsSync(unitPaths.user)
      || fs.existsSync(unitPaths.system)
      || fs.existsSync(launchdPath)
    ),
    systemdUserUnit: fs.existsSync(unitPaths.user) ? unitPaths.user : '',
    systemdSystemUnit: fs.existsSync(unitPaths.system) ? unitPaths.system : '',
    launchdPlist: fs.existsSync(launchdPath) ? launchdPath : ''
  }
}

function shellCommandExists(command = '') {
  const normalized = clean(command)
  if (!normalized) {
    return false
  }
  if (normalized.includes(path.sep)) {
    return fs.existsSync(resolveUserPath(normalized))
  }
  const result = spawnSync('sh', ['-lc', `command -v "${normalized.replace(/"/g, '\\"')}"`], {
    stdio: 'ignore'
  })
  return result.status === 0
}

export function detectParentRuntimeHint() {
  let pid = process.ppid
  const seen = new Set()
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid)
    const command = spawnSync('ps', ['-o', 'command=', '-p', `${pid}`], {
      encoding: 'utf8'
    })
    const text = clean(command.stdout).toLowerCase()
    if (text.includes('openclaw')) {
      return 'openclaw'
    }
    if (text.includes('hermes')) {
      return 'hermes'
    }
    const parent = spawnSync('ps', ['-o', 'ppid=', '-p', `${pid}`], {
      encoding: 'utf8'
    })
    const nextPid = Number.parseInt(clean(parent.stdout), 10)
    if (!Number.isFinite(nextPid) || nextPid <= 1) {
      break
    }
    pid = nextPid
  }
  return ''
}

export function resolveHermesCommand(command = 'hermes') {
  const normalized = clean(command) || 'hermes'
  return {
    command: normalized,
    available: shellCommandExists(normalized)
  }
}

export function buildHermesProcessEnv({
  hermesHome = '',
  extra = {}
} = {}) {
  const env = {
    ...process.env,
    ...extra
  }
  const resolvedHome = clean(hermesHome)
  if (resolvedHome) {
    env.HERMES_HOME = resolveUserPath(resolvedHome)
  }
  return env
}

export function buildHermesApiBase({
  apiBase = '',
  envVars = {}
} = {}) {
  const explicit = clean(apiBase)
  if (explicit) {
    return explicit.replace(/\/$/, '')
  }
  const host = clean(envVars.API_SERVER_HOST) || '127.0.0.1'
  const port = clean(envVars.API_SERVER_PORT) || '8642'
  return `http://${host}:${port}`
}
