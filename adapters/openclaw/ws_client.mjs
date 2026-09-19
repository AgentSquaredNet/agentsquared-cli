import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { GatewayClient } from '@openclaw/gateway-client'
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version'
import { runOpenClawCli } from './cli.mjs'

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789'
const DEFAULT_CONNECT_TIMEOUT_MS = 15000
const DEFAULT_REQUEST_TIMEOUT_MS = 180000
const DEFAULT_CLIENT_ID = 'gateway-client'
const DEFAULT_CLIENT_MODE = 'backend'
const DEFAULT_DEVICE_FAMILY = 'agentsquared'
const DEFAULT_ROLE = 'operator'
const DEFAULT_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
  'operator.pairing'
]

function clean(value) {
  return `${value ?? ''}`.trim()
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '')
}

function randomId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(filePath, value) {
  ensureDir(filePath)
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // best-effort on non-posix filesystems
  }
}

function ed25519PublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem)
  const spki = key.export({ type: 'spki', format: 'der' })
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  if (spki.length === prefix.length + 32 && spki.subarray(0, prefix.length).equals(prefix)) {
    return spki.subarray(prefix.length)
  }
  return spki
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash('sha256').update(ed25519PublicKeyRaw(publicKeyPem)).digest('hex')
}

function loadOrCreateDeviceIdentity(filePath) {
  const existing = readJson(filePath)
  if (
    existing?.version === 1
    && clean(existing.deviceId)
    && clean(existing.publicKeyPem)
    && clean(existing.privateKeyPem)
  ) {
    return {
      deviceId: clean(existing.deviceId),
      publicKeyPem: existing.publicKeyPem,
      privateKeyPem: existing.privateKeyPem
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const identity = {
    version: 1,
    deviceId: '',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAtMs: Date.now()
  }
  identity.deviceId = fingerprintPublicKey(identity.publicKeyPem)
  writeJson(filePath, identity)
  return {
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem
  }
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem)
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key)
  return base64UrlEncode(signature)
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(ed25519PublicKeyRaw(publicKeyPem))
}

function authStorePath(stateDir) {
  return path.join(stateDir, 'openclaw-device-auth.json')
}

function identityPath(stateDir) {
  return path.join(stateDir, 'openclaw-device.json')
}

function loadStoredDeviceToken(stateDir, { deviceId, role }) {
  const store = readJson(authStorePath(stateDir))
  if (store?.version !== 1 || clean(store?.deviceId) !== clean(deviceId)) {
    return null
  }
  const entry = store.tokens?.[clean(role)]
  if (!entry || typeof entry !== 'object') {
    return null
  }
  return {
    token: clean(entry.token),
    scopes: Array.isArray(entry.scopes) ? entry.scopes.map((scope) => clean(scope)).filter(Boolean) : []
  }
}

function storeDeviceToken(stateDir, {
  deviceId,
  role,
  token,
  scopes = []
}) {
  const filePath = authStorePath(stateDir)
  const existing = readJson(filePath)
  const next = existing?.version === 1 && clean(existing.deviceId) === clean(deviceId)
    ? existing
    : {
        version: 1,
        deviceId: clean(deviceId),
        tokens: {}
      }
  next.tokens = next.tokens && typeof next.tokens === 'object' ? next.tokens : {}
  next.tokens[clean(role)] = {
    token: clean(token),
    scopes: Array.isArray(scopes) ? scopes.map((scope) => clean(scope)).filter(Boolean) : [],
    updatedAtMs: Date.now()
  }
  writeJson(filePath, next)
}

function clearDeviceToken(stateDir, {
  deviceId,
  role
}) {
  const filePath = authStorePath(stateDir)
  const existing = readJson(filePath)
  if (existing?.version !== 1 || clean(existing.deviceId) !== clean(deviceId)) {
    return
  }
  if (!existing.tokens || typeof existing.tokens !== 'object') {
    return
  }
  delete existing.tokens[clean(role)]
  writeJson(filePath, existing)
}

function resolveDefaultConfigPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json')
}

