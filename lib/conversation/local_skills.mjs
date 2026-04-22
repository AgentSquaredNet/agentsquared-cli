import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isValidConversationMaxTurns, normalizeSharedSkillName, parseSkillDocumentPolicy } from './policy.mjs'

function clean(value) {
  return `${value ?? ''}`.trim()
}

function unique(values = []) {
  const seen = new Set()
  const out = []
  for (const value of values.map(clean).filter(Boolean)) {
    const resolved = path.resolve(value.replace(/^~(?=$|\/|\\)/, os.homedir()))
    if (seen.has(resolved)) {
      continue
    }
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function skillRootCandidates() {
  const home = os.homedir()
  return unique([
    process.env.A2_SKILLS_DIR,
    process.env.A2_OFFICIAL_SKILLS_DIR,
    process.env.AGENTSQUARED_SKILLS_DIR,
    process.env.AGENTSQUARED_SKILL_DIR,
    path.join(home, '.hermes', 'skills', 'AgentSquared'),
    path.join(home, '.hermes', 'skills', 'agentsquared-official-skills'),
    path.join(home, '.openclaw', 'workspace', 'agentsquared-official-skills'),
    path.join(home, '.openclaw', 'workspace', 'AgentSquared'),
    path.resolve(process.cwd(), 'AgentSquared'),
    path.resolve(process.cwd(), 'agentsquared-official-skills'),
    path.resolve(packageRoot(), '..', 'Skills')
  ])
}

function walkSkillFiles(root, {
  maxDepth = 5,
  depth = 0,
  out = []
} = {}) {
  if (depth > maxDepth) {
    return out
  }
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue
    }
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      walkSkillFiles(entryPath, { maxDepth, depth: depth + 1, out })
      continue
    }
    if (entry.isFile() && entry.name === 'SKILL.md') {
      out.push(entryPath)
    }
  }
  return out
}

export function findLocalOfficialSkill(skillName = '') {
  const normalizedName = normalizeSharedSkillName(skillName)
  if (!normalizedName) {
    return {
      available: false,
      reason: 'missing-skill-hint'
    }
  }

  const roots = skillRootCandidates()
  for (const root of roots) {
    for (const skillFile of walkSkillFiles(root)) {
      let text = ''
      try {
        text = fs.readFileSync(skillFile, 'utf8')
      } catch {
        continue
      }
      const fallbackName = path.basename(path.dirname(skillFile))
      const policy = parseSkillDocumentPolicy(text, { fallbackName })
      if (normalizeSharedSkillName(policy.name) !== normalizedName) {
        continue
      }
      return {
        available: true,
        name: normalizeSharedSkillName(policy.name),
        displayName: clean(policy.name),
        maxTurns: isValidConversationMaxTurns(policy.maxTurns) ? policy.maxTurns : 1,
        path: skillFile,
        root
      }
    }
  }

  return {
    available: false,
    name: normalizedName,
    reason: 'local-official-skill-not-found',
    searchedRoots: roots
  }
}

