import test from 'node:test'
import assert from 'node:assert/strict'
import {waitForOpenClawRun} from '../adapters/openclaw/run.mjs'
test('pending and observation timeout do not complete or repeat a run', async()=>{
 const states=[{status:'pending'},{status:'timeout'},{status:'ok',endedAt:10}];let calls=0
 const result=await waitForOpenClawRun({request:async(method,params)=>{assert.equal(method,'agent.wait');assert.equal(params.runId,'r');calls++;return states.shift()}},'r',1000)
 assert.equal(result.status,'ok');assert.equal(calls,3)
})
test('terminal error retains cancellation reason',async()=>{
 await assert.rejects(waitForOpenClawRun({request:async()=>({status:'error',error:'superseded'})},'r',1000),/superseded/)
})
test('transport loss attempts scoped cancellation without submitting another run',async()=>{
 const calls=[]
 await assert.rejects(waitForOpenClawRun({request:async(method,params)=>{calls.push([method,params]);if(method==='agent.wait')throw Error('connection lost');return {ok:true}}},'r',1000,'s'),/connection lost; cancellation requested/)
 assert.deepEqual(calls.map(x=>x[0]),['agent.wait','chat.abort'])
 assert.deepEqual(calls[1][1],{sessionKey:'s',runId:'r'})
})
