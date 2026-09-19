export async function waitForOpenClawRun(client, runId, timeoutMs, sessionKey = null) {
  const deadline = Date.now() + timeoutMs
  let failure = null
  try {
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await client.request('agent.wait', { runId, timeoutMs: Math.min(remaining, 30000) }, remaining + 1000)
    if (result.status === 'ok') return result
    if (result.status === 'pending' || (result.status === 'timeout' && !result.endedAt && !result.error)) {
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
      continue
    }
    const error = new Error(`OpenClaw run ${result.status || 'unknown'}: ${result.error || result.reason || runId}`)
    error.terminal = true
    throw error
  }
  } catch (error) {
    if (error.terminal) throw error
    failure = error
  }
  let cancellation = 'not requested (missing session key)'
  if (sessionKey) {
    try { await client.request('chat.abort', { sessionKey, runId }, 10000); cancellation = 'requested' }
    catch { cancellation = 'unconfirmed' }
  }
  throw new Error(`OpenClaw run ${runId} ${failure ? `wait failed: ${failure.message}` : 'did not finish before the deadline'}; cancellation ${cancellation}`, failure ? { cause: failure } : undefined)
}
