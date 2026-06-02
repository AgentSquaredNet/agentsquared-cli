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

function getCommandPath(command = '') {
  const normalized = clean(command)
  if (!normalized) {
    return ''
  }
  if (normalized.includes(path.sep)) {
    return resolveUserPath(normalized)
  }
  const result = spawnSync('sh', ['-lc', `command -v "${normalized.replace(/"/g, '\\"')}"`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return clean(result.stdout).split(/\r?\n/).find(Boolean) || ''
}

export async function detectCodexHostEnvironment({
  command = ''
} = {}) {
  const defaultMacPath = '/Applications/Codex.app/Contents/Resources/codex'
  
  // 1. Check user configured command
  const customCommand = clean(command)
  if (customCommand) {
    const isAvailable = shellCommandExists(customCommand)
    const resolvedPath = getCommandPath(customCommand)
    
    if (isAvailable && resolvedPath) {
      return {
        id: 'codex',
        detected: true,
        confidence: 'high',
        reason: 'custom-codex-command-present',
        codexPath: resolvedPath,
        codexCommandAvailable: true,
        workspaceDir: path.join(os.homedir(), '.codex')
      }
    }
  }

  // 2. Check default macOS Codex.app path
  if (fs.existsSync(defaultMacPath)) {
    return {
      id: 'codex',
      detected: true,
      confidence: 'high',
      reason: 'default-macos-codex-present',
      codexPath: defaultMacPath,
      codexCommandAvailable: true,
      workspaceDir: path.join(os.homedir(), '.codex')
    }
  }

  // 3. Check system PATH 'codex' command
  const systemAvailable = shellCommandExists('codex')
  const systemPath = getCommandPath('codex')
  if (systemAvailable && systemPath) {
    return {
      id: 'codex',
      detected: true,
      confidence: 'medium',
      reason: 'system-path-codex-present',
      codexPath: systemPath,
      codexCommandAvailable: true,
      workspaceDir: path.join(os.homedir(), '.codex')
    }
  }

  return {
    id: 'none',
    detected: false,
    confidence: 'low',
    reason: 'no-codex-host-runtime-detected',
    suggested: 'codex'
  }
}
