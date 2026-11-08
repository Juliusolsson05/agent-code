import { mkdir, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
      // Validate the config before any mutation (a dry run outside the lock),
      // so an unmanaged entry is reported without having installed the skill
      // first. The authoritative computation is repeated under the lock below.
      reconcileExternalClaudeConfig(await readRegular(configPath), connection)
      if (connection) await replaceObserved(skillPath, oldSkill, skill)
      await withClaudeConfigLock(configPath, async () => {
        const existing = await readRegular(configPath)
        const next = reconcileExternalClaudeConfig(existing, connection)
        if (next !== existing) await replaceObserved(configPath, existing, next)
      })
      if (!connection && oldSkill !== null) await replaceObserved(skillPath, oldSkill, null)
    },
  }
}

// WHY we take Claude's own lock instead of relying only on replaceObserved:
// unlike ~/.codex/config.toml, ~/.claude.json is rewritten by every running
// Claude process all the time (startup counters, tips, per-project state).
// Claude saves through saveConfigWithLock (vendor utils/config.ts), which
// holds a proper-lockfile lock — a DIRECTORY at `<file>.lock` — then re-reads
// the file and applies its change on top of the fresh copy. If we hold the same
// lock while we read-modify-rename, any Claude save that follows re-reads and
// keeps our entry; without it, a Claude process could write back its stale
// copy over ours a millisecond later.
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
        await mkdir(join(file, '..'), { recursive: true, mode: 0o700 }); continue
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const held = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0)
      if (held > LOCK_STALE_MS) { await rmdir(lock).catch(() => {}); continue }
      if (Date.now() > deadline) throw new Error(`Claude is busy writing its config; retry: ${file}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  try { return await run() } finally { await rmdir(lock).catch(() => {}) }
}
