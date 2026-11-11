import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runtimeCompatibility, nodeCompatible } from '../lib/runtime/compatibility.mjs'

test('Hermes uses its official --version flag, not the unsupported version subcommand', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-hermes-version-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const command = path.join(root, 'hermes')
  fs.writeFileSync(command, '#!/bin/sh\n[ "$1" = "--version" ] || exit 2\nprintf "Hermes Agent v0.21.3 (2026.9.14)\\n"\n', { mode: 0o755 })
  const result = runtimeCompatibility('hermes', command)
  assert.equal(result.actualVersion, '0.21.3')
  assert.equal(result.compatible, nodeCompatible())
})
