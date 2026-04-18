import { spawn } from 'node:child_process'
import fs from 'node:fs'

import { buildHermesApiBase } from './common.mjs'
import { buildHermesProcessEnv, hermesProjectRoot, hermesPythonPath } from './common.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function randomHermesSessionId() {
  return `agentsquared_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function runHermesNoToolsPython({
  hermesHome = '',
  input = '',
  instructions = '',
  timeoutMs = 180000
} = {}) {
  const projectRoot = hermesProjectRoot(hermesHome)
  const python = hermesPythonPath(hermesHome)
  const script = String.raw`
import contextlib
import io
import json
import os
import sys
import traceback

request = json.loads(sys.stdin.read() or "{}")
project_root = request.get("projectRoot") or os.getcwd()
hermes_home = request.get("hermesHome") or ""
if project_root not in sys.path:
    sys.path.insert(0, project_root)

try:
    try:
        from dotenv import load_dotenv
        env_path = os.path.join(hermes_home, ".env") if hermes_home else ""
        if env_path:
            try:
                load_dotenv(env_path, override=True, encoding="utf-8")
            except TypeError:
                load_dotenv(env_path, override=True)
    except Exception:
        pass

    from gateway.run import _resolve_runtime_agent_kwargs, _resolve_gateway_model, GatewayRunner
    from run_agent import AIAgent

    runtime_kwargs = _resolve_runtime_agent_kwargs()
    model = _resolve_gateway_model()
    try:
        fallback_model = GatewayRunner._load_fallback_model()
    except Exception:
        fallback_model = None

    agent = AIAgent(
        model=model,
        **runtime_kwargs,
        max_iterations=2,
        quiet_mode=True,
        verbose_logging=False,
        ephemeral_system_prompt=request.get("instructions") or None,
        enabled_toolsets=[],
        disabled_toolsets=[],
        session_id=request.get("sessionId") or "agentsquared_no_tools",
        platform="api_server",
        skip_context_files=True,
        skip_memory=True,
        fallback_model=fallback_model,
        persist_session=False,
    )
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = agent.run_conversation(
            request.get("input") or "",
            conversation_history=[],
            task_id=request.get("taskId") or "agentsquared-no-tools",
        )
    final_response = (result or {}).get("final_response") or (result or {}).get("error") or ""
    print(json.dumps({
        "id": request.get("sessionId") or "agentsquared_no_tools",
        "object": "response",
        "status": "completed",
        "model": model,
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": final_response
                    }
                ]
            }
        ],
        "usage": {
            "input_tokens": getattr(agent, "session_prompt_tokens", 0) or 0,
            "output_tokens": getattr(agent, "session_completion_tokens", 0) or 0,
            "total_tokens": getattr(agent, "session_total_tokens", 0) or 0,
        }
    }, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({
        "error": {
            "message": str(exc),
            "traceback": traceback.format_exc()
        }
    }, ensure_ascii=False))
    sys.exit(1)
`
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script], {
      cwd: projectRoot,
      env: {
        ...buildHermesProcessEnv({ hermesHome }),
        PYTHONPATH: [
          projectRoot,
          clean(process.env.PYTHONPATH)
        ].filter(Boolean).join(':')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Hermes no-tools runner timed out after ${timeoutMs}ms`))
    }, Math.max(250, timeoutMs))
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = clean(stdout)
      let payload = null
      try {
        payload = text ? JSON.parse(text.split(/\n/).filter(Boolean).at(-1)) : null
      } catch (error) {
        reject(new Error(`Hermes no-tools runner returned invalid JSON: ${error.message}; stderr: ${clean(stderr)}`))
        return
      }
      if (code !== 0 || payload?.error) {
        reject(new Error(clean(payload?.error?.message) || clean(stderr) || `Hermes no-tools runner exited with code ${code}`))
        return
      }
      resolve(payload)
    })
    child.stdin.end(JSON.stringify({
      hermesHome,
      projectRoot,
      input,
      instructions,
      sessionId: randomHermesSessionId(),
      taskId: randomHermesSessionId()
    }))
  })
}

