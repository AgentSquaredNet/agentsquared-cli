import test from 'node:test'
import assert from 'node:assert/strict'
import {ClaudeCodeClient,extractClaudeCodeUsage} from '../adapters/claudecode/client.mjs'
const run=messages=>new ClaudeCodeClient({queryImpl:async function*(){yield* messages}}).query('test')
test('Claude terminal API errors and truncated streams cannot be returned as success',async()=>{
 await assert.rejects(run([{type:'assistant',message:{content:[{type:'text',text:'partial'}]}}]),/without a terminal result/)
 await assert.rejects(run([{type:'result',subtype:'success',is_error:true,result:'Not logged in'}]),/Not logged in/)
 await assert.rejects(run([{type:'result',subtype:'error_max_turns',errors:['limit reached']}]),/limit reached/)
 const result=await run([{type:'result',subtype:'success',is_error:false,result:'OK'}]);assert.equal(result.text,'OK')
})
test('missing or invalid Claude usage cannot become accurate zero usage',()=>{
 assert.equal(extractClaudeCodeUsage({usage:{}}),null)
 assert.equal(extractClaudeCodeUsage({usage:{input_tokens:-1,output_tokens:1}}),null)
})
