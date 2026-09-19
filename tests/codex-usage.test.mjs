import test from 'node:test'
import assert from 'node:assert/strict'
import {extractCodexUsage} from '../adapters/codex/usage.mjs'
test('cache tokens are not charged twice and session totals never substitute for turn usage',()=>{
 const usage=extractCodexUsage({last:{inputTokens:1000,outputTokens:20,cachedInputTokens:600,cacheWriteInputTokens:100}})
 assert.equal(usage.inputTokens,300)
 assert.equal(usage.inputTokens+usage.cacheReadInputTokens+usage.cacheCreationInputTokens,1000)
 assert.equal(extractCodexUsage({total:{inputTokens:10000}}),null)
 assert.equal(extractCodexUsage({last:{inputTokens:10,outputTokens:1,cachedInputTokens:11}}),null)
})
