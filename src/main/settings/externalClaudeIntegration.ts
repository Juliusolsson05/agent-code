import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { reconcileExternalClaudeConfig } from './externalClaudeConfig'
import { assertOwnedSkill, ownedSkillBytes, readRegular, replaceObserved } from './externalOperatorFiles'

export type ExternalClaudePaths = {
  /** `$CLAUDE_CONFIG_DIR` when set; Claude's global config FILE then lives inside it. */
  claudeConfigDir?: string
  home: string
}

// WHY the external Claude Code client gets the same treatment as Codex (#1539):
// the operator MCP was Codex-only, so someone driving Agent Code from their own
// terminal `claude` had to paste a config that went stale on every port change
// or key rotation, and never got the operator skill at all.
//
// Paths mirror Claude itself, not a guess:
// - the user-scope MCP file is getGlobalClaudeFile (vendor utils/env.ts):
//   `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')` — note the FILE sits
//   in the home directory, not in ~/.claude, when the env var is unset. Same
//   rule as src/main/userMcp/nativeServers.ts claudeUserConfigFile.
// - user skills come from getClaudeConfigHomeDir()/skills (vendor
//   skills/loadSkillsDir.ts), i.e. `CLAUDE_CONFIG_DIR || ~/.claude`.
//
// Like the Codex writer, this is separate from the all-provider skill manager:
// installing the operator into a shared root would advertise it to the very
// agents it operates. Internal Claude agents additionally get a launch-only
// `skillOverrides: off` for the skill (externalControlExclusion.ts), because
// they DO read ~/.claude/skills.
export function createExternalClaudeIntegration(paths: ExternalClaudePaths, skillSource: string) {
  const configPath = join(paths.claudeConfigDir || paths.home, '.claude.json')
  const skillPath = join(paths.claudeConfigDir || join(paths.home, '.claude'), 'skills', 'agent-code-computer-execution', 'SKILL.md')
  const skill = ownedSkillBytes(skillSource)
  return {
    client: 'claude' as const,
    configPath, skillPath,
    async reconcile(connection: { url: string; token: string } | null): Promise<void> {
      const oldSkill = await readRegular(skillPath)
      assertOwnedSkill(oldSkill, skillPath)
      // Dry run outside the lock: report an unmanaged entry before installing
      // the skill, and, in the common case where nothing changes (every app
      // start, a deselected or disabled client), never touch Claude's lock at
      // all. See withClaudeConfigLock for why holding that lock has a cost.
      const observed = await readRegular(configPath)
      const needsWrite = reconcileExternalClaudeConfig(observed, connection) !== observed
      if (connection) await replaceObserved(skillPath, oldSkill, skill)
      if (needsWrite) await writeConfig(connection)
      if (!connection && oldSkill !== null) await replaceObserved(skillPath, oldSkill, null)
    },
  }

  async function writeConfig(connection: { url: string; token: string } | null) {
    // A Claude process that could not get the lock falls back to an UNLOCKED
    // read-then-write of its own (see below), and that write can land just
    // after our rename and put back its copy without our entry. Re-reading
    // after the rename and retrying makes that loss visible and self-healing
    // instead of a `managed: true` that is quietly false. A loss after the
    // final check is still possible in principle; the next reconcile (every
    // app start and every Settings change) repairs it.
    for (let attempt = 0; ; attempt++) {
      await withClaudeConfigLock(configPath, async () => {
        const existing = await readRegular(configPath)
        const next = reconcileExternalClaudeConfig(existing, connection)
        if (next !== existing) await replaceObserved(configPath, existing, next)
      })
      const after = await readRegular(configPath)
      if (reconcileExternalClaudeConfig(after, connection) === after) return
      if (attempt >= 2) throw new Error(`Claude kept rewriting its config during setup; retry: ${configPath}`)
    }
  }
}

// WHY we take Claude's own lock, and why we hold it for as short a time as
// possible: every running Claude process rewrites ~/.claude.json constantly
// (startup counters, tips, per-project state) through saveConfigWithLock
// (vendor utils/config.ts). That takes a proper-lockfile lock, a DIRECTORY
// at `<file>.lock`, re-reads the file and applies its change to the fresh copy.
// Holding that lock means no LOCKED Claude save interleaves with our
// read-modify-rename.
//
// It is NOT a wait-for-us protocol: Claude calls lockSync, which does not
// retry. A Claude save that runs into our lock throws and falls back to an
// unlocked re-read + write. That fallback still starts from a fresh read, so
// it normally keeps our entry, but its write can race our rename. Hence: take
// the lock only when there is something to write, hold it across one read,
// one transform and one rename, and verify afterwards (writeConfig above).
//
// We do not depend on proper-lockfile itself (only a transitive dependency
// here); its on-disk protocol is just mkdir + mtime staleness, reproduced
// below. Its default staleness is 10s and Claude never holds the lock longer
// than one synchronous write, so a lock older than that is an abandoned one
// from a crashed process, which proper-lockfile would also remove.
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 3_000
async function withClaudeConfigLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { await mkdir(lock); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Parent directory (CLAUDE_CONFIG_DIR) does not exist yet.
        await mkdir(dirname(file), { recursive: true, mode: 0o700 }); continue
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const held = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0)
      if (held > LOCK_STALE_MS) { await rmdir(lock).catch(() => {}); continue }
      if (Date.now() > deadline) throw new Error(`Claude is busy writing its config; retry: ${file}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  // We never refresh the mtime the way proper-lockfile does. If `run` stalls
  // past the staleness window, a Claude process may legitimately treat our lock
  // as abandoned, remove it and take its own. Removing the lock blindly in
  // `finally` would then delete CLAUDE'S live lock. Only remove the directory
  // we created, recognised by its creation-time identity (inode + birthtime).
  const ours = await stat(lock, { bigint: true })
  try { return await run() } finally {
    const now = await stat(lock, { bigint: true }).catch(() => null)
    if (now && now.ino === ours.ino && now.birthtimeNs === ours.birthtimeNs) await rmdir(lock).catch(() => {})
  }
}
