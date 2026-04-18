import { spawnSync } from 'node:child_process'

import { buildReceiverBaseReport, inferOwnerFacingLanguage } from '../../lib/conversation/templates.mjs'
import { normalizeConversationControl, resolveConversationMaxTurns, resolveInboundConversationIdentity } from '../../lib/conversation/policy.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import { checkHermesApiServerHealth, postHermesResponse } from './api_client.mjs'
import { buildHermesProcessEnv } from './common.mjs'
import { hermesProjectRoot, hermesPythonPath, readHermesChannelDirectory } from './common.mjs'
import { detectHermesHostEnvironment } from './detect.mjs'
import { readHermesEnv } from './env.mjs'
import { ensureHermesApiServerEnv } from './env.mjs'
import {
  buildHermesSafetyPrompt,
  buildHermesTaskPrompt,
  hermesConversationName,
  HERMES_STRUCTURED_NO_TOOLS_INSTRUCTIONS,
  ownerReportText,
  parseHermesSafetyResult,
  parseHermesTaskResult
} from './helpers.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function nowMs() {
  return Date.now()
}

function localOwnerTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function excerpt(text, maxLength = 140) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function buildReceiverTurnOutline(turns = [], expectedTurnCount = 1) {
  const normalizedTurns = Array.isArray(turns) ? turns : []
  const turnMap = new Map()
  let maxSeenTurnIndex = 0
  for (const turn of normalizedTurns) {
    const turnIndex = Number.parseInt(`${turn?.turnIndex ?? 0}`, 10) || 0
    if (turnIndex > 0) {
      maxSeenTurnIndex = Math.max(maxSeenTurnIndex, turnIndex)
      turnMap.set(turnIndex, turn)
    }
  }
  const maxTurnCount = Math.max(1, Number.parseInt(`${expectedTurnCount ?? 1}`, 10) || 1, maxSeenTurnIndex)
  return Array.from({ length: maxTurnCount }, (_, index) => {
    const displayTurnIndex = index + 1
    const turn = turnMap.get(displayTurnIndex)
    if (!turn) {
      return {
        turnIndex: displayTurnIndex,
        summary: 'Earlier turn details were not preserved in the current live transcript, but this conversation continued.'
      }
    }
    const inbound = excerpt(turn.inboundText)
    const reply = excerpt(turn.replyText)
    const isFinalTurn = Boolean(turn.final) || clean(turn.decision).toLowerCase() === 'done'
    return {
      turnIndex: displayTurnIndex,
      summary: [
        inbound ? `remote said "${inbound}"` : 'remote sent a message',
        reply ? `I replied "${reply}"` : 'I replied',
        isFinalTurn && clean(turn.stopReason) ? `(final stop: ${clean(turn.stopReason)})` : ''
      ].filter(Boolean).join(' ')
    }
  })
}

function maxTurnIndexFromOutline(turnOutline = []) {
  const normalized = Array.isArray(turnOutline) ? turnOutline : []
  return normalized.reduce((maxSeen, item, index) => {
    const turnIndex = Number.parseInt(`${item?.turnIndex ?? index + 1}`, 10) || (index + 1)
    return Math.max(maxSeen, turnIndex)
  }, 0)
}

