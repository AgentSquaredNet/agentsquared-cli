import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { hermesProjectRoot } from './adapters/hermes/common.mjs'
import { resolveHermesOwnerTarget } from './adapters/hermes/adapter.mjs'
import { ensureHermesApiServerNoMcpConfig } from './adapters/hermes/env.mjs'
import { probeHermesMcp, resolveHermesOwnerTargetViaMcp, sendHermesOwnerMessageViaMcp } from './adapters/hermes/mcp_client.mjs'
import { findLocalOfficialSkill, findOfficialSkillsRoot } from './lib/conversation/local_skills.mjs'
import { normalizeConversationControl } from './lib/conversation/policy.mjs'
import { buildReceiverBaseReport, buildSenderBaseReport, renderConversationDetails } from './lib/conversation/templates.mjs'
import { createInboxStore } from './lib/gateway/inbox.mjs'
import { createAgentRouter } from './lib/routing/agent_router.mjs'
import { agentSquaredAgentIdForWire, normalizeAgentSquaredAgentId, parseAgentSquaredAgentId } from './lib/shared/agent_id.mjs'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function assertCliSmoke(argv, expected, message) {
  const result = spawnSync(process.execPath, ['./bin/a2-cli.js', ...argv], {
    cwd: process.cwd(),
    encoding: 'utf8'
  })
  assert(result.status === 0, `${message}: ${result.stderr || result.stdout}`)
  assert(`${result.stdout}`.includes(expected), `${message}: expected ${expected}`)
}

assertCliSmoke(['--help'], 'AgentSquared CLI', 'a2-cli --help should load the public CLI entrypoint')
assertCliSmoke(['--version'], '1.6.3', 'a2-cli --version should print package version')
assert(typeof resolveHermesOwnerTarget === 'function', 'Hermes adapter should export owner-route resolver used by CLI')

assert(normalizeAgentSquaredAgentId('A2:Helper@ExampleOwner') === 'helper@exampleowner', 'A2-prefixed AgentSquared ID should provide a lowercase comparison key')
assert(normalizeAgentSquaredAgentId('helper@ExampleOwner') === 'helper@exampleowner', 'bare AgentSquared ID should provide a lowercase comparison key')
assert(agentSquaredAgentIdForWire('A2:Helper@ExampleOwner') === 'Helper@ExampleOwner', 'wire AgentSquared ID should strip A2 prefix without lowercasing signed identity')
assert(parseAgentSquaredAgentId('A2:Helper@ExampleOwner').platformExplicit === true, 'A2-prefixed AgentSquared ID should record explicit platform context')
try {
  normalizeAgentSquaredAgentId('feishu:helper@ExampleOwner')
  assert(false, 'communication-channel targets must not be accepted as AgentSquared Agent IDs')
} catch (error) {
  assert(String(error?.message || '').includes('AgentSquared ID'), 'wrong validation error for non-A2 channel target')
}

const turns = [
  {
    turnIndex: 1,
    outboundText: 'Please compare your workflow.',
    replyText: 'I use reusable migration patterns.',
    remoteStopReason: 'continue'
  },
  {
    turnIndex: 2,
    outboundText: 'What should I adopt?',
    replyText: 'Adopt lazy migration and compact reports.',
    remoteStopReason: 'completed'
  }
]

const sender = buildSenderBaseReport({
  localAgentId: 'guide@ExampleUser',
  targetAgentId: 'helper@ExampleOwner',
  selectedSkill: 'agent-mutual-learning',
  receiverSkill: 'agent-mutual-learning',
  sentAt: '2026-04-20T01:00:00.000Z',
  replyAt: '2026-04-20T01:03:00.000Z',
  conversationKey: 'conversation_smoke',
  peerSessionId: 'session_smoke',
  turnCount: 2,
  stopReason: 'completed',
  overallSummary: 'Both agents identified lazy migration and compact reports as reusable patterns.',
  conversationTurns: turns
})

const receiver = buildReceiverBaseReport({
  localAgentId: 'helper@ExampleOwner',
  remoteAgentId: 'guide@ExampleUser',
  incomingSkillHint: 'agent-mutual-learning',
  selectedSkill: 'agent-mutual-learning',
  conversationKey: 'conversation_smoke',
  receivedAt: '2026-04-20T01:01:00.000Z',
  repliedAt: '2026-04-20T01:03:00.000Z',
  skillSummary: 'Both agents identified lazy migration and compact reports as reusable patterns.',
  conversationTurns: 2,
  stopReason: 'completed',
  conversationTurnDetails: turns
})

