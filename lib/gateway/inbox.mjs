import fs from 'node:fs'
import path from 'node:path'

let DatabaseSync = null
let sqliteLoadError = null
try {
  const sqlite = await import('node:sqlite')
  DatabaseSync = sqlite.DatabaseSync
} catch (error) {
  DatabaseSync = null
  sqliteLoadError = error
}

function clean(value) {
  return `${value ?? ''}`.trim()
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeSegment(value, fallback = 'unknown') {
  const cleaned = clean(value).replace(/[^a-zA-Z0-9_.-]+/g, '_')
  return cleaned || fallback
}

function nowISO() {
  return new Date().toISOString()
}

function safeJson(value) {
  return JSON.stringify(value ?? null)
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function extractInboundText(item = null) {
  const parts = item?.request?.params?.message?.parts ?? []
  return parts
    .filter((part) => clean(part?.kind) === 'text')
    .map((part) => clean(part?.text))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function extractReplyText(peerResponse = null) {
  const parts = peerResponse?.message?.parts ?? []
  return parts
    .filter((part) => clean(part?.kind) === 'text')
    .map((part) => clean(part?.text))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function extractConversationKey(item = null, peerResponse = null, ownerReport = null) {
  return clean(
    peerResponse?.metadata?.conversationKey
      ?? item?.request?.params?.metadata?.conversationKey
      ?? ownerReport?.conversationKey
  )
}

function excerpt(text, maxLength = 180) {
  const compact = clean(text).replace(/\s+/g, ' ').trim()
  if (!compact) {
    return ''
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function isFinalOwnerReport(entry = null) {
  return Boolean(entry?.ownerReport?.finalize)
}

function ownerDeliveryStatus(ownerDelivery = null) {
  return clean(ownerDelivery?.status)
    || (ownerDelivery?.delivered ? 'sent' : ownerDelivery?.attempted ? 'failed' : 'pending')
}

function isFailedDeliveryStatus(status = '') {
  return ['failed', 'timeout'].includes(clean(status))
}

function needsOwnerReviewStatus(status = '') {
  return ['failed', 'timeout', 'maybe_sent', 'unknown_maybe_sent'].includes(clean(status))
}

function deliveryLabel(item) {
  const delivery = item.ownerDelivery ?? null
  const status = ownerDeliveryStatus(delivery)
  if (delivery?.delivered || status === 'sent') {
    return 'owner-delivered'
  }
  if (status === 'queued' || status === 'sending' || status === 'accepted' || status === 'pending') {
    return 'owner-notification-queued'
  }
  if (status === 'stored') {
    return 'owner-report-stored'
  }
  if (status === 'skipped_duplicate') {
    return 'owner-duplicate-skipped'
  }
  if (needsOwnerReviewStatus(status)) {
    return 'owner-push-needs-review'
  }
  return 'owner-notification-pending'
}

function summarizeEntry(entry) {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    remoteAgentId: entry.remoteAgentId,
    conversationKey: entry.conversationKey,
    peerSessionId: entry.peerSessionId,
    selectedSkill: entry.selectedSkill,
    summary: entry.summary,
    messageExcerpt: entry.messageExcerpt,
    replyExcerpt: entry.replyExcerpt,
    ownerDelivery: entry.ownerDelivery ?? null,
    file: entry.file
  }
}

function renderMarkdown(index, inboxMarkdownFile) {
  const lines = [
    '# Inbox',
    '',
    `Updated: ${clean(index.updatedAt) || 'unknown'}`,
    `Total: ${index.totalCount ?? 0}`,
    `Last Entry: ${clean(index.lastEntryAt) || 'none'}`,
    `Owner Push Attempted: ${index.ownerPushAttemptedCount ?? 0}`,
    `Owner Push Delivered: ${index.ownerPushDeliveredCount ?? 0}`,
    `Owner Push Failed: ${index.ownerPushFailedCount ?? 0}`,
    `Owner Push Needs Review: ${index.ownerPushNeedsReviewCount ?? 0}`,
    ''
  ]

  if (Array.isArray(index.recent) && index.recent.length > 0) {
    lines.push('## Recent')
    lines.push('')
    for (const item of index.recent) {
      lines.push(`- [${deliveryLabel(item)}] ${item.remoteAgentId}: ${item.summary}`)
    }
    lines.push('')
  } else {
    lines.push('## Recent')
    lines.push('')
    lines.push('- none')
    lines.push('')
  }

  fs.writeFileSync(inboxMarkdownFile, `${lines.join('\n')}\n`)
}

function buildEntry({
  resolvedInboxDir,
  existingEntry = null,
  createdAt,
  file,
  agentId,
  selectedSkill,
  mailboxKey,
  item,
  ownerReport,
  peerResponse,
  ownerDelivery
}) {
  const id = clean(item?.inboundId) || clean(ownerReport?.deliveryId) || safeSegment(createdAt)
  const remoteAgentId = clean(item?.remoteAgentId ?? ownerReport?.remoteAgentId ?? ownerReport?.targetAgentId)
  const normalizedConversationKey = extractConversationKey(item, peerResponse, ownerReport)
  const inboundText = extractInboundText(item)
  const replyText = extractReplyText(peerResponse)
  const summary = clean(ownerReport?.summary) || `${remoteAgentId || 'unknown'} opened an inbound ${selectedSkill} session.`

  return {
    ...(existingEntry ?? {}),
    id: clean(existingEntry?.id) || id,
    createdAt: clean(existingEntry?.createdAt) || createdAt,
    updatedAt: createdAt,
    agentId: clean(agentId),
    mailboxKey: clean(mailboxKey),
    remoteAgentId,
    conversationKey: normalizedConversationKey,
    peerSessionId: clean(item?.peerSessionId),
    selectedSkill: clean(selectedSkill),
    summary,
    messageExcerpt: excerpt(inboundText),
    replyExcerpt: excerpt(replyText),
    ownerReport: ownerReport ?? null,
    ownerDelivery: ownerDelivery ?? null,
    request: item?.request ?? null,
    peerResponse: peerResponse ?? null,
    file: path.relative(resolvedInboxDir, file)
  }
}

function createSqliteInboxStore({ inboxDir } = {}) {
  const resolvedInboxDir = path.resolve(clean(inboxDir) || '.')
  const inboxMarkdownFile = path.join(resolvedInboxDir, 'inbox.md')
  const dbFile = path.join(resolvedInboxDir, 'inbox.sqlite')
  ensureDir(resolvedInboxDir)

  const db = new DatabaseSync(dbFile)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS inbox_entries (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      agent_id TEXT,
      mailbox_key TEXT,
      remote_agent_id TEXT,
      conversation_key TEXT,
      peer_session_id TEXT,
      selected_skill TEXT,
      summary TEXT,
      message_excerpt TEXT,
      reply_excerpt TEXT,
      owner_report_json TEXT,
      owner_report_finalize INTEGER DEFAULT 0,
      owner_delivery_json TEXT,
      owner_delivery_status TEXT,
      owner_delivery_attempted INTEGER DEFAULT 0,
      owner_delivery_delivered INTEGER DEFAULT 0,
      request_id TEXT,
      request_json TEXT,
      peer_response_json TEXT,
      file TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS inbox_entries_dedupe_key_unique
      ON inbox_entries(dedupe_key)
      WHERE dedupe_key IS NOT NULL AND dedupe_key != '';
    CREATE INDEX IF NOT EXISTS inbox_entries_created_at_idx ON inbox_entries(created_at);
    CREATE INDEX IF NOT EXISTS inbox_entries_request_id_idx ON inbox_entries(request_id);
    CREATE INDEX IF NOT EXISTS inbox_entries_conversation_key_idx ON inbox_entries(conversation_key);
  `)

  function rowToEntry(row = null) {
    if (!row) {
      return null
    }
    return {
      id: clean(row.id),
      createdAt: clean(row.created_at),
      updatedAt: clean(row.updated_at),
      agentId: clean(row.agent_id),
      mailboxKey: clean(row.mailbox_key),
      remoteAgentId: clean(row.remote_agent_id),
      conversationKey: clean(row.conversation_key),
      peerSessionId: clean(row.peer_session_id),
      selectedSkill: clean(row.selected_skill),
      summary: clean(row.summary),
      messageExcerpt: clean(row.message_excerpt),
      replyExcerpt: clean(row.reply_excerpt),
      ownerReport: parseJson(row.owner_report_json),
      ownerDelivery: parseJson(row.owner_delivery_json),
      request: parseJson(row.request_json),
      peerResponse: parseJson(row.peer_response_json),
      file: clean(row.file)
    }
  }

  function selectEntryById(id = '') {
    if (!clean(id)) {
      return null
    }
    return rowToEntry(db.prepare('SELECT * FROM inbox_entries WHERE id = ?').get(clean(id)))
  }

  function findExisting({ id, dedupeKey, requestId, peerSessionId, finalReport, conversationKey }) {
    if (clean(id)) {
      const byId = selectEntryById(id)
      if (byId) {
        return byId
      }
    }
    if (clean(dedupeKey)) {
      const byDedupe = rowToEntry(db.prepare('SELECT * FROM inbox_entries WHERE dedupe_key = ?').get(clean(dedupeKey)))
      if (byDedupe) {
        return byDedupe
      }
    }
    if (clean(requestId)) {
      const requestRows = db.prepare('SELECT * FROM inbox_entries WHERE request_id = ? ORDER BY created_at DESC').all(clean(requestId))
      for (const row of requestRows) {
        const candidate = rowToEntry(row)
        if (clean(candidate.peerSessionId) && clean(peerSessionId) && clean(candidate.peerSessionId) !== clean(peerSessionId)) {
          continue
        }
        return candidate
      }
    }
    if (finalReport && clean(conversationKey)) {
      return rowToEntry(db.prepare('SELECT * FROM inbox_entries WHERE conversation_key = ? AND owner_report_finalize = 1 ORDER BY created_at DESC LIMIT 1').get(clean(conversationKey)))
    }
    return null
  }

  function readIndex() {
    const entries = db.prepare('SELECT * FROM inbox_entries ORDER BY created_at DESC').all().map(rowToEntry)
    const recent = entries.slice(0, 50).map(summarizeEntry)
    const ownerPushAttemptedCount = entries.filter((entry) => Boolean(entry?.ownerDelivery?.attempted)).length
    const ownerPushDeliveredCount = entries.filter((entry) => entry?.ownerDelivery?.attempted && entry?.ownerDelivery?.delivered).length
    const ownerPushFailedCount = entries.filter((entry) => {
      const status = ownerDeliveryStatus(entry?.ownerDelivery)
      return entry?.ownerDelivery?.attempted && !entry?.ownerDelivery?.delivered && isFailedDeliveryStatus(status)
    }).length
    const ownerPushNeedsReviewCount = entries.filter((entry) => {
      const status = ownerDeliveryStatus(entry?.ownerDelivery)
      return entry?.ownerDelivery?.attempted && !entry?.ownerDelivery?.delivered && needsOwnerReviewStatus(status)
    }).length
    return {
      updatedAt: nowISO(),
      totalCount: entries.length,
      lastEntryAt: clean(entries[0]?.createdAt),
      lastEntryId: clean(entries[0]?.id),
      ownerPushAttemptedCount,
      ownerPushDeliveredCount,
      ownerPushFailedCount,
      ownerPushNeedsReviewCount,
      recent
    }
  }

  function rebuildIndex() {
    const index = readIndex()
    renderMarkdown(index, inboxMarkdownFile)
    return index
  }

  function appendEntry({
    agentId,
    selectedSkill,
    mailboxKey,
    item,
    ownerReport,
    peerResponse,
    ownerDelivery = null
  }) {
    const createdAt = nowISO()
    const id = clean(item?.inboundId) || clean(ownerReport?.deliveryId) || safeSegment(createdAt)
    const requestId = clean(item?.request?.id)
    const conversationKey = extractConversationKey(item, peerResponse, ownerReport)
    const dedupeKey = clean(ownerReport?.dedupeKey ?? item?.dedupeKey)
    const finalReport = Boolean(ownerReport?.finalize)
    const existingEntry = findExisting({
      id,
      dedupeKey,
      requestId,
      peerSessionId: item?.peerSessionId,
      finalReport,
      conversationKey
    })
    const finalId = clean(existingEntry?.id) || id
    const file = dbFile
    const entry = buildEntry({
      resolvedInboxDir,
      existingEntry,
      createdAt,
      file,
      agentId,
      selectedSkill,
      mailboxKey,
      item: { ...item, inboundId: finalId },
      ownerReport,
      peerResponse,
      ownerDelivery
    })
    const deliveryStatus = ownerDeliveryStatus(entry.ownerDelivery)
    db.prepare(`
      INSERT INTO inbox_entries (
        id, dedupe_key, created_at, updated_at, agent_id, mailbox_key,
        remote_agent_id, conversation_key, peer_session_id, selected_skill,
        summary, message_excerpt, reply_excerpt, owner_report_json,
        owner_report_finalize, owner_delivery_json, owner_delivery_status,
        owner_delivery_attempted, owner_delivery_delivered, request_id,
        request_json, peer_response_json, file
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        updated_at = excluded.updated_at,
        agent_id = excluded.agent_id,
        mailbox_key = excluded.mailbox_key,
        remote_agent_id = excluded.remote_agent_id,
        conversation_key = excluded.conversation_key,
        peer_session_id = excluded.peer_session_id,
        selected_skill = excluded.selected_skill,
        summary = excluded.summary,
        message_excerpt = excluded.message_excerpt,
        reply_excerpt = excluded.reply_excerpt,
        owner_report_json = excluded.owner_report_json,
        owner_report_finalize = excluded.owner_report_finalize,
        owner_delivery_json = excluded.owner_delivery_json,
        owner_delivery_status = excluded.owner_delivery_status,
        owner_delivery_attempted = excluded.owner_delivery_attempted,
        owner_delivery_delivered = excluded.owner_delivery_delivered,
        request_id = excluded.request_id,
        request_json = excluded.request_json,
        peer_response_json = excluded.peer_response_json,
        file = excluded.file
    `).run(
      entry.id,
      dedupeKey,
      entry.createdAt,
      entry.updatedAt,
      entry.agentId,
      entry.mailboxKey,
      entry.remoteAgentId,
      entry.conversationKey,
      entry.peerSessionId,
      entry.selectedSkill,
      entry.summary,
      entry.messageExcerpt,
      entry.replyExcerpt,
      safeJson(entry.ownerReport),
      isFinalOwnerReport(entry) ? 1 : 0,
      safeJson(entry.ownerDelivery),
      deliveryStatus,
      entry.ownerDelivery?.attempted ? 1 : 0,
      entry.ownerDelivery?.delivered ? 1 : 0,
      requestId,
      safeJson(entry.request),
      safeJson(entry.peerResponse),
      entry.file
    )
    const index = rebuildIndex()
    return { entry, index }
  }

  function updateOwnerDelivery(entryId = '', ownerDelivery = null) {
    const existing = selectEntryById(entryId)
    if (!existing) {
      return null
    }
    const updatedAt = nowISO()
    const merged = {
      ...(existing.ownerDelivery ?? {}),
      ...(ownerDelivery ?? {})
    }
    const status = ownerDeliveryStatus(merged)
    db.prepare(`
      UPDATE inbox_entries
      SET updated_at = ?, owner_delivery_json = ?, owner_delivery_status = ?,
          owner_delivery_attempted = ?, owner_delivery_delivered = ?
      WHERE id = ?
    `).run(
      updatedAt,
      safeJson(merged),
      status,
      merged?.attempted ? 1 : 0,
      merged?.delivered ? 1 : 0,
      clean(entryId)
    )
    const entry = {
      ...existing,
      updatedAt,
      ownerDelivery: merged
    }
    const index = rebuildIndex()
    return { entry, index }
  }

  function findFinalConversationReport(conversationKey = '') {
    const targetConversationKey = clean(conversationKey)
    if (!targetConversationKey) {
      return null
    }
    return rowToEntry(db.prepare('SELECT * FROM inbox_entries WHERE conversation_key = ? AND owner_report_finalize = 1 ORDER BY created_at DESC LIMIT 1').get(targetConversationKey))
  }

  function findDeliveredFinalConversationReport(conversationKey = '') {
    const targetConversationKey = clean(conversationKey)
    if (!targetConversationKey) {
      return null
    }
    return rowToEntry(db.prepare(`
      SELECT * FROM inbox_entries
      WHERE conversation_key = ?
        AND owner_report_finalize = 1
        AND owner_delivery_delivered = 1
      ORDER BY created_at DESC
      LIMIT 1
    `).get(targetConversationKey))
  }

  function snapshot() {
    const index = readIndex()
    return {
      inboxDir: resolvedInboxDir,
      inboxMarkdownFile,
      sqliteFile: dbFile,
      backend: 'sqlite',
      totalCount: index.totalCount ?? 0,
      lastEntryAt: index.lastEntryAt ?? '',
      ownerPushAttemptedCount: index.ownerPushAttemptedCount ?? 0,
      ownerPushDeliveredCount: index.ownerPushDeliveredCount ?? 0,
      ownerPushFailedCount: index.ownerPushFailedCount ?? 0,
      ownerPushNeedsReviewCount: index.ownerPushNeedsReviewCount ?? 0
    }
  }

  rebuildIndex()
  return {
    inboxDir: resolvedInboxDir,
    inboxMarkdownFile,
    sqliteFile: dbFile,
    backend: 'sqlite',
    readIndex,
    rebuildIndex,
    appendEntry,
    updateOwnerDelivery,
    findFinalConversationReport,
    findDeliveredFinalConversationReport,
    snapshot
  }
}

export function createInboxStore(options = {}) {
  if (!DatabaseSync) {
    const reason = clean(sqliteLoadError?.message)
    throw new Error(`AgentSquared inbox requires a Node.js runtime with node:sqlite support. Upgrade Node.js and retry.${reason ? ` Cause: ${reason}` : ''}`)
  }
  return createSqliteInboxStore(options)
}
