import type { SessionMeta } from '@renderer/workspace/types'

// The one rule for naming a session that has no explicit title (#865).
//
// WHY it lives in workspace/ and not features/: pane labels, Dispatch, the
// close confirmation and control observation are all workspace-layer readers,
// and they must agree. Copies disagreed before this module: folder name in
// most lists, the raw session UUID in the close dialog, `kind · folder` in the
// buried picker. Dispatch layers its latest-prompt fallback for agents on top
// of this; it does not replace it.

export function cwdBasename(cwd: string): string {
  if (!cwd) return ''
  // Trim trailing slashes so `/foo/bar/` doesn't yield an empty basename.
  const trimmed = cwd.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? trimmed
}

/**
 * Explicit title → live folder (terminals, from tmux; follows `cd`) → spawn
 * folder → raw cwd. Never returns the session id: an id is not a name a user
 * can recognize, and the close dialog showing one was the bug this replaced.
 */
export function sessionDisplayTitle(
  meta: Pick<SessionMeta, 'title' | 'cwd'>,
  liveCwd?: string | null,
): string {
  return meta.title?.trim()
    || (liveCwd ? cwdBasename(liveCwd) : '')
    || cwdBasename(meta.cwd)
    || meta.cwd
}
