import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHermesAdapter } from '../adapters/hermes/adapter.mjs'

test('Hermes authenticated Responses/Runs readiness does not require optional MCP',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'a2-hermes-http-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const features={responses_api:true,run_submission:true,run_status:true,run_events_sse:true,run_stop:true}
 const key='fixture-local-api-key-32-characters';let authenticated=0
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json')
  if(req.url==='/health')return res.end('{"status":"ok"}')
  assert.equal(req.headers.authorization,'Bearer '+key);authenticated++
  res.end(JSON.stringify(req.url==='/v1/capabilities'?{features}:{data:[{id:'hermes-agent'}]}))
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const apiBase=`http://127.0.0.1:${server.address().port}`
 fs.writeFileSync(path.join(home,'.env'),`API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${key}\nAPI_SERVER_PORT=${server.address().port}\nAPI_SERVER_HOST=127.0.0.1\n`,{mode:0o600})
 fs.writeFileSync(path.join(home,'config.yaml'),'platform_toolsets:\n  api_server:\n  - no_mcp\n',{mode:0o600})
 const command=path.join(home,'hermes'),marker=path.join(home,'unexpected-mcp')
 fs.writeFileSync(command,`#!/bin/sh\nprintf 'unexpected invocation' > '${marker}'\nexit 2\n`,{mode:0o755})
 const result=await createHermesAdapter({localAgentId:'fixture@Owner',hermesHome:home,apiBase,command}).preflight()
 assert.equal(result.ok,true);assert.ok(authenticated>=2);assert.equal(fs.existsSync(marker),false)
})
