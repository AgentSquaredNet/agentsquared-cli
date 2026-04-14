import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveUserPath } from '../shared/paths.mjs'

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

export function loadRuntimeKeyBundle(keyFile) {
  return JSON.parse(fs.readFileSync(resolveUserPath(keyFile), 'utf8'))
}

function createPrivateKey(privateKeyPem) {
  return crypto.createPrivateKey(privateKeyPem)
}

export function signText(bundle, message) {
  const key = createPrivateKey(bundle.privateKeyPem)
  const payload = Buffer.from(message, 'utf8')
  if (bundle.keyType === 2) {
    return toBase64Url(crypto.sign(null, payload, key))
  }
  if (bundle.keyType === 3) {
    return toBase64Url(crypto.sign('sha256', payload, key))
  }
  throw new Error(`Unsupported keyType: ${bundle.keyType}`)
}

export function publicKeyFingerprint(bundle) {
  const digest = crypto.createHash('sha256').update(String(bundle.publicKey)).digest('hex')
  return `sha256:${digest.slice(0, 16)}`
}

export function buildEd25519Bundle() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicJwk = publicKey.export({ format: 'jwk' })
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicBytes = Buffer.from(publicJwk.x, 'base64url')
  return {
    keyType: 2,
    keyTypeName: 'agent_runtime_ed25519',
    publicKey: publicJwk.x,
    publicKeyEncoding: 'base64url-raw-32',
    publicKeyHex: publicBytes.toString('hex'),
    privateKeyPem: privatePem.toString(),
    privateKeyEncoding: 'pkcs8-pem',
    signingAlgorithm: 'ed25519'
  }
}

export function buildSecp256k1Bundle() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const publicJwk = publicKey.export({ format: 'jwk' })
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const x = Buffer.from(publicJwk.x, 'base64url')
  const y = Buffer.from(publicJwk.y, 'base64url')
  const prefix = (y[y.length - 1] & 1) === 0 ? 0x02 : 0x03
  const compressed = Buffer.concat([Buffer.from([prefix]), x])
  return {
    keyType: 3,
    keyTypeName: 'agent_runtime_secp256k1',
    publicKey: compressed.toString('hex'),
    publicKeyEncoding: 'hex-compressed-33',
    publicKeyHex: compressed.toString('hex'),
    privateKeyPem: privatePem.toString(),
    privateKeyEncoding: 'pkcs8-pem',
    signingAlgorithm: 'ecdsa-secp256k1-sha256'
  }
}

export function writeRuntimeKeyBundle(outFile, bundle) {
  const outPath = resolveUserPath(outFile)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(outPath, 0o600)
  return outPath
}

export function generateRuntimeKeyBundle(keyType = 'ed25519') {
  const normalized = `${keyType}`.trim()
  const bundle = normalized === 'secp256k1' ? buildSecp256k1Bundle() : buildEd25519Bundle()
  bundle.generatedAt = new Date().toISOString()
  return bundle
}
