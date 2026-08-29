import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
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
 *  position badge above the composer. A missing kind defaults to
 *  'Claude Code' — historically every session was Claude, so an
 *  absent kind is treated as claude for back-compat. */
export function providerLabel(kind: SessionKind | undefined): string {
  // Registry-derived long display name for agent kinds (#394 phase 2c-2).
  //
  // The two non-agent kinds carry literals because neither has a provider
  // registry entry to derive a name from. They are listed EXPLICITLY rather
  // than left to the fallback: the `undefined` fallback means "pre-kind
  // back-compat session, therefore Claude", and letting a known non-agent kind
  // reach it would print "Claude Code" on a pane that has no agent at all.
  // extension-view cannot reach here today (TileTree routes it to
  // ExtensionViewLeaf before TileLeaf mounts), but this function is exported
  // and takes a bare SessionKind, so the first caller outside the tile would
  // silently get the wrong label.
  if (kind === 'terminal') return 'Terminal'
  if (kind === 'extension-view') return 'Extension'
  if (kind !== undefined && isAgentProviderKind(kind)) {
    return getRendererProviderCapabilities(kind).name
  }
  return getRendererProviderCapabilities(DEFAULT_PROVIDER).name
}
