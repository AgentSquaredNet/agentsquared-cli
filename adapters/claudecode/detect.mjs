import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function resolveUserPath(filePath) {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1))
  }
  return path.resolve(filePath)
}

function quoteShell(value = '') {
  return `"${`${value}`.replace(/(["\\$`])/g, '\\$1')}"`
}

function commandPath(command = '') {
  const normalized = clean(command)
  if (!normalized) {
    return ''
  }
  if (normalized.includes(path.sep)) {
    const resolved = resolveUserPath(normalized)
    return fs.existsSync(resolved) ? resolved : ''
  }
  const result = spawnSync('sh', ['-lc', `command -v ${quoteShell(normalized)}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return result.status === 0 ? clean(result.stdout).split(/\r?\n/).find(Boolean) || '' : ''
}

function runCommand(commandPathValue, args = [], timeoutMs = 5000) {
  if (!commandPathValue) {
    return { status: null, stdout: '', stderr: '', error: 'missing-command' }
  }
  const result = spawnSync(commandPathValue, args, {
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return {
    status: result.status,
    stdout: clean(result.stdout),
    stderr: clean(result.stderr),
    error: clean(result.error?.message)
  }
}

function parseAuthStatus(stdout = '') {
  const text = clean(stdout)
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function detectClaudeCodeHostEnvironment({
  command = 'claude'
} = {}) {
  const requestedCommand = clean(command) || 'claude'
  const resolvedCommand = commandPath(requestedCommand)
  const workspaceDir = path.join(os.homedir(), '.claude')
  const configFile = path.join(os.homedir(), '.claude.json')
  const workspacePresent = fs.existsSync(workspaceDir)
  const configPresent = fs.existsSync(configFile)

  if (!resolvedCommand && !workspacePresent) {
    return {
      id: 'none',
      detected: false,
      confidence: 'low',
      reason: 'no-claudecode-host-runtime-detected',
      suggested: 'claudecode'
    }
  }

  const versionProbe = resolvedCommand ? runCommand(resolvedCommand, ['--version'], 5000) : null
  const authProbe = resolvedCommand ? runCommand(resolvedCommand, ['auth', 'status'], 8000) : null
  const authStatus = parseAuthStatus(authProbe?.stdout)
  const loggedIn = authProbe?.status === 0 && authStatus?.loggedIn === true

  if (resolvedCommand && loggedIn) {
    return {
      id: 'claudecode',
      detected: true,
      confidence: 'high',
      reason: 'claude-code-authenticated',
      workspaceDir,
      configFile,
      claudeCommand: resolvedCommand,
      claudeCommandAvailable: true,
      claudeVersion: clean(versionProbe?.stdout || versionProbe?.stderr),
      authStatus,
      authHealthy: true
    }
  }

  if (resolvedCommand) {
    return {
      id: 'claudecode',
      detected: true,
      confidence: 'medium',
      reason: 'claude-code-command-present',
      workspaceDir,
      configFile,
      claudeCommand: resolvedCommand,
      claudeCommandAvailable: true,
      claudeVersion: clean(versionProbe?.stdout || versionProbe?.stderr),
      authStatus,
      authHealthy: false,
      authHint: configPresent || workspacePresent
        ? 'Claude Code is installed but the current HOME is not authenticated. Run `claude auth status` and `claude auth login` in this same HOME, or mount the real Claude Code config into the isolated HOME before onboarding.'
        : 'Claude Code is installed but no Claude auth files were found in the current HOME. Run `claude auth login` in this same HOME before onboarding.',
      authProbe: {
        status: authProbe?.status ?? null,
        stdout: clean(authProbe?.stdout),
        stderr: clean(authProbe?.stderr),
        error: clean(authProbe?.error)
      },
      suggested: 'claudecode'
    }
  }

  return {
    id: 'claudecode',
    detected: true,
    confidence: 'low',
    reason: 'claude-code-workspace-present',
    workspaceDir,
    configFile,
    claudeCommand: '',
    claudeCommandAvailable: false,
    authHealthy: false,
    authHint: 'Claude Code workspace files exist, but the `claude` command was not found. Add Claude Code to PATH or pass --claude-command <path>.',
    suggested: 'claudecode'
  }
}