function resolveConfiguredGatewayUrl(config = null) {
  const gateway = config?.gateway
  if (!gateway || typeof gateway !== 'object') {
    return ''
  }
  const configuredPort = Number.parseInt(`${gateway.port ?? ''}`, 10)
  if (!Number.isFinite(configuredPort) || configuredPort <= 0) {
    return ''
  }
  const loopbackUrl = new URL(`ws://127.0.0.1:${configuredPort}`)
  const configuredPath = clean(gateway.path)
  if (configuredPath && configuredPath !== '/') {
    loopbackUrl.pathname = configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`
  }
  return loopbackUrl.toString()
}

function readGatewayAuthFromConfig(configPath) {
  const config = readJson(configPath)
  const auth = config?.gateway?.auth
  if (!auth || typeof auth !== 'object') {
    return { mode: '', token: '', password: '' }
  }
  return {
    mode: clean(auth.mode),
    token: typeof auth.token === 'string' ? auth.token : '',
    password: typeof auth.password === 'string' ? auth.password : ''
  }
}

function readGatewayBootstrapConfig(configPath) {
  const resolvedConfigPath = clean(configPath) || resolveDefaultConfigPath()
  const config = readJson(resolvedConfigPath)
  const auth = config?.gateway?.auth
  const authMode = auth && typeof auth === 'object' ? clean(auth.mode) : ''
  return {
    configPath: resolvedConfigPath,
    config,
    gatewayUrl: resolveConfiguredGatewayUrl(config),
    authMode,
    gatewayToken: auth && typeof auth === 'object' && typeof auth.token === 'string' ? auth.token : '',
    gatewayPassword: auth && typeof auth === 'object' && typeof auth.password === 'string' ? auth.password : ''
  }
}

function isLoopbackHost(hostname) {
  const normalized = clean(hostname).toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

function normalizeGatewayProtocol(rawProtocol) {
  const protocol = clean(rawProtocol).toLowerCase()
  if (protocol === 'ws:' || protocol === 'wss:') {
    return protocol
  }
  if (protocol === 'http:') {
    return 'ws:'
  }
  if (protocol === 'https:') {
    return 'wss:'
  }
  return 'ws:'
}

function parseGatewayUrl(rawGatewayUrl) {
  const value = clean(rawGatewayUrl)
  if (!value) {
    return null
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`OpenClaw gateway URL was invalid: ${value}`)
  }
  return {
    raw: value,
    protocol: normalizeGatewayProtocol(parsed.protocol),
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname || '',
    search: parsed.search || ''
  }
}

function resolveLoopbackGatewayUrl({
  explicitGatewayUrl = '',
  discoveredGatewayUrl = ''
} = {}) {
  const explicit = parseGatewayUrl(explicitGatewayUrl)
  if (explicit) {
    if (!isLoopbackHost(explicit.hostname)) {
      throw new Error('OpenClaw host mode requires a local loopback gateway URL. Remote or tailnet OpenClaw Gateway URLs are not supported for AgentSquared onboarding or gateway startup.')
    }
    return explicit.raw
  }

  const discovered = parseGatewayUrl(discoveredGatewayUrl)
  if (!discovered) {
    return DEFAULT_GATEWAY_URL
  }
  const port = clean(discovered.port)
  if (!port) {
    throw new Error('OpenClaw gateway status did not report a local port. AgentSquared can only connect to a loopback OpenClaw Gateway.')
  }
  const loopbackUrl = new URL(`${discovered.protocol}//127.0.0.1:${port}`)
  if (clean(discovered.pathname) && discovered.pathname !== '/') {
    loopbackUrl.pathname = discovered.pathname
  }
  if (clean(discovered.search)) {
    loopbackUrl.search = discovered.search
  }
  return loopbackUrl.toString()
}

const runProcess = runOpenClawCli

export async function resolveOpenClawGatewayBootstrap({
  configPath = '',
  gatewayUrl = '',
  gatewayToken = '',
  gatewayPassword = ''
} = {}) {
  const configBootstrap = readGatewayBootstrapConfig(clean(configPath) || resolveDefaultConfigPath())
  const authFromConfig = {
    mode: clean(configBootstrap.authMode),
    token: clean(configBootstrap.gatewayToken),
    password: clean(configBootstrap.gatewayPassword)
  }
  const resolvedGatewayUrl = resolveLoopbackGatewayUrl({
    explicitGatewayUrl: gatewayUrl,
    discoveredGatewayUrl: configBootstrap.gatewayUrl
  })
  return {
    gatewayUrl: resolvedGatewayUrl,
    gatewayToken: clean(gatewayToken) || clean(process.env.OPENCLAW_GATEWAY_TOKEN) || authFromConfig.token,
    gatewayPassword: clean(gatewayPassword) || clean(process.env.OPENCLAW_GATEWAY_PASSWORD) || authFromConfig.password,
    authMode: authFromConfig.mode,
    configPath: configBootstrap.configPath,
    config: configBootstrap.config
  }
}

function isGatewayRequestError(error, code) {
  return clean(error?.detailCode || error?.details?.code).toUpperCase() === clean(code).toUpperCase()
}

function toRequestError(error) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {}
  const requestId = clean(details.requestId)
  const detailCode = clean(details.code)
  const reason = clean(error?.message) || 'gateway request failed'
  const next = new Error(reason)
  next.details = details
  next.detailCode = detailCode
  next.requestId = requestId
  return next
}