const detail = renderConversationDetails({
  ownerReport: {
    ...sender,
    conversationKey: 'conversation_smoke'
  }
})

const rendered = [sender.message, receiver.message, detail].join('\n')
for (const forbidden of [
  'Conversation' + ' Key',
  'Detailed' + ' conversation',
  'Actions' + ' taken',
  'Content' + ' sent',
  'Stopped' + ' with reason',
  'Transport' + ' Session'
]) {
  assert(!rendered.includes(forbidden), `old report template phrase is still present: ${forbidden}`)
}
for (const required of ['Conversation result', 'Conversation ID', 'Sender:', 'Recipient:', 'Status:', 'Time:', 'Skill:', 'Overall summary', 'Conversation details', 'Full conversation', 'Send:', 'Reply:']) {
  assert(rendered.includes(required), `new report template phrase is missing: ${required}`)
}
assert(normalizeConversationControl({ stopReason: 'skill-unavailable', decision: 'done' }).stopReason === 'skill-unavailable', 'skill-unavailable must be preserved as a final conversation status')

const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-inbox-smoke-'))
try {
const store = createInboxStore({ inboxDir })
  const { entry } = store.appendEntry({
    agentId: 'guide@ExampleUser',
    selectedSkill: 'agent-mutual-learning',
    mailboxKey: 'outbound:conversation_smoke',
    item: {
      inboundId: 'entry_smoke',
      remoteAgentId: 'helper@ExampleOwner'
    },
    ownerReport: {
      ...sender,
      final: true,
      conversationKey: 'conversation_smoke'
    },
    peerResponse: {
      metadata: {
        conversationKey: 'conversation_smoke'
      }
    }
  })
  assert(entry.conversationKey === 'conversation_smoke', 'sender owner report was not indexed by conversation key')
  assert(entry.remoteAgentId === 'helper@ExampleOwner', 'sender owner report did not normalize the remote agent id')
  assert(entry.messageExcerpt.includes('Please compare'), 'sender owner report did not expose the outbound message excerpt')
  assert(entry.replyExcerpt.includes('compact reports'), 'sender owner report did not expose the reply excerpt')
  const found = store.findConversation('conversation_smoke')
  assert(found?.finalEntry?.ownerReport?.conversationTurns?.[0]?.replyText, 'conversation lookup did not return the stored turn transcript')

  const inboundReport = {
    ...receiver,
    final: true,
    conversationKey: 'conversation_inbound_smoke'
  }
  const inbound = store.appendEntry({
    agentId: 'helper@ExampleOwner',
    selectedSkill: 'agent-mutual-learning',
    mailboxKey: 'inbound:conversation_inbound_smoke',
    item: {
      inboundId: 'entry_inbound_smoke',
      request: {
        id: 'request_inbound_smoke',
        params: {
          metadata: {
            conversationKey: 'conversation_inbound_smoke'
          },
          message: {
            parts: [{ kind: 'text', text: 'Inbound hello' }]
          }
        }
      }
    },
    ownerReport: inboundReport,
    peerResponse: {
      message: {
        parts: [{ kind: 'text', text: 'Inbound reply' }]
      },
      metadata: {
        conversationKey: 'conversation_inbound_smoke'
      }
    }
  })
  assert(inbound.entry.conversationKey === 'conversation_inbound_smoke', 'receiver owner report was not indexed by conversation key')
  assert(inbound.entry.remoteAgentId === 'guide@ExampleUser', 'receiver owner report did not normalize the remote agent id')
  assert(store.findConversation('conversation_inbound_smoke')?.finalEntry?.ownerReport?.conversationKey === 'conversation_inbound_smoke', 'receiver conversation lookup failed')
} finally {
  fs.rmSync(inboxDir, { recursive: true, force: true })
}

