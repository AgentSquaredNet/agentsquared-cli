import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { findOfficialSkillsRoot } from '../conversation/local_skills.mjs'
import { currentRuntimeMetadata } from '../runtime/report.mjs'
import { resolveUserPath } from '../shared/paths.mjs'

const execFileAsync = promisify(execFile)

function clean(value) {
  return `${value ?? ''}`.trim()
}

function redactCommand(command = {}) {
  return [command.bin, ...(command.args ?? [])].map(clean).filter(Boolean).join(' ')
}

async function runCommand(id, label, bin, args = [], {
  cwd = undefined,
  timeoutMs = 120000
} = {}) {
  const startedAt = Date.now()
  try {
    const result = await execFileAsync(bin, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 4
    })
    return {
      id,
      label,
      ok: true,
      status: 'ok',
      command: redactCommand({ bin, args }),
      cwd: clean(cwd),
      durationMs: Date.now() - startedAt,
      stdout: clean(result.stdout),
      stderr: clean(result.stderr)
    }
  } catch (error) {
    return {
      id,
      label,
      ok: false,
      status: 'fail',
      command: redactCommand({ bin, args }),
      cwd: clean(cwd),
      durationMs: Date.now() - startedAt,
      stdout: clean(error?.stdout),
      stderr: clean(error?.stderr),
      error: clean(error?.message) || `${label} failed`
    }
  }
}

function buildOwnerFacingLines(report = {}) {
  const lines = [
    'AgentSquared Update',
    `Overall: ${report.ok ? 'completed' : 'needs-attention'}`
  ]
  for (const step of report.steps ?? []) {
    lines.push(`${step.ok ? '✓' : '×'} ${step.label}: ${step.ok ? 'done' : 'failed'}`)
  }
  if (report.restart?.ok != null) {
    lines.push(`${report.restart.ok ? '✓' : '×'} Gateway restart: ${report.restart.ok ? 'done' : 'failed'}`)
  }
  if (!report.ok) {
    lines.push('', 'Next step: fix the failed step above, then run `a2-cli update` again.')
  }
  return lines
}

export async function runAgentSquaredUpdate({
  args = {},
  npmBin = 'npm',
  gitBin = 'git'
} = {}) {
  const skillsDir = clean(args['skills-dir'])
    ? resolveUserPath(args['skills-dir'])
    : findOfficialSkillsRoot()
  const skipSkills = clean(args['skip-skills']).toLowerCase() === 'true'
  const skipCli = clean(args['skip-cli']).toLowerCase() === 'true'
  const steps = []
  const beforeRuntime = currentRuntimeMetadata()

  if (skipSkills) {
    steps.push({
      id: 'skills.update',
      label: 'Official Skills update',
      ok: true,
      status: 'skipped',
      skipped: true,
      detail: '--skip-skills true'
    })
  } else if (!skillsDir) {
    steps.push({
      id: 'skills.update',
      label: 'Official Skills update',
      ok: false,
      status: 'fail',
      error: 'Official AgentSquared Skills checkout was not found. Pass --skills-dir <path> or install the official Skills checkout first.'
    })
  } else {
    steps.push(await runCommand('skills.update', 'Official Skills update', gitBin, ['pull', '--ff-only'], {
      cwd: skillsDir,
      timeoutMs: Number.parseInt(`${args['git-timeout-ms'] ?? 120000}`, 10) || 120000
    }))
  }

  if (skipCli) {
    steps.push({
      id: 'cli.update',
      label: 'CLI update',
      ok: true,
      status: 'skipped',
      skipped: true,
      detail: '--skip-cli true'
    })
  } else {
    steps.push(await runCommand('cli.update', 'CLI update', npmBin, ['install', '-g', '@agentsquared/cli@latest'], {
      timeoutMs: Number.parseInt(`${args['npm-timeout-ms'] ?? 180000}`, 10) || 180000
    }))
  }

  steps.push(await runCommand('cli.version', 'CLI version check', npmBin, ['list', '-g', '@agentsquared/cli', '--depth=0'], {
    timeoutMs: Number.parseInt(`${args['npm-timeout-ms'] ?? 180000}`, 10) || 180000
  }))

  const afterRuntime = currentRuntimeMetadata()
  const ok = steps.every((step) => step.ok)
  const report = {
    ok,
    status: ok ? 'completed' : 'needs-attention',
    skillsDir,
    beforeRuntime,
    afterRuntime,
    steps
  }
  report.ownerFacingLines = buildOwnerFacingLines(report)
  report.ownerFacingText = report.ownerFacingLines.join('\n')
  return report
}
