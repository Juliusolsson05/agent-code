import type { SessionKind } from '@renderer/workspace/types'

// Pane-header label helpers. Pure string transforms — split out so
// TileLeaf's render body doesn't carry two ad-hoc utility funcs at
// the bottom.

/** Shorten a cwd to at most its last two path segments for the pane
 *  header strip. The header is a 10px font on a narrow strip and
 *  long absolute paths make the session indistinguishable from its
 *  siblings when three panes are tiled across the same row. */
export function shortenCwd(cwd: string | null): string {
  if (!cwd) return '—'
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length <= 2) return '/' + parts.join('/')
  return '…/' + parts.slice(-2).join('/')
}

/** Human label for the provider kind, shown next to the scroll
 *  position badge above the composer. Unknown kinds default to
 *  'Claude Code' — historically every session was Claude, so a
 *  missing kind is treated as claude for back-compat. */
export function providerLabel(kind: SessionKind | undefined): string {
  switch (kind) {
    case 'codex':
      return 'Codex'
    case 'terminal':
      return 'Terminal'
    case 'claude':
    default:
      return 'Claude Code'
  }
}
