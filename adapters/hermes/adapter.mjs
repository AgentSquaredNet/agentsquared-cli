import { spawnSync } from 'node:child_process'

import { buildConversationSummaryPrompt, buildReceiverBaseReport, inferOwnerFacingLanguage } from '../../lib/conversation/templates.mjs'
import { normalizeConversationControl, resolveConversationMaxTurns, resolveInboundConversationIdentity } from '../../lib/conversation/policy.mjs'
import { scrubOutboundText } from '../../lib/runtime/safety.mjs'
import { checkHermesApiServerHealth, extractHermesResponseText, postHermesResponse } from './api_client.mjs'
import { buildHermesProcessEnv } from './common.mjs'
import { hermesProjectRoot, hermesPythonPath } from './common.mjs'
import { detectHermesHostEnvironment } from './detect.mjs'
import { readHermesEnv } from './env.mjs'
import { ensureHermesApiServerEnv } from './env.mjs'
import {
  buildHermesCombinedPrompt,
  buildHermesSafetyPrompt,
  buildHermesTaskPrompt,
  hermesConversationName,
  HERMES_STRUCTURED_NO_TOOLS_INSTRUCTIONS,
  ownerReportText,
  parseHermesCombinedResult,
  parseHermesSafetyResult,
  parseHermesTaskResult
} from './helpers.mjs'
import {
  excerpt,
  localOwnerTimeZone,
  buildReceiverTurnOutline,
  maxTurnIndexFromOutline,
  createPeerBudget
} from '../../lib/runtime/adapters.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function nowMs() {
  return Date.now()
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function describeHermesRuntimeError(error = null, seen = new Set()) {
  if (error == null) {
    return ''
  }
  if (typeof error !== 'object') {
    return clean(error)
  }
  if (seen.has(error)) {
    return ''
  }
  seen.add(error)
  const parts = []
  const message = clean(error?.message)
  if (message) {
    parts.push(message)
  }
  const code = clean(error?.code)
  if (code && !parts.some((part) => part.includes(code))) {
    parts.push(code)
  }
  const cause = describeHermesRuntimeError(error?.cause, seen)
  if (cause) {
    parts.push(`cause: ${cause}`)
  }
  return [...new Set(parts)].join('; ')
}

function hermesRuntimeUnavailable(error = null) {
  const lower = describeHermesRuntimeError(error).toLowerCase()
  return Boolean(
    lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('fetch failed')
    || lower.includes('api-server-unreachable')
    || lower.includes('socket hang up')
    || lower.includes('timeout')
    || lower.includes('aborterror')
    || lower.includes('network')
  )
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

const HERMES_OWNER_TARGET_ENV = [
  ['feishu', 'FEISHU_HOME_CHANNEL'],
  ['wecom', 'WECOM_HOME_CHANNEL'],
  ['weixin', 'WEIXIN_HOME_CHANNEL'],
  ['telegram', 'TELEGRAM_HOME_CHANNEL'],
  ['discord', 'DISCORD_HOME_CHANNEL'],
  ['slack', 'SLACK_HOME_CHANNEL'],
  ['signal', 'SIGNAL_HOME_CHANNEL'],
  ['whatsapp', 'WHATSAPP_HOME_CHANNEL'],
  ['email', 'EMAIL_HOME_ADDRESS'],
  ['sms', 'SMS_HOME_CHANNEL'],
  ['matrix', 'MATRIX_HOME_CHANNEL'],
  ['mattermost', 'MATTERMOST_HOME_CHANNEL'],
  ['dingtalk', 'DINGTALK_HOME_CHANNEL'],
  ['qqbot', 'QQBOT_HOME_CHANNEL'],
  ['bluebubbles', 'BLUEBUBBLES_HOME_CHANNEL']
]

const HERMES_INTERNAL_SESSION_SOURCES = new Set(['cli', 'tool', 'local', 'api', 'api_server', 'webhook'])

function parseLastJsonLine(stdout = '') {
  const lines = `${stdout ?? ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const line = [...lines].reverse().find((item) => item.startsWith('{') || item.startsWith('['))
  if (!line) {
    return null
  }
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function runHermesPythonJson(hermesHome = '', script = '', {
  timeoutMs = 10000
} = {}) {
  const pythonPath = hermesPythonPath(hermesHome)
  const projectRoot = hermesProjectRoot(hermesHome)
  const env = {
    ...buildHermesProcessEnv({ hermesHome }),
    ...readHermesEnv(hermesHome)
  }
  const result = spawnSync(pythonPath, ['-c', script], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: Math.max(500, timeoutMs)
  })
  if (result.status !== 0 || result.error) {
    return null
  }
  return parseLastJsonLine(result.stdout)
}

function listRecentHermesExportedSessions(hermesHome = '', {
  limit = 12
} = {}) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(`${limit}`, 10) || 12))
  const script = [
    'import json',
    'from hermes_state import SessionDB',
    'db = SessionDB()',
    'sessions = db.list_sessions_rich(exclude_sources=["tool"], limit=' + safeLimit + ')',
    'out = []',
    'for session in sessions:',
    '    raw_id = str(session.get("id", "")).strip()',
    '    if not raw_id:',
    '        continue',
    '    resolved_id = db.resolve_session_id(raw_id) or raw_id',
    '    exported = db.export_session(resolved_id)',
    '    if exported:',
    '        out.append(exported)',
    'print(json.dumps(out, ensure_ascii=False))'
  ].join('\n')
  const payload = runHermesPythonJson(hermesHome, script, { timeoutMs: 10000 })
  return Array.isArray(payload) ? payload : []
}

function loadHermesChannelDirectory(hermesHome = '') {
  const script = [
    'import json',
    'from gateway.channel_directory import load_directory',
    'print(json.dumps(load_directory(), ensure_ascii=False))'
  ].join('\n')
  const payload = runHermesPythonJson(hermesHome, script, { timeoutMs: 10000 })
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : { updated_at: null, platforms: {} }
}

function hermesChannelTargetName(platform = '', entry = {}) {
  const name = clean(entry?.name || entry?.id)
  if (!name) {
    return ''
  }
  if (platform === 'discord' && clean(entry?.guild)) {
    return `#${name}`
  }
  if (platform !== 'discord' && clean(entry?.type)) {
    return `${name} (${clean(entry.type)})`
  }
  return name
}

