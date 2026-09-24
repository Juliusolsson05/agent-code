import { homedir } from 'node:os'
import { join } from 'node:path'

import { readBoundedTextFile } from '@main/editorFileIO.js'

/**
 * Read-only view of `~/.agents/.skill-lock.json`, the lock file vercel-labs
 * `npx skills` (v3 format) keeps for global installs (#1161).
 *
 * WHY read-only, never written: an entry here makes `npx skills update`
 * rewrite that folder. Agent Code's ownership journal would then see its own
 * files changed by someone else and report a conflict on every such skill.
 * Reading it is still valuable — it is the only record of WHERE an external
 * skill came from, which lets Settings offer "manage with Agent Code" with
 * the right source prefilled.
 */
export type SkillLockEntry = { source: string; sourceUrl?: string }

/** A lock file is a few KB per hundred skills; this bounds a hostile one. */
const SKILL_LOCK_MAX_BYTES = 1024 * 1024

export function skillLockPath(homeDirectory = homedir()): string {
  return join(homeDirectory, '.agents', '.skill-lock.json')
}

export async function readSkillLock(path = skillLockPath()): Promise<Map<string, SkillLockEntry>> {
  const entries = new Map<string, SkillLockEntry>()
  let text: string
  try {
    text = (await readBoundedTextFile(path, SKILL_LOCK_MAX_BYTES)).text
  } catch {
    // Missing (most users), unreadable or oversized: provenance is optional.
    return entries
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return entries
  }
  const skills = isRecord(parsed) && isRecord(parsed.skills) ? parsed.skills : null
  if (!skills) return entries
  for (const [name, value] of Object.entries(skills)) {
    if (!isRecord(value) || typeof value.source !== 'string' || value.source.length > 2_048) continue
    entries.set(name, {
      source: value.source,
      ...(typeof value.sourceUrl === 'string' && value.sourceUrl.length <= 2_048
        ? { sourceUrl: value.sourceUrl }
        : {}),
    })
  }
  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
