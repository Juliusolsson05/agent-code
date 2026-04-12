import { realpath } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

// Mirrors claude-code-src/utils/sessionStoragePortable.ts
//   - sanitizePath (line 311)
//   - canonicalizePath (line 339)
//   - getProjectsDir (line 325)
//   - getProjectDir (line 329)
// And claude-code-src/utils/envUtils.ts:7 — getClaudeConfigHomeDir
//
// Lives under src/core/runtime/ — Node-only (uses fs + os). NOT importable
// from the renderer; only main and the testbench should reach for this.

const MAX_SANITIZED_LENGTH = 200

/**
 * Replace every non-alphanumeric character with a hyphen — matches CC's
 * sessionStoragePortable.ts:311 sanitizePath. We don't implement the long-path
 * hash branch (>200 chars) because no realistic project cwd hits it; if we
 * ever do we'll get a directory miss and can revisit.
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  // Long path: CC appends a hash. Truncate so we still match its prefix.
  return sanitized.slice(0, MAX_SANITIZED_LENGTH)
}

/**
 * realpath + NFC normalize. Matches CC's canonicalizePath (line 339).
 * Returns the unmodified path if realpath fails (e.g., dir doesn't exist).
 */
export async function canonicalizePath(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}

/**
 * `~/.claude` (or `$CLAUDE_CONFIG_DIR` if set). Matches envUtils.ts:7.
 */
export function getClaudeConfigHomeDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC')
}

/**
 * `~/.claude/projects`
 */
export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

/**
 * Resolve a working directory to the on-disk directory CC uses to store
 * its session JSONL files for that cwd:
 *   ~/.claude/projects/<sanitized-cwd>/
 */
export async function getProjectDirForCwd(cwd: string): Promise<string> {
  const canonical = await canonicalizePath(cwd)
  return join(getProjectsDir(), sanitizePath(canonical))
}
