import { homedir } from 'os'
import { join } from 'path'

// Codex stores sessions under ~/.codex/sessions/YYYY/MM/DD/
//
// Unlike Claude's per-cwd sanitized directory structure
// (~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl), codex uses a
// flat date-bucketed tree for ALL sessions regardless of working
// directory. Each session file is named:
//   rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
//
// This means:
//   1. Finding sessions for a specific cwd requires reading the
//      session_meta entry inside each file (not just looking at the
//      directory name like Claude).
//   2. Listing ALL sessions is easy (recursive glob), but listing
//      sessions for a SPECIFIC cwd is more expensive (read + filter).
//   3. The date-bucketing is a natural partitioning scheme: old
//      sessions age into deeper subdirectories and we can prune
//      our scan to recent dates for performance.

/**
 * Resolve the codex configuration home directory.
 * Honors $CODEX_HOME if set; defaults to ~/.codex.
 * Matches codex-rs/utils/home-dir/src/lib.rs:find_codex_home.
 */
export function getCodexHome(): string {
  const env = process.env.CODEX_HOME
  if (env && env.length > 0) return env.normalize('NFC')
  return join(homedir(), '.codex').normalize('NFC')
}

/**
 * The root of the date-bucketed session tree.
 * ~/.codex/sessions/
 */
export function getCodexSessionsDir(): string {
  return join(getCodexHome(), 'sessions')
}
