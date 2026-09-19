import test from 'node:test'
import assert from 'node:assert/strict'
import { buildClaudeCodeSafeOptions } from '../adapters/claudecode/client.mjs'
test('none settings cannot load project hooks and tools; unauthorized tools denied', async () => {
 const safe=buildClaudeCodeSafeOptions({settingSources:'none'})
 try {
  assert.deepEqual(safe.options.settingSources,[])
  assert.equal((await safe.options.canUseTool('Bash')).behavior,'deny')
  assert.equal((await safe.options.canUseTool('mcp__anything')).behavior,'deny')
  assert.equal((await safe.options.canUseTool('Unknown')).behavior,'deny')
 } finally {safe.clearTimeout()}
})
