import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveHermesOwnerTarget } from './adapters/hermes/adapter.mjs'
import { hermesProjectRoot } from './adapters/hermes/common.mjs'
import { buildReceiverBaseReport, buildSenderBaseReport, renderConversationDetails } from './lib/conversation/templates.mjs'
import { createInboxStore } from './lib/gateway/inbox.mjs'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
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
  localAgentId: 'hermes@Jessica',
  targetAgentId: 'claw@Skiyo',
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
  localAgentId: 'claw@Skiyo',
  remoteAgentId: 'hermes@Jessica',
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
  'Stopped' + ' with reason'
]) {
  assert(!rendered.includes(forbidden), `old report template phrase is still present: ${forbidden}`)
}
for (const required of ['Conversation result', 'Conversation ID', 'Overall summary', 'Conversation details', 'Full conversation']) {
  assert(rendered.includes(required), `new report template phrase is missing: ${required}`)
}

const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-inbox-smoke-'))
try {
const store = createInboxStore({ inboxDir })
  const { entry } = store.appendEntry({
    agentId: 'hermes@Jessica',
    selectedSkill: 'agent-mutual-learning',
    mailboxKey: 'outbound:conversation_smoke',
    item: {
      inboundId: 'entry_smoke',
      remoteAgentId: 'claw@Skiyo'
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
  assert(entry.remoteAgentId === 'claw@Skiyo', 'sender owner report did not normalize the remote agent id')
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
    agentId: 'claw@Skiyo',
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
  assert(inbound.entry.remoteAgentId === 'hermes@Jessica', 'receiver owner report did not normalize the remote agent id')
  assert(store.findConversation('conversation_inbound_smoke')?.finalEntry?.ownerReport?.conversationKey === 'conversation_inbound_smoke', 'receiver conversation lookup failed')
} finally {
  fs.rmSync(inboxDir, { recursive: true, force: true })
}

const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-hermes-session-export-'))
try {
  fs.writeFileSync(path.join(hermesHome, '.env'), 'FEISHU_HOME_CHANNEL=oc_should_not_win\nTELEGRAM_HOME_CHANNEL=-1001\n', 'utf8')
  const hermesProjectRoot = path.join(hermesHome, 'hermes-agent')
  const hermesGatewayDir = path.join(hermesProjectRoot, 'gateway')
  fs.mkdirSync(hermesGatewayDir, { recursive: true })
  fs.writeFileSync(path.join(hermesGatewayDir, '__init__.py'), '', 'utf8')
  fs.writeFileSync(path.join(hermesGatewayDir, 'channel_directory.py'), [
    'def load_directory():',
    '    return {',
    '        "platforms": {',
    '            "telegram": [{"id": "-1001", "name": "Owner Chat", "type": "dm"}]',
    '        }',
    '    }'
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(hermesProjectRoot, 'hermes_state.py'), [
    'class SessionDB:',
    '    def list_sessions_rich(self, exclude_sources=None, limit=20):',
    '        return [{"id": "20260420_owner", "source": "telegram"}]',
    '    def resolve_session_id(self, session_id):',
    '        return session_id',
    '    def export_session(self, session_id):',
    '        return {"id": session_id, "source": "telegram", "user_id": "123", "messages": []}'
  ].join('\n'), 'utf8')
  const route = resolveHermesOwnerTarget(hermesHome)
  assert(route.target === 'telegram:Owner Chat (dm)', 'Hermes owner target should use structured channel directory fields before Feishu fallback')
  assert(route.source === 'hermes-sessiondb-export', 'Hermes owner target should record SessionDB export source')
  assert(route.targetSource === 'channel-directory', 'Hermes owner target should record structured channel directory source')
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

console.log('AgentSquared CLI self-test ok')