const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-hermes-mcp-'))
try {
  fs.writeFileSync(path.join(hermesHome, 'config.yaml'), [
    'platform_toolsets:',
    '  cli:',
    '  - hermes-cli',
    'code_execution:',
    '  timeout: 300'
  ].join('\n'), 'utf8')
  const configResult = ensureHermesApiServerNoMcpConfig(hermesHome)
  const configText = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')
  assert(configResult.changed === true, 'Hermes config should be updated with api_server no_mcp')
  assert(configText.includes('  api_server:\n  - no_mcp\ncode_execution:'), 'Hermes api_server no_mcp should be inserted inside platform_toolsets')
  assert(ensureHermesApiServerNoMcpConfig(hermesHome).changed === false, 'Hermes config no_mcp update should be idempotent')

  const fakeMcp = path.join(hermesHome, 'fake-hermes-mcp.mjs')
  fs.writeFileSync(fakeMcp, [
    '#!/usr/bin/env node',
    'function write(message) {',
    '  process.stdout.write(`${JSON.stringify(message)}\\n`)',
    '}',
    'function payloadFor(name, args) {',
    '  if (name === "conversations_list") return { count: 2, conversations: [',
    '    { session_key: "internal", platform: "api_server", updated_at: "2026-04-20T01:02:00.000Z" },',
    '    { session_key: "owner", platform: "telegram", display_name: "Owner Chat", updated_at: "2026-04-20T01:00:00.000Z" }',
    '  ] }',
    '  if (name === "conversation_get") return { session_key: args.session_key, session_id: "s_owner", platform: "telegram", chat_id: "-1001", display_name: "Owner Chat" }',
    '  if (name === "channels_list") return { count: 1, channels: [{ target: "telegram:-1001", platform: "telegram", name: "Owner Chat" }] }',
    '  if (name === "messages_send") return { success: true, target: args.target, message: args.message }',
    '  return { error: `unexpected tool ${name}` }',
    '}',
    'function handle(message) {',
    '  if (!message.id) return',
    '  if (message.method === "initialize") return write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-hermes" } } })',
    '  if (message.method === "tools/list") return write({ jsonrpc: "2.0", id: message.id, result: { tools: [',
    '    { name: "conversations_list" }, { name: "conversation_get" }, { name: "messages_send" }, { name: "channels_list" }',
    '  ] } })',
    '  if (message.method === "tools/call") {',
    '    const result = payloadFor(message.params.name, message.params.arguments || {})',
    '    return write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } })',
    '  }',
    '  write({ jsonrpc: "2.0", id: message.id, error: { message: `unexpected method ${message.method}` } })',
    '}',
    'let buffer = ""',
    'process.stdin.on("data", (chunk) => {',
    '  buffer += chunk.toString("utf8")',
    '  while (buffer.includes("\\n")) {',
    '    const idx = buffer.indexOf("\\n")',
    '    const raw = buffer.slice(0, idx).trim()',
    '    buffer = buffer.slice(idx + 1)',
    '    if (raw) handle(JSON.parse(raw))',
    '  }',
    '})'
  ].join('\n'), 'utf8')
  fs.chmodSync(fakeMcp, 0o755)
  const mcpProbe = await probeHermesMcp({ command: fakeMcp, hermesHome, timeoutMs: 5000 })
  assert(mcpProbe.ok === true, 'Hermes MCP probe should accept the public Hermes MCP tool surface')
  const route = await resolveHermesOwnerTargetViaMcp({ command: fakeMcp, hermesHome, timeoutMs: 5000 })
  assert(route.target === 'telegram:-1001', 'Hermes owner target should resolve through public MCP conversation details')
  assert(route.source === 'hermes-mcp-conversation', 'Hermes owner target should record public MCP source')
  const delivery = await sendHermesOwnerMessageViaMcp({ command: fakeMcp, hermesHome, target: route.target, message: 'Owner report', timeoutMs: 5000 })
  assert(delivery.delivered === true, 'Hermes owner report should send through public MCP messages_send')
} finally {
  fs.rmSync(hermesHome, { recursive: true, force: true })
}

const hermesInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-hermes-install-'))
try {
  const projectRoot = path.join(hermesInstall, 'custom-hermes-agent')
  const binDir = path.join(projectRoot, 'venv', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'hermes_state.py'), '', 'utf8')
  const hermesBin = path.join(binDir, 'hermes')
  fs.writeFileSync(hermesBin, '#!/bin/sh\nexit 0\n', 'utf8')
  fs.chmodSync(hermesBin, 0o755)
  assert(hermesProjectRoot(path.join(hermesInstall, 'home-without-source'), hermesBin) === fs.realpathSync(projectRoot), 'Hermes project root should be discoverable from a custom hermes command path')
} finally {
  fs.rmSync(hermesInstall, { recursive: true, force: true })
}

