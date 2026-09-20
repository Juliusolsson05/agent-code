import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionMeta } from '@renderer/workspace/types'

/**
 * Does this session ever carry rendered transcript entries?
 *
 * WHY a shared predicate (#865): plain terminals have no transcript, and
 * commands that read `runtime.entries` (Copy Last Response, View Prompts,
 * Reader) checked only `kind !== 'terminal'` and so appeared on shells and
 * silently did nothing. One predicate now answers for all of them.
 *
 * WHY OpenCode Terminal (kind 'opencode', providerRuntime 'terminal') is
 * INCLUDED, reversing the #865 exclusion: PR #882's Stage 6 landed the reason
 * it was excluded — "the history loaders skip it" — becoming false in the
 * same release cycle. Both the initial history load and the durable committed
 * stream populate `runtime.entries` for terminal-runtime panes exactly like
 * every other agent, so the read commands have real data. The #865 safety
 * property that actually mattered — the rendered FEED never mounting on the
 * TUI pane — lives in a different contract and is untouched:
 * `getEffectiveAgentSurface` pins the pane to the terminal surface in every
 * view mode, and `commandAllowedByRenderedViewPolicy` hides every
 * feed-mounted command for this runtime (see #971).
 */
export function sessionHasTranscript(
  meta: Pick<SessionMeta, 'kind' | 'providerRuntime'> | undefined,
): boolean {
  if (!meta) return false
  return isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)
}
