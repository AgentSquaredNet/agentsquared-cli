import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { hermesEnvPath } from './common.mjs'

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
  const next = {
    ...current,
    ...updates
  }
  return {
    changed: Object.keys(updates).length > 0,
    envPath: hermesEnvPath(hermesHome),
    envVars: next,
    applied: updates,
    apiKey: clean(next.API_SERVER_KEY)
  }
}