async function approveLatestPairing({
  requestId,
  command = 'openclaw',
  cwd = '',
  gatewayUrl = '',
  gatewayToken = '',
  gatewayPassword = ''
} = {}) {
  if (!clean(requestId)) throw new Error('OpenClaw pairing requires a specific request ID; approve this device explicitly.')
  const args = ['devices', 'approve', clean(requestId), '--json']
  if (clean(gatewayUrl)) {
    args.push('--url', clean(gatewayUrl))
    if (clean(gatewayToken)) {
      args.push('--token', clean(gatewayToken))
    }
    if (clean(gatewayPassword)) {
      args.push('--password', clean(gatewayPassword))
    }
  }
  const result = await runProcess(command, args, {
    cwd,
    timeoutMs: 20000
  })
  return { approved: true }
}

export class OpenClawGatewayWsSession {
  constructor({ url, gatewayToken = '', gatewayPassword = '', stateDir,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.eventListeners = new Set()
    this.connectTimeoutMs = connectTimeoutMs
    this.connectionPromise = null
    this.connected = false
    const check = (params) => {
      params.signal?.throwIfAborted()
      params.assertCurrent?.()
      const token = loadStoredDeviceToken(stateDir, params)?.token ?? null
      return params.expectedToken === undefined || params.expectedToken === token
    }
    this.client = new GatewayClient({
      url, token: gatewayToken || undefined, password: gatewayPassword || undefined,
      minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
      clientName: DEFAULT_CLIENT_ID, mode: DEFAULT_CLIENT_MODE,
      clientVersion: '2.0.0', deviceFamily: DEFAULT_DEVICE_FAMILY,
      role: DEFAULT_ROLE, scopes: [...DEFAULT_SCOPES], requestTimeoutMs,
      connectChallengeTimeoutMs: connectTimeoutMs,
      deviceIdentity: loadOrCreateDeviceIdentity(identityPath(stateDir)),
      hostDeps: {
        signDevicePayload, publicKeyRawBase64UrlFromPem,
        loadDeviceAuthToken: (params) => {
          params.signal?.throwIfAborted()
          params.assertCurrent?.()
          return loadStoredDeviceToken(stateDir, params)
        },
        storeDeviceAuthToken: (params) => { if (check(params)) storeDeviceToken(stateDir, params) },
        clearDeviceAuthToken: (params) => { if (check(params)) clearDeviceToken(stateDir, params) }
      },
      onHelloOk: (hello) => { this.connected = true; this.resolveConnect?.(hello) },
      onConnectError: (error) => this.rejectConnect?.(error),
      onClose: () => { this.connected = false },
      onEvent: (event) => {
        for (const listener of this.eventListeners) {
          try { listener(event) } catch { /* observer isolation */ }
        }
      }
    })
  }

  async connect() {
    if (this.connected) return
    if (this.connectionPromise) return this.connectionPromise
    this.connectionPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenClaw gateway connection timed out')), this.connectTimeoutMs)
      this.resolveConnect = (hello) => { clearTimeout(timer); resolve(hello) }
      this.rejectConnect = (error) => { clearTimeout(timer); reject(error) }
      this.client.start()
    })
    try { return await this.connectionPromise }
    catch (error) { await this.close(); throw error }
    finally { this.connectionPromise = null }
  }

  async request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    await this.connect()
    return this.client.request(method, params, { timeoutMs })
  }

  onEvent(listener) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async close() {
    this.connected = false
    await this.client.stopAndWait()
  }
}

export async function withOpenClawGatewayClient(options, fn) {
  const bootstrap = await resolveOpenClawGatewayBootstrap(options)
  const stateDir = clean(options?.stateDir) || path.join(os.homedir(), '.openclaw', 'workspace', 'AgentSquared', 'default', 'runtime')
  const clientOptions = {
    url: clean(bootstrap.gatewayUrl) || DEFAULT_GATEWAY_URL,
    gatewayToken: clean(bootstrap.gatewayToken),
    gatewayPassword: clean(bootstrap.gatewayPassword),
    stateDir,
    connectTimeoutMs: options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  const tryConnect = async () => {
    const client = new OpenClawGatewayWsSession(clientOptions)
    await client.connect()
    return client
  }

  let client
  try {
    client = await tryConnect()
  } catch (error) {
    const pairingStrategy = clean(options?.pairingStrategy || 'auto').toLowerCase() || 'auto'
    if (pairingStrategy === 'none' || !isGatewayRequestError(error, 'PAIRING_REQUIRED')) {
      throw error
    }
    await approveLatestPairing({
      requestId: error?.details?.requestId,
      command: options?.command,
      cwd: options?.cwd,
      gatewayUrl: clean(bootstrap.gatewayUrl),
      gatewayToken: clean(bootstrap.gatewayToken),
      gatewayPassword: clean(bootstrap.gatewayPassword)
    })
    client = await tryConnect()
  }

  try {
    return await fn(client, {
      gatewayUrl: clean(bootstrap.gatewayUrl),
      configPath: clean(bootstrap.configPath),
      authMode: clean(bootstrap.authMode)
    })
  } finally {
    await client.close()
  }
}
