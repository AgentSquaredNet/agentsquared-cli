import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexClient } from '../adapters/codex/client.mjs'

test('server request cannot resolve a client RPC with the same ID; approvals fail closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2-codex-protocol-'))
  const binary = path.join(dir, 'codex')
  await fs.writeFile(binary, `#!${process.execPath}
import readline from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
let waiting;
readline.createInterface({input:process.stdin}).on('line', line => {
 const msg=JSON.parse(line);
 if(msg.method==='initialize') send({id:msg.id,result:{userAgent:'codex/0.155.1'}});
 else if(msg.method==='thread/list') {
  waiting=msg.id;
  send({id:msg.id,method:'item/commandExecution/requestApproval',params:{}});
 } else if(msg.id===waiting && msg.result?.decision==='decline') {
  send({id:waiting,result:{data:[{id:'thread-1',name:'saved'}],nextCursor:null}});
 }
});`, { mode: 0o700 })
  const client = new CodexClient({codexPath:binary,timeoutMs:1500})
  try {
    await client.connect()
    const response = await client.threadList()
    assert.equal(response.data[0].id, 'thread-1')
  } finally { await client.close(); await fs.rm(dir,{recursive:true,force:true}) }
})