async function fetchHermesJson(apiBase, pathname, {
  method = 'GET',
  apiKey = '',
  body = null,
  timeoutMs = 10000
} = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs))
  try {
    const headers = {}
    if (clean(apiKey)) {
      headers.Authorization = `Bearer ${clean(apiKey)}`
    }
    if (body != null) {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`${apiBase.replace(/\/$/, '')}${pathname}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
    return {
      ok: response.ok,
      status: response.status,
      payload
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function extractHermesResponseText(payload = null) {
  const output = Array.isArray(payload?.output) ? payload.output : []
  const message = output.findLast?.((item) => item?.type === 'message')
    ?? [...output].reverse().find((item) => item?.type === 'message')
  const content = Array.isArray(message?.content) ? message.content : []
  const textBlock = content.find((item) => item?.type === 'output_text' && clean(item?.text))
  return clean(textBlock?.text)
}

export function hermesResponseToolCalls(payload = null) {
  const output = Array.isArray(payload?.output) ? payload.output : []
  return output
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({
      name: clean(item?.name),
      arguments: item?.arguments ?? null,
      callId: clean(item?.call_id)
    }))
}

export async function checkHermesApiServerHealth({
  apiBase = '',
  envVars = {},
  timeoutMs = 5000
} = {}) {
  const resolvedBase = buildHermesApiBase({ apiBase, envVars })
  try {
    const health = await fetchHermesJson(resolvedBase, '/health', { timeoutMs })
    if (!health.ok || clean(health?.payload?.status).toLowerCase() !== 'ok') {
      return {
        ok: false,
        apiBase: resolvedBase,
        reason: health.ok ? 'health-not-ok' : `health-http-${health.status}`,
        health
      }
    }
    const models = await fetchHermesJson(resolvedBase, '/v1/models', {
      timeoutMs,
      apiKey: clean(envVars.API_SERVER_KEY)
    })
    if (!models.ok) {
      return {
        ok: false,
        apiBase: resolvedBase,
        reason: `models-http-${models.status}`,
        health,
        models
      }
    }
    return {
      ok: true,
      apiBase: resolvedBase,
      health,
      models
    }
  } catch (error) {
    return {
      ok: false,
      apiBase: resolvedBase,
      reason: clean(error?.name) === 'AbortError' ? 'timeout' : (clean(error?.message) || 'api-server-unreachable'),
      error: clean(error?.message) || 'api-server-unreachable'
    }
  }
}

export async function postHermesResponse({
  apiBase = '',
  envVars = {},
  hermesHome = '',
  input = '',
  instructions = '',
  conversation = '',
  timeoutMs = 180000,
  store = false,
  noTools = false
} = {}) {
  if (noTools && fs.existsSync(hermesProjectRoot(hermesHome))) {
    return runHermesNoToolsPython({
      hermesHome,
      input,
      instructions,
      timeoutMs
    })
  }
  const resolvedBase = buildHermesApiBase({ apiBase, envVars })
  const response = await fetchHermesJson(resolvedBase, '/v1/responses', {
    method: 'POST',
    apiKey: clean(envVars.API_SERVER_KEY),
    timeoutMs,
    body: {
      input,
      instructions,
      conversation: clean(conversation) || undefined,
      // AgentSquared supplies explicit conversation context itself. Avoid
      // chaining Hermes API responses, because tool traces from a previous
      // local turn can otherwise bleed into the next structured turn.
      store: Boolean(store),
      tools: []
    }
  })
  if (!response.ok) {
    const detail = clean(response?.payload?.error?.message || response?.payload?.message || response?.payload)
    throw new Error(detail || `Hermes API server request failed with status ${response.status}`)
  }
  return response.payload
}
