import test from 'node:test'
import assert from 'node:assert/strict'
import {hermesRunInput} from '../adapters/hermes/api_client.mjs'
import {openClawImageAttachments} from '../adapters/openclaw/adapter.mjs'
import {codexImageInputs} from '../adapters/codex/adapter.mjs'
import {claudeImageInputs} from '../adapters/claudecode/adapter.mjs'
const item={request:{params:{message:{parts:[{kind:'image',source:{type:'base64',mediaType:'image/png',data:'YWJj'}}]}}}}
test('runtime image mappings preserve content using each official input shape',()=>{
 assert.deepEqual(openClawImageAttachments(item),[{type:'image',mimeType:'image/png',content:'YWJj'}])
 assert.deepEqual(codexImageInputs(item),[{type:'image',url:'data:image/png;base64,YWJj'}])
 assert.deepEqual(claudeImageInputs(item),[{type:'image',source:{type:'base64',media_type:'image/png',data:'YWJj'}}])
 assert.deepEqual(hermesRunInput([{role:'user',content:[{type:'input_text',text:'describe'},{type:'input_image',image_url:'data:image/png;base64,YWJj'}]}]),[{role:'user',content:[{type:'text',text:'describe'},{type:'image_url',image_url:{url:'data:image/png;base64,YWJj'}}]}])
})
