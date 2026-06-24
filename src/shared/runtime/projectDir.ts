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
 * Sanitize ONE path segment for provider proxy-event storage dirs
 * (`<root>/<cwdSegment>/<sessionSegment>/<ts>/proxy-events.jsonl`).
 *
 * WHY this is distinct from `sanitizePath`: `sanitizePath('/a/b/c')` yields
 * `'-a-b-c'` (every separator becomes a dash, so leading/internal runs appear).
 * Storage segments want the collapsed/trimmed form `'a-b-c'`. This helper runs
 * `sanitizePath` then collapses dash runs and trims edge dashes.
 *
 * INVARIANT — the single most important property of this function: the Codex
 * proxy WRITER (`providers/codex/runtime/codexSession.ts`), the debug-bundle
 * READER (`main/storage/proxyEventsReader.ts`), and the Claude headless package
 * writer (`packages/claude-code-headless/src/proxy/proxyServer.ts`) must all
 * produce the SAME segment for the same input, or a debug bundle silently
 * misses the proxy log it was trying to capture. Two of those three now call
 * this shared helper; the package copy stays package-local (package
 * independence — see CLAUDE.md / master roadmap package boundary rule) and is
 * an intentional mirror that must be kept in step.
 *
 * Returns '' for empty/all-separator input. Callers that need a placeholder
 * directory name apply their own fallback (e.g. `|| 'unknown'`) so this helper
 * doesn't bake a fallback the reader can't predict.
 */
export function sanitizePathSegment(value: string): string {
  return sanitizePath(value).replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Make a string filename-safe for use as a session-keyed storage path
 * component (feed-debug JSONL files, debug-bundle folder name suffix).
 *
 * WHY this is distinct from `sanitizePathSegment`: this uses UNDERSCORE
 * replacement and keeps `.` `_` `-`, matching the historical on-disk layout
 * for `<FEED_DEBUG_DIR>/<sessionId>.jsonl` and the debug-bundle folder suffix.
 * It must NOT change output, or existing logs/bundles become orphaned (a write
 * under one sanitized name and a read under another). It is deliberately a
 * different function from the dash-collapsing provider segment sanitizer above
 * — they protect different path layouts with different escape rules.
 */
export function sanitizeFilenameToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
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
