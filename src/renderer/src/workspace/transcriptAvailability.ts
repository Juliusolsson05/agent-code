import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionMeta } from '@renderer/workspace/types'

/**
 * Does this session ever carry rendered transcript entries?
 *
 * WHY a shared predicate (#865): plain terminals have no transcript, and
 * OpenCode Terminal (kind 'opencode', providerRuntime 'terminal') never loads
 * one either. The history loaders (hook/actions/initialHistory.ts,
 * hook/actions/history.ts) skip it. Commands that read `runtime.entries`
 * (Copy Last Response, View Prompts, Reader) checked only `kind !== 'terminal'`
 * and so appeared on OpenCode Terminal and silently did nothing.
 */
export function sessionHasTranscript(
  meta: Pick<SessionMeta, 'kind' | 'providerRuntime'> | undefined,
): boolean {
  if (!meta) return false
  return isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER) && meta.providerRuntime !== 'terminal'
}
