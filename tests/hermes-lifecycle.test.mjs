import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { postHermesResponseStream } from '../adapters/hermes/api_client.mjs'

test('Hermes truncated stream reads authoritative state and cancels failed run', async () => {
 let stopped=false, created=0, text=''
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json')
  if(req.url==='/v1/runs') { created++;assert.ok(req.headers['idempotency-key']);res.statusCode=202;res.end('{"run_id":"r1"}'); }
  else if(req.url.endsWith('/events')) {res.setHeader('content-type','text/event-stream');res.end('data: {"event":"message.delta","run_id":"r1","delta":"partial"}\r\n\r\n')}
  else if(req.url.endsWith('/stop')) {stopped=true;res.end('{"status":"stopping"}')}
  else {res.end('{"status":"failed"}')}
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try {
  await assert.rejects(postHermesResponseStream({apiBase:`http://127.0.0.1:${server.address().port}`,input:'test',onTextDelta:d=>{text+=d}}),/failed/)
  assert.equal(text,'partial')
  assert.equal(created,1);assert.equal(stopped,true)
 } finally {await new Promise(resolve=>server.close(resolve))}
})