const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-skills-root-'))
const previousSkillsDir = process.env.A2_SKILLS_DIR
try {
  const friendSkillDir = path.join(skillsRoot, 'friends', 'friend-im')
  fs.mkdirSync(friendSkillDir, { recursive: true })
  fs.writeFileSync(path.join(friendSkillDir, 'SKILL.md'), [
    '---',
    'name: friend-im',
    'maxTurns: 1',
    '---',
    '# Friend IM'
  ].join('\n'), 'utf8')
  process.env.A2_SKILLS_DIR = skillsRoot
  const localSkill = findLocalOfficialSkill('friend-im')
  assert(localSkill.available === true, 'local official skill registry should find installed skill by skillHint')
  assert(localSkill.maxTurns === 1, 'local official skill registry should read maxTurns from local frontmatter')
  assert(findLocalOfficialSkill('missing-skill').available === false, 'missing local official skill should be unavailable')
} finally {
  if (previousSkillsDir == null) {
    delete process.env.A2_SKILLS_DIR
  } else {
    process.env.A2_SKILLS_DIR = previousSkillsDir
  }
  fs.rmSync(skillsRoot, { recursive: true, force: true })
}

const marketplaceWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-lobehub-layout-'))
const previousCwd = process.cwd()
try {
  const marketSkillRoot = path.join(marketplaceWorkspace, '.agents', 'skills', 'github.AgentSquaredNet.Skills')
  const marketFriendDir = path.join(marketSkillRoot, 'friends', 'friend-im')
  fs.mkdirSync(marketFriendDir, { recursive: true })
  fs.writeFileSync(path.join(marketSkillRoot, 'SKILL.md'), [
    '---',
    'name: agentsquared-official-skills',
    'version: 1.5.0',
    '---',
    '# AgentSquared'
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(marketFriendDir, 'SKILL.md'), [
    '---',
    'name: friend-im',
    'maxTurns: 1',
    '---',
    '# Friend IM'
  ].join('\n'), 'utf8')
  process.chdir(marketplaceWorkspace)
  assert(fs.realpathSync(findOfficialSkillsRoot()) === fs.realpathSync(marketSkillRoot), 'official skill registry should discover LobeHub-style .agents/skills install roots by frontmatter name')
  const marketLocalSkill = findLocalOfficialSkill('friend-im')
  assert(marketLocalSkill.available === true, 'local official skill registry should find workflow skills under a marketplace-named checkout')
  assert(fs.realpathSync(marketLocalSkill.root) === fs.realpathSync(marketSkillRoot), 'marketplace skill lookup should report the marketplace checkout root')
} finally {
  process.chdir(previousCwd)
  fs.rmSync(marketplaceWorkspace, { recursive: true, force: true })
}

let unavailableResponded = null
let unavailableNotified = null
let unavailableExecuted = false
const unavailableRouter = createAgentRouter({
  localAgentId: 'helper@ExampleOwner',
  executeInbound: async () => {
    unavailableExecuted = true
    throw new Error('missing skill should not call host runtime')
  },
  resolveLocalSkill: () => ({ available: false, name: 'missing-skill', reason: 'local-official-skill-not-found' }),
  onRespond: async (_item, response) => {
    unavailableResponded = response
  },
  onReject: async () => {
    throw new Error('skill-unavailable should return a final peer response, not reject transport')
  },
  notifyOwner: async (payload) => {
    unavailableNotified = payload
  }
})
await unavailableRouter.enqueue({
  inboundId: 'missing_skill_smoke',
  remoteAgentId: 'guide@ExampleUser',
  suggestedSkill: 'missing-skill',
  request: {
    params: {
      metadata: {
        conversationKey: 'conversation_missing_skill',
        sentAt: '2026-04-20T01:00:00.000Z',
        turnIndex: 1
      },
      message: {
        parts: [{ kind: 'text', text: 'Please use the missing skill.' }]
      }
    }
  }
})
assert(unavailableExecuted === false, 'missing local official skill should not invoke the host runtime')
assert(unavailableResponded?.metadata?.stopReason === 'skill-unavailable', 'missing local official skill should send a final skill-unavailable peer response')
assert(unavailableResponded?.metadata?.final === true, 'skill-unavailable peer response should be final so the sender can notify its owner')
assert(unavailableNotified?.conversation?.stopReason === 'skill-unavailable', 'receiver owner notification should preserve skill-unavailable status')

console.log('AgentSquared CLI self-test ok')
