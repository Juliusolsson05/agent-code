import type { AgentViewMode } from '@renderer/app-state/settings/types'
import type { SessionKind } from '@renderer/workspace/types'
import type {
  RenderedViewLeaseFeature,
  SessionRuntime,
} from '@renderer/workspace/workspaceState'

export type EffectiveAgentSurface = 'rendered' | 'terminal'

export type RenderedViewPolicy =
  | { kind: 'none' }
  | { kind: 'requires-rendered-feed' }
  | { kind: 'leases-rendered-feed'; feature: RenderedViewLeaseFeature }

export function isAgentKind(kind: SessionKind | undefined): kind is 'claude' | 'codex' {
  return kind === 'claude' || kind === 'codex'
}

export function renderedViewLeaseCount(runtime: SessionRuntime): number {
  return Object.values(runtime.renderedViewLeases).reduce(
    (total, count) => total + Math.max(0, count ?? 0),
    0,
  )
}

export function getEffectiveAgentSurface(args: {
  kind: SessionKind | undefined
  mode: AgentViewMode
  runtime: SessionRuntime
}): EffectiveAgentSurface {
  const { kind, mode, runtime } = args
  if (!isAgentKind(kind)) return 'rendered'

  // WHY this selector ignores leases in hard Terminal mode:
  // Terminal mode is the user's "never mount Agent Code's renderer for this
  // agent pane" preference. Hybrid is the mode that grants features a
  // temporary renderer lease. Letting leases promote hard Terminal mode would
  // make the setting lie exactly when users choose it as a recovery surface for
  // broken feed/composer behavior.
  if (mode === 'agent') return 'rendered'
  if (mode === 'terminal') return 'terminal'
  return renderedViewLeaseCount(runtime) > 0 ? 'rendered' : 'terminal'
}

export function commandAllowedByRenderedViewPolicy(args: {
  policy: RenderedViewPolicy | undefined
  kind: SessionKind | undefined
  mode: AgentViewMode
  runtime: SessionRuntime
}): boolean {
  const policy = args.policy ?? { kind: 'none' }
  if (policy.kind === 'none') return true
  if (!isAgentKind(args.kind)) return true

  // A command that leases the renderer is exactly what Hybrid exists for:
  // show it in Agent and Hybrid, but hide it in hard Terminal mode. Commands
  // that merely require an already-rendered feed do not auto-promote Hybrid in
  // v1; they stay unavailable while Hybrid is resting on the raw terminal.
  if (policy.kind === 'leases-rendered-feed') return args.mode !== 'terminal'
  return getEffectiveAgentSurface({
    kind: args.kind,
    mode: args.mode,
    runtime: args.runtime,
  }) === 'rendered'
}
