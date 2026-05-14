import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { hermesConfigPath, hermesEnvPath } from './common.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

export function readHermesEnv(hermesHome = '') {
  const envPath = hermesEnvPath(hermesHome)
  const values = {}
  if (!fs.existsSync(envPath)) {
    return values
  }
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue
    }
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key) {
      values[key] = value
    }
  }
  return values
}

export function writeHermesEnvValues(hermesHome = '', updates = {}) {
  const envPath = hermesEnvPath(hermesHome)
  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 })
  const existingLines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    : []
  const keys = Object.keys(updates)
  const nextLines = []
  const consumed = new Set()
  for (const rawLine of existingLines) {
    const line = `${rawLine ?? ''}`
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      nextLines.push(line)
      continue
    }
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    if (keys.includes(key)) {
      nextLines.push(`${key}=${`${updates[key] ?? ''}`.replace(/[\r\n]+/g, '')}`)
      consumed.add(key)
      continue
    }
    nextLines.push(line)
  }
  for (const key of keys) {
    if (!consumed.has(key)) {
      nextLines.push(`${key}=${`${updates[key] ?? ''}`.replace(/[\r\n]+/g, '')}`)
    }
  }
  const payload = `${nextLines.filter((line, index, lines) => !(index === lines.length - 1 && line === '')).join('\n')}\n`
  const tmpPath = path.join(path.dirname(envPath), `.env_${crypto.randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(tmpPath, payload, { mode: 0o600 })
  fs.renameSync(tmpPath, envPath)
  fs.chmodSync(envPath, 0o600)
  return envPath
}

function writeHermesConfigText(configPath = '', text = '', mode = 0o600) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
  const tmpPath = path.join(path.dirname(configPath), `config_${crypto.randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(tmpPath, text, { mode })
  fs.renameSync(tmpPath, configPath)
  fs.chmodSync(configPath, mode)
}

function lineIsTopLevel(line = '') {
  const trimmed = line.trim()
  return Boolean(trimmed && !trimmed.startsWith('#') && !/^\s/.test(line))
}

function lineIsPlatformKey(line = '') {
  return /^  [A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(line)
}

export function ensureHermesApiServerNoMcpConfig(hermesHome = '') {
  const configPath = hermesConfigPath(hermesHome)
  const desired = ['  api_server:', '  - no_mcp']
  const mode = fs.existsSync(configPath)
    ? (fs.statSync(configPath).mode & 0o777)
    : 0o600
  const original = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8')
    : ''
  const lines = original.split(/\r?\n/)
  let platformIndex = lines.findIndex((line) => /^platform_toolsets:\s*(?:#.*)?$/.test(line))
  if (platformIndex < 0) {
    const next = original
      ? `${original.replace(/\s*$/, '\n')}platform_toolsets:\n${desired.join('\n')}\n`
      : `platform_toolsets:\n${desired.join('\n')}\n`
    writeHermesConfigText(configPath, next, mode)
    return {
      changed: true,
      configPath
    }
  }

  let blockEnd = lines.length
  for (let index = platformIndex + 1; index < lines.length; index += 1) {
    if (lineIsTopLevel(lines[index])) {
      blockEnd = index
      break
    }
  }

  const apiIndex = lines.findIndex((line, index) => (
    index > platformIndex
    && index < blockEnd
    && /^  api_server:\s*(?:#.*)?$/.test(line)
  ))
  if (apiIndex >= 0) {
    let nextKey = blockEnd
    for (let index = apiIndex + 1; index < blockEnd; index += 1) {
      if (lineIsPlatformKey(lines[index])) {
        nextKey = index
        break
      }
    }
    const existing = lines.slice(apiIndex, nextKey).map((line) => line.trim()).filter(Boolean)
    if (existing.length === 2 && existing[0] === 'api_server:' && existing[1] === '- no_mcp') {
      return {
        changed: false,
        configPath
      }
    }
    lines.splice(apiIndex, nextKey - apiIndex, ...desired)
  } else {
    lines.splice(blockEnd, 0, ...desired)
  }

  const next = `${lines.join('\n').replace(/\s*$/, '')}\n`
  if (next === original) {
    return {
      changed: false,
      configPath
    }
  }
  writeHermesConfigText(configPath, next, mode)
  return {
    changed: true,
    configPath
  }
}

export function ensureHermesApiServerEnv(hermesHome = '') {
  const current = readHermesEnv(hermesHome)
  const updates = {}
  if (clean(current.API_SERVER_ENABLED).toLowerCase() !== 'true') {
    updates.API_SERVER_ENABLED = 'true'
  }
  if (!clean(current.API_SERVER_KEY)) {
    updates.API_SERVER_KEY = crypto.randomBytes(32).toString('hex')
  }
  if (Object.keys(updates).length > 0) {
    writeHermesEnvValues(hermesHome, updates)
  }
  const configResult = ensureHermesApiServerNoMcpConfig(hermesHome)
  const next = {
    ...current,
    ...updates
  }
  return {
    changed: Object.keys(updates).length > 0 || configResult.changed,
    envPath: hermesEnvPath(hermesHome),
    configPath: configResult.configPath,
    configChanged: configResult.changed,
    envVars: next,
    applied: updates,
    apiKey: clean(next.API_SERVER_KEY)
  }
}