async function waitForHermesApiHealthy({
  apiBase = '',
  envVars = {},
  timeoutMs = 20000
} = {}) {
  const startedAt = nowMs()
  while (nowMs() - startedAt < timeoutMs) {
    const check = await checkHermesApiServerHealth({
      apiBase,
      envVars,
      timeoutMs: 2500
    })
    if (check.ok) {
      return check
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return {
    ok: false,
    reason: 'timeout'
  }
}

function runHermesGatewayService(command, {
  hermesHome,
  subcommand = 'restart'
} = {}) {
  const env = buildHermesProcessEnv({ hermesHome })
  return spawnSync(command, ['gateway', subcommand], {
    env,
    encoding: 'utf8'
  })
}

function resolveHermesOwnerTarget(hermesHome = '') {
  const envVars = readHermesEnv(hermesHome)
  const configuredHomeTargets = [
    ['feishu', clean(envVars.FEISHU_HOME_CHANNEL)],
    ['wecom', clean(envVars.WECOM_HOME_CHANNEL)],
    ['weixin', clean(envVars.WEIXIN_HOME_CHANNEL)],
    ['telegram', clean(envVars.TELEGRAM_HOME_CHANNEL)],
    ['discord', clean(envVars.DISCORD_HOME_CHANNEL)],
    ['slack', clean(envVars.SLACK_HOME_CHANNEL)],
    ['signal', clean(envVars.SIGNAL_HOME_CHANNEL)],
    ['whatsapp', clean(envVars.WHATSAPP_HOME_CHANNEL)],
    ['email', clean(envVars.EMAIL_HOME_ADDRESS)],
    ['sms', clean(envVars.SMS_HOME_CHANNEL)],
    ['matrix', clean(envVars.MATRIX_HOME_CHANNEL)],
    ['mattermost', clean(envVars.MATTERMOST_HOME_CHANNEL)],
    ['dingtalk', clean(envVars.DINGTALK_HOME_CHANNEL)],
    ['qqbot', clean(envVars.QQBOT_HOME_CHANNEL)],
    ['bluebubbles', clean(envVars.BLUEBUBBLES_HOME_CHANNEL)]
  ]
  for (const [platform, chatId] of configuredHomeTargets) {
    if (chatId) {
      return {
        target: `${platform}:${chatId}`,
        source: `${platform}-home-channel`
      }
    }
  }

  const directory = readHermesChannelDirectory(hermesHome)
  const platforms = directory?.platforms && typeof directory.platforms === 'object'
    ? directory.platforms
    : {}
  const preferredPlatforms = [
    'feishu',
    'wecom',
    'weixin',
    'telegram',
    'discord',
    'slack',
    'signal',
    'whatsapp',
    'email',
    'sms',
    'matrix',
    'mattermost',
    'dingtalk',
    'qqbot',
    'bluebubbles'
  ]
  for (const platform of preferredPlatforms) {
    const entries = Array.isArray(platforms?.[platform]) ? platforms[platform] : []
    const first = entries.find((entry) => clean(entry?.id))
    if (first) {
      return {
        target: `${platform}:${clean(first.id)}`,
        source: `${platform}-channel-directory`
      }
    }
  }
  return {
    target: '',
    source: 'none'
  }
}

function sendHermesOwnerMessage({
  hermesHome = '',
  target = '',
  message = '',
  timeoutMs = Number.parseInt(process.env.A2_HERMES_OWNER_REPORT_TIMEOUT_MS ?? '20000', 10) || 20000
} = {}) {
  const resolvedTarget = clean(target)
  const resolvedMessage = clean(message)
  if (!resolvedTarget || !resolvedMessage) {
    return {
      delivered: false,
      attempted: false,
      reason: !resolvedTarget ? 'owner-route-not-found' : 'empty-owner-report'
    }
  }

  const pythonPath = hermesPythonPath(hermesHome)
  const projectRoot = hermesProjectRoot(hermesHome)
  const env = {
    ...buildHermesProcessEnv({ hermesHome }),
    ...readHermesEnv(hermesHome)
  }
  const script = [
    'import json, sys',
    'from tools.send_message_tool import send_message_tool',
    'payload = json.loads(sys.stdin.read())',
    'print(send_message_tool(payload))'
  ].join('\n')
  const result = spawnSync(pythonPath, ['-c', script], {
    cwd: projectRoot,
    env,
    input: JSON.stringify({
      action: 'send',
      target: resolvedTarget,
      message: resolvedMessage
    }),
    encoding: 'utf8',
    timeout: Math.max(500, timeoutMs),
    killSignal: 'SIGTERM'
  })
  if (result.error?.code === 'ETIMEDOUT' || result.signal) {
    return {
      delivered: false,
      attempted: true,
      reason: `owner-report-timeout-after-${Math.max(500, timeoutMs)}ms`,
      stdout: clean(result.stdout),
      stderr: clean(result.stderr)
    }
  }
  if (result.status !== 0) {
    return {
      delivered: false,
      attempted: true,
      reason: clean(result.stderr || result.stdout) || `send-message-exit-${result.status}`
    }
  }
  try {
    const payload = JSON.parse(clean(result.stdout) || '{}')
    if (payload?.success) {
      return {
        delivered: true,
        attempted: true,
        payload
      }
    }
    return {
      delivered: false,
      attempted: true,
      reason: clean(payload?.error) || 'send-message-failed',
      payload
    }
  } catch (error) {
    return {
      delivered: false,
      attempted: true,
      reason: `send-message-invalid-json:${clean(error?.message)}`,
      stdout: clean(result.stdout),
      stderr: clean(result.stderr)
    }
  }
}

export function createHermesAdapter({
  localAgentId,
  conversationStore = null,
  command = 'hermes',
  hermesHome = '',
  hermesProfile = '',
  apiBase = '',
  timeoutMs = 180000
} = {}) {
  const peerBudget = new Map()
  const budgetWindowMs = 10 * 60 * 1000
  const maxWindowTurns = 30

  async function detectCurrent() {
    return detectHermesHostEnvironment({
      command,
      hermesHome,
      hermesProfile,
      apiBase
    })
  }

  function consumePeerBudget({
    remoteAgentId = ''
  } = {}) {
    const key = clean(remoteAgentId).toLowerCase() || 'unknown'
    const currentTime = nowMs()
    const existing = peerBudget.get(key)
    const recentEvents = (existing?.events ?? []).filter((event) => currentTime - event.at <= budgetWindowMs)
    const nextCount = recentEvents.length + 1
    recentEvents.push({ at: currentTime })
    peerBudget.set(key, { events: recentEvents })
    return {
      windowTurns: nextCount,
      overBudget: nextCount > maxWindowTurns
    }
  }

  async function preflight() {
    const detection = await detectCurrent()
    if (!detection.detected) {
      return {
        ok: false,
        mode: 'hermes',
        error: 'Hermes is not installed or no Hermes home/profile could be detected.'
      }
    }
    const envResult = ensureHermesApiServerEnv(detection.hermesHome)
    let latest = await detectCurrent()
    if (latest.apiServerHealthy) {
      return {
        ok: true,
        mode: 'hermes',
        detection: latest,
        envConfigured: envResult.changed
      }
    }
    if (latest.gatewayServiceInstalled) {
      const restart = runHermesGatewayService(command, {
        hermesHome: latest.hermesHome,
        subcommand: 'restart'
      })
      latest = await detectCurrent()
      if (!latest.apiServerHealthy && restart.status !== 0) {
        const start = runHermesGatewayService(command, {
          hermesHome: latest.hermesHome,
          subcommand: 'start'
        })
        latest = await detectCurrent()
        if (!latest.apiServerHealthy && start.status !== 0) {
          return {
            ok: false,
            mode: 'hermes',
            error: clean(restart.stderr || restart.stdout || start.stderr || start.stdout)
              || 'Hermes gateway service exists, but restart/start did not make the API server healthy.'
          }
        }
      }
      const health = await waitForHermesApiHealthy({
        apiBase: latest.apiBase,
        envVars: latest.envVars,
        timeoutMs: 20000
      })
      if (health.ok) {
        latest = await detectCurrent()
        return {
          ok: true,
          mode: 'hermes',
          detection: latest,
          envConfigured: envResult.changed,
          serviceRestarted: true
        }
      }
      return {
        ok: false,
        mode: 'hermes',
        error: 'Hermes gateway service is installed, but the API server is still not healthy after restart.'
      }
    }
    return {
      ok: false,
      mode: 'hermes',
      error: 'Hermes API server is not healthy and no managed Hermes gateway service is installed. AgentSquared has written the required Hermes .env values. Start Hermes gateway manually, then retry.'
    }
  }

  async function executeInbound({
    item,
    selectedSkill,
    mailboxKey
  }) {
    const remoteAgentId = clean(item?.remoteAgentId)
    const incomingSkillHint = clean(item?.suggestedSkill || item?.request?.params?.metadata?.skillHint)
    const receivedAt = new Date().toISOString()
    const inboundText = clean(item?.request?.params?.message?.parts?.[0]?.text || item?.request?.params?.message?.text || '')
    const inboundMetadata = item?.request?.params?.metadata ?? {}
    const inboundConversation = normalizeConversationControl(inboundMetadata, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: ''
    })
    const displayInboundText = inboundConversation.turnIndex > 1
      ? inboundText
      : (clean(inboundMetadata.originalOwnerText) || inboundText)
    const ownerLanguage = inferOwnerFacingLanguage(displayInboundText, inboundText)
    const ownerTimeZone = localOwnerTimeZone()
    const conversationIdentity = resolveInboundConversationIdentity(item)
    const conversationKey = clean(conversationIdentity.conversationKey)
    const detection = await detectCurrent()
    const envVars = detection.envVars || ensureHermesApiServerEnv(detection.hermesHome).envVars
    const budget = consumePeerBudget({ remoteAgentId })

    if (budget.overBudget) {
      const peerReplyText = 'I am pausing this AgentSquared request because this peer has reached the recent conversation window limit. My owner can decide whether to continue later.'
      const conversation = normalizeConversationControl(item?.request?.params?.metadata ?? {}, {
        defaultTurnIndex: 1,
        defaultDecision: 'done',
        defaultStopReason: 'system-error'
      })
      const updatedConversation = conversationStore?.appendTurn?.({
        conversationKey,
        peerSessionId: item?.peerSessionId || '',
        requestId: clean(item?.request?.id),
        remoteAgentId,
        selectedSkill,
        turnIndex: conversation.turnIndex,
        inboundText: displayInboundText,
        replyText: peerReplyText,
        decision: 'done',
        stopReason: 'system-error',
        final: true,
        ownerSummary: `I paused this exchange because the recent peer conversation window was exceeded. Current 10-minute turn count: ${budget.windowTurns}.`
      }) ?? null
      const ownerReport = buildReceiverBaseReport({
        localAgentId,
        remoteAgentId,
        incomingSkillHint,
        selectedSkill,
        receivedAt,
        inboundText: displayInboundText,
        peerReplyText,
        repliedAt: new Date().toISOString(),
        skillSummary: `I paused this exchange because the recent peer conversation window was exceeded. Current 10-minute turn count: ${budget.windowTurns}.`,
        conversationTurns: updatedConversation?.turns?.length || conversation.turnIndex,
        stopReason: 'system-error',
        detailsAvailableInInbox: true,
        remoteSentAt: clean(inboundMetadata.sentAt),
        language: ownerLanguage,
        timeZone: ownerTimeZone,
        localTime: true
      })
      return {
        selectedSkill,
        peerResponse: {
          message: {
            kind: 'message',
            role: 'agent',
            parts: [{ kind: 'text', text: peerReplyText }]
          },
          metadata: {
            selectedSkill,
            runtimeAdapter: 'hermes',
            conversationKey,
            turnIndex: conversation.turnIndex,
            decision: 'done',
            stopReason: 'system-error',
            final: true,
            finalize: true
          }
        },
        ownerReport: {
          ...ownerReport,
          runtimeAdapter: 'hermes',
          conversationKey,
          turnIndex: conversation.turnIndex,
          decision: 'done',
          stopReason: 'system-error',
          final: true,
          finalize: true
        }
      }
    }

    const safetyPayload = await postHermesResponse({
      apiBase: detection.apiBase,
      envVars,
      hermesHome: detection.hermesHome,
      timeoutMs,
      instructions: HERMES_STRUCTURED_NO_TOOLS_INSTRUCTIONS,
      noTools: true,
      conversation: hermesConversationName('agentsquared:safety', localAgentId, remoteAgentId || mailboxKey || 'unknown'),
      input: buildHermesSafetyPrompt({
        localAgentId,
        remoteAgentId,
        selectedSkill,
        item
      })
    })
    const safety = parseHermesSafetyResult(safetyPayload)
    if (safety.action !== 'allow') {
      const safetyStopReason = 'safety-block'
      const peerReplyText = scrubOutboundText(clean(safety.peerResponse))
      const conversation = normalizeConversationControl(item?.request?.params?.metadata ?? {}, {
        defaultTurnIndex: 1,
        defaultDecision: 'done',
        defaultStopReason: safetyStopReason
      })
      const updatedConversation = conversationStore?.appendTurn?.({
        conversationKey,
        peerSessionId: item?.peerSessionId || '',
        requestId: clean(item?.request?.id),
        remoteAgentId,
        selectedSkill,
        turnIndex: conversation.turnIndex,
        inboundText: displayInboundText,
        replyText: peerReplyText,
        decision: conversation.decision,
        stopReason: safetyStopReason,
        final: true,
        ownerSummary: clean(safety.ownerSummary)
      }) ?? null
      const ownerReport = buildReceiverBaseReport({
        localAgentId,
        remoteAgentId,
        incomingSkillHint,
        selectedSkill,
        receivedAt,
        inboundText: displayInboundText,
        peerReplyText,
        repliedAt: new Date().toISOString(),
        skillSummary: clean(safety.ownerSummary),
        conversationTurns: updatedConversation?.turns?.length || conversation.turnIndex,
        stopReason: safetyStopReason,
        detailsAvailableInInbox: true,
        remoteSentAt: clean(inboundMetadata.sentAt),
        language: ownerLanguage,
        timeZone: ownerTimeZone,
        localTime: true
      })
      return {
        selectedSkill,
        peerResponse: {
          message: {
            kind: 'message',
            role: 'agent',
            parts: [{ kind: 'text', text: peerReplyText }]
          },
          metadata: {
            selectedSkill,
            runtimeAdapter: 'hermes',
            conversationKey,
            safetyDecision: safety.action,
            safetyReason: clean(safety.reason),
            turnIndex: conversation.turnIndex,
            decision: conversation.decision,
            stopReason: safetyStopReason,
            final: true,
            finalize: true
          }
        },
        ownerReport: {
          ...ownerReport,
          runtimeAdapter: 'hermes',
          conversationKey,
          safetyDecision: safety.action,
          safetyReason: clean(safety.reason),
          turnIndex: conversation.turnIndex,
          decision: conversation.decision,
          stopReason: safetyStopReason,
          final: true,
          finalize: true
        }
      }
    }

    const conversationControl = normalizeConversationControl(item?.request?.params?.metadata ?? {}, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: ''
    })
    if (conversationControl.turnIndex === 1) {
      conversationStore?.endConversation?.(conversationKey)
    }
    const liveConversation = conversationStore?.ensureConversation?.({
      conversationKey,
      peerSessionId: item?.peerSessionId || '',
      remoteAgentId,
      selectedSkill
    }) ?? null
    const conversationTranscript = conversationStore?.transcript?.(liveConversation?.conversationKey || conversationKey) ?? ''
    const metadata = item?.request?.params?.metadata ?? {}
    const taskPayload = await postHermesResponse({
      apiBase: detection.apiBase,
      envVars,
      hermesHome: detection.hermesHome,
      timeoutMs,
      instructions: HERMES_STRUCTURED_NO_TOOLS_INSTRUCTIONS,
      noTools: true,
      conversation: hermesConversationName('agentsquared:work', localAgentId, remoteAgentId, conversationKey, `${conversationControl.turnIndex}`),
      input: buildHermesTaskPrompt({
        localAgentId,
        remoteAgentId,
        selectedSkill,
        item,
        conversationTranscript,
        senderSkillInventory: clean(metadata?.localSkillInventory)
      })
    })
    const parsed = parseHermesTaskResult(taskPayload, {
      defaultSkill: selectedSkill,
      remoteAgentId,
      inboundId: clean(item?.inboundId),
      defaultTurnIndex: conversationControl.turnIndex,
      defaultDecision: conversationControl.final ? 'done' : (conversationControl.turnIndex < resolveConversationMaxTurns({
        conversationPolicy: metadata?.conversationPolicy ?? null,
        sharedSkill: metadata?.sharedSkill ?? null,
        fallback: 1
      }) ? 'continue' : 'done'),
      defaultStopReason: conversationControl.final ? 'completed' : ''
    })
    const conversation = normalizeConversationControl(parsed?.peerResponse?.metadata ?? item?.request?.params?.metadata ?? {}, {
      defaultTurnIndex: 1,
      defaultDecision: 'done',
      defaultStopReason: ''
    })
    const safePeerReplyText = scrubOutboundText(clean(parsed.peerResponse?.message?.parts?.[0]?.text))
    const safeOwnerSummary = scrubOutboundText(clean(parsed.ownerReport?.summary))
    const updatedConversation = conversationStore?.appendTurn?.({
      conversationKey,
      peerSessionId: item?.peerSessionId || '',
      requestId: clean(item?.request?.id),
      remoteAgentId,
      selectedSkill: parsed.selectedSkill,
      turnIndex: conversation.turnIndex,
      inboundText: displayInboundText,
      replyText: safePeerReplyText,
      decision: conversation.decision,
      stopReason: conversation.stopReason,
      final: conversation.final,
      ownerSummary: safeOwnerSummary
    }) ?? null
    const turnOutline = buildReceiverTurnOutline(updatedConversation?.turns ?? [], conversation.turnIndex)
    const effectiveConversationTurns = Math.max(
      updatedConversation?.turns?.length || 0,
      conversation.turnIndex,
      maxTurnIndexFromOutline(turnOutline)
    ) || 1
    const ownerReport = buildReceiverBaseReport({
      localAgentId,
      remoteAgentId,
      incomingSkillHint,
      selectedSkill: parsed.selectedSkill,
      conversationKey,
      receivedAt,
      inboundText: displayInboundText,
      peerReplyText: safePeerReplyText,
      repliedAt: new Date().toISOString(),
      skillSummary: safeOwnerSummary,
      conversationTurns: effectiveConversationTurns,
      stopReason: conversation.stopReason,
      turnOutline,
      detailsAvailableInInbox: true,
      remoteSentAt: clean(inboundMetadata.sentAt),
      language: inferOwnerFacingLanguage(displayInboundText, safePeerReplyText, safeOwnerSummary),
      timeZone: ownerTimeZone,
      localTime: true
    })
    if (conversation.final) {
      conversationStore?.closeConversation?.(updatedConversation?.conversationKey || liveConversation?.conversationKey || conversationKey, safeOwnerSummary)
    }
    return {
      ...parsed,
      peerResponse: {
        ...parsed.peerResponse,
        message: {
          kind: parsed.peerResponse?.message?.kind ?? 'message',
          role: parsed.peerResponse?.message?.role ?? 'agent',
          parts: [{ kind: 'text', text: safePeerReplyText }]
        },
        metadata: {
          ...(parsed.peerResponse?.metadata ?? {}),
          incomingSkillHint,
          conversationKey,
          hermesConversation: hermesConversationName('agentsquared:work', localAgentId, remoteAgentId, conversationKey, `${conversationControl.turnIndex}`),
          hermesApiBase: detection.apiBase,
          turnIndex: conversation.turnIndex,
          decision: conversation.decision,
          stopReason: conversation.stopReason,
          final: conversation.final,
          finalize: conversation.final
        }
      },
      ownerReport: {
        ...ownerReport,
        incomingSkillHint,
        selectedSkill: parsed.selectedSkill,
        conversationKey,
        runtimeAdapter: 'hermes',
        hermesConversation: hermesConversationName('agentsquared:work', localAgentId, remoteAgentId, conversationKey, `${conversationControl.turnIndex}`),
        hermesApiBase: detection.apiBase,
        turnIndex: conversation.turnIndex,
        decision: conversation.decision,
        stopReason: conversation.stopReason,
        final: conversation.final,
        finalize: conversation.final
      }
    }
  }

  async function pushOwnerReport({
    ownerReport
  } = {}) {
    const summary = scrubOutboundText(ownerReportText(ownerReport))
    if (!summary) {
      return {
        delivered: false,
        attempted: false,
        mode: 'hermes',
        reason: 'empty-owner-report'
      }
    }
    const detection = await detectCurrent()
    const target = resolveHermesOwnerTarget(detection.hermesHome)
    if (!target.target) {
      return {
        delivered: false,
        attempted: true,
        mode: 'hermes',
        reason: 'owner-route-not-found'
      }
    }
    const delivery = sendHermesOwnerMessage({
      hermesHome: detection.hermesHome,
      target: target.target,
      message: summary
    })
    return {
      ...delivery,
      mode: 'hermes',
      ownerRoute: target.target,
      ownerRouteSource: target.source
    }
  }

  return {
    id: 'hermes',
    mode: 'hermes',
    transport: 'api-server',
    command: clean(command) || 'hermes',
    hermesHome: clean(hermesHome),
    apiBase: clean(apiBase),
    preflight,
    executeInbound,
    pushOwnerReport
  }
}