function resolveHermesSendMessageTargetForSource(hermesHome = '', source = '') {
  const normalizedSource = clean(source).toLowerCase()
  if (!normalizedSource) {
    return ''
  }
  const directory = loadHermesChannelDirectory(hermesHome)
  const entries = Array.isArray(directory?.platforms?.[normalizedSource])
    ? directory.platforms[normalizedSource]
    : []
  const first = entries.find((entry) => clean(entry?.id || entry?.name))
  const targetName = hermesChannelTargetName(normalizedSource, first)
  return targetName ? `${normalizedSource}:${targetName}` : ''
}

export function resolveHermesOwnerTarget(hermesHome = '') {
  for (const session of listRecentHermesExportedSessions(hermesHome)) {
    const source = clean(session?.source).toLowerCase()
    if (source && !HERMES_INTERNAL_SESSION_SOURCES.has(source)) {
      const exactTarget = resolveHermesSendMessageTargetForSource(hermesHome, source)
      return {
        target: exactTarget || source,
        source: 'hermes-sessiondb-export',
        sessionId: clean(session?.id),
        sessionSource: source,
        targetSource: exactTarget ? 'channel-directory' : 'platform-home'
      }
    }
  }

  const envVars = readHermesEnv(hermesHome)
  for (const [platform, envKey] of HERMES_OWNER_TARGET_ENV) {
    const configuredTarget = clean(envVars[envKey])
    if (configuredTarget) {
      return {
        target: `${platform}:${configuredTarget}`,
        source: `${platform}-home-channel`
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
  timeoutMs = Number.parseInt(process.env.A2_HERMES_OWNER_REPORT_TIMEOUT_MS ?? '30000', 10) || 30000
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
  const { consumePeerBudget } = createPeerBudget()

  async function retryTransientHermesRuntime(fn, {
    stage = 'Hermes execution',
    maxAttempts = 3,
    retryDelayMs = 1000
  } = {}) {
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn({ attempt })
      } catch (error) {
        lastError = error
        if (!hermesRuntimeUnavailable(error) || attempt >= maxAttempts) {
          throw error
        }
        console.warn(`${stage} transient runtime failure on attempt ${attempt}/${maxAttempts}: ${describeHermesRuntimeError(error) || error.message}. Retrying after ${retryDelayMs}ms.`)
        try {
          await preflight()
        } catch {
          // best effort; retry below will surface the real error if Hermes is still unavailable
        }
        await sleep(retryDelayMs)
      }
    }
    throw lastError
  }

  async function detectCurrent() {
    return detectHermesHostEnvironment({
      command,
      hermesHome,
      hermesProfile,
      apiBase
    })
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

  async function summarizeConversation(context = {}) {
    return retryTransientHermesRuntime(async () => {
      const detection = await detectCurrent()
      const envVars = readHermesEnv(detection.hermesHome || hermesHome)
      const payload = await postHermesResponse({
        apiBase: detection.apiBase,
        envVars,
        hermesHome: detection.hermesHome,
        timeoutMs: Math.min(timeoutMs, 90000),
        noTools: true,
        store: false,
        conversation: hermesConversationName('agentsquared:summary', localAgentId, context.remoteAgentId, context.conversationKey),
        instructions: [
          'You are running inside AgentSquared summary generation.',
          'Do not call tools. Return only the concise owner-facing summary text.'
        ].join('\n'),
        input: buildConversationSummaryPrompt({
          localAgentId,
          remoteAgentId: context.remoteAgentId,
          selectedSkill: context.selectedSkill,
          direction: context.direction,
          conversationKey: context.conversationKey,
          turns: context.turns,
          language: context.language
        })
      })
      return scrubOutboundText(extractHermesResponseText(payload))
    }, { stage: 'Hermes conversation summary', maxAttempts: 2 })
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
    return retryTransientHermesRuntime(async () => {
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
          conversationTurnDetails: updatedConversation?.turns ?? [],
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
        input: buildHermesCombinedPrompt({
          localAgentId,
          remoteAgentId,
          selectedSkill,
          item,
          conversationTranscript,
          senderSkillInventory: clean(metadata?.localSkillInventory)
        })
      })
      const parsed = parseHermesCombinedResult(taskPayload, {
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
      if (parsed.action !== 'allow') {
        const safetyStopReason = 'safety-block'
        const peerReplyText = scrubOutboundText(clean(parsed.peerResponse?.message?.parts?.[0]?.text || parsed.peerResponse?.message?.text))
        const conversation = normalizeConversationControl(parsed?.peerResponse?.metadata ?? {}, {
          defaultTurnIndex: conversationControl.turnIndex,
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
          ownerSummary: clean(parsed.ownerSummary || parsed.ownerReport?.summary)
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
          skillSummary: clean(parsed.ownerSummary || parsed.ownerReport?.summary),
          conversationTurns: updatedConversation?.turns?.length || conversation.turnIndex,
          stopReason: safetyStopReason,
          conversationTurnDetails: updatedConversation?.turns ?? [],
          detailsAvailableInInbox: true,
          remoteSentAt: clean(inboundMetadata.sentAt),
          language: ownerLanguage,
          timeZone: ownerTimeZone,
          localTime: true
        })
        return {
          selectedSkill,
          peerResponse: {
            ...parsed.peerResponse,
            message: {
              kind: parsed.peerResponse?.message?.kind ?? 'message',
              role: parsed.peerResponse?.message?.role ?? 'agent',
              parts: [{ kind: 'text', text: peerReplyText }]
            },
            metadata: {
              ...(parsed.peerResponse?.metadata ?? {}),
              selectedSkill,
              runtimeAdapter: 'hermes',
              conversationKey,
              safetyDecision: parsed.action,
              safetyReason: clean(parsed.reason),
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
            safetyDecision: parsed.action,
            safetyReason: clean(parsed.reason),
            turnIndex: conversation.turnIndex,
            decision: conversation.decision,
            stopReason: safetyStopReason,
            final: true,
            finalize: true
          }
        }
      }

      const conversation = normalizeConversationControl(parsed?.peerResponse?.metadata ?? item?.request?.params?.metadata ?? {}, {
        defaultTurnIndex: 1,
        defaultDecision: 'done',
        defaultStopReason: ''
      })
      const safePeerReplyText = scrubOutboundText(clean(parsed.peerResponse?.message?.parts?.[0]?.text))
      const safeOwnerSummary = scrubOutboundText(clean(parsed.ownerSummary || parsed.ownerReport?.summary))
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
      const summarizedOwnerReport = await summarizeConversation({
        localAgentId,
        remoteAgentId,
        selectedSkill: parsed.selectedSkill,
        direction: 'inbound',
        conversationKey,
        turns: updatedConversation?.turns ?? [],
        language: inferOwnerFacingLanguage(displayInboundText, safePeerReplyText, safeOwnerSummary)
      }).catch(() => safeOwnerSummary)
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
        skillSummary: summarizedOwnerReport || safeOwnerSummary,
        conversationTurns: effectiveConversationTurns,
        stopReason: conversation.stopReason,
        turnOutline,
        conversationTurnDetails: updatedConversation?.turns ?? [],
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
    }, { stage: 'Hermes inbound execution' })
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
    return retryTransientHermesRuntime(async () => {
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
        ownerRouteSource: target.source,
        ownerRouteSessionId: target.sessionId || ''
      }
    }, { stage: 'Hermes owner report' })
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
    pushOwnerReport,
    summarizeConversation
  }
}
