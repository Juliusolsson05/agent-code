import type { AgentViewMode } from '@renderer/app-state/settings/types'
import type { AgentViewModeOverride, SessionKind } from '@renderer/workspace/types'
import { isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind, AgentProviderRuntime } from '@shared/types/providerKind'
import type {
  RenderedViewLeaseFeature,
  SessionRuntime,
} from '@renderer/session-runtime/state'
import { hasVisibleConditions } from '@renderer/workspace/conditions/selectors'

export type EffectiveAgentSurface = 'rendered' | 'terminal'

export type RenderedViewPolicy =
  | { kind: 'none' }
  | { kind: 'requires-rendered-feed' }
  | { kind: 'opens-rendered-feed' }
  | { kind: 'leases-rendered-feed'; feature: RenderedViewLeaseFeature }

export function resolveConfiguredAgentViewMode(
  globalMode: AgentViewMode,
  override: AgentViewModeOverride | undefined,
): AgentViewMode {
  return override ?? globalMode
}

// Delegates to the shared guard so a registered third provider is an
// agent here automatically instead of being misclassified as a
// terminal pane (#394 phase 1).
export function isAgentKind(kind: SessionKind | undefined): kind is AgentProviderKind {
  return isAgentProviderKind(kind)
}

export function renderedViewLeaseCount(runtime: SessionRuntime): number {
  return Object.values(runtime.renderedViewLeases).reduce(
    (total, count) => total + Math.max(0, count ?? 0),
    0,
  )
}

function normalizeAgentViewModeForKind(
  kind: AgentProviderKind,
  mode: AgentViewMode,
): AgentViewMode {
  if (kind !== 'opencode') return mode
  // WHY ordinary OpenCode is pinned to Agent mode:
  // Claude/Codex "Terminal" means "attach xterm to the real provider PTY."
  // The ordinary OpenCode choice is still HTTP/SSE and has no PTY, so mounting
  // AgentTerminalLeaf would paint an empty terminal. OpenCode Terminal is a
  // separately selected process runtime and is forced to terminal before this
  // normalizer runs; keeping this pin prevents the two choices from collapsing
  // back into one misleading view toggle.
  return 'agent'
}

export function getEffectiveAgentSurface(args: {
  kind: SessionKind | undefined
  providerRuntime?: AgentProviderRuntime
  mode: AgentViewMode
  runtime: SessionRuntime
}): EffectiveAgentSurface {
  const { kind, runtime } = args
  const requestedMode: AgentViewMode =
    args.mode === 'terminal' || args.mode === 'hybrid' || args.mode === 'agent'
      ? args.mode
      : 'agent'
  if (!isAgentKind(kind)) return 'rendered'
  // A terminal-flavoured provider session is a different process contract,
  // not merely a view preference. It has PTY bytes and deliberately no
  // structured feed, so no global/per-pane mode may mount the rendered leaf.
  if (args.providerRuntime === 'terminal') return 'terminal'
  const mode = normalizeAgentViewModeForKind(kind, requestedMode)

  // WHY this selector ignores leases in hard Terminal mode:
  // Terminal mode is the user's "never mount Agent Code's renderer for this
  // agent pane" preference. Hybrid is the mode that grants features a
  // temporary renderer lease. Letting leases promote hard Terminal mode would
  // make the setting lie exactly when users choose it as a recovery surface for
  // broken feed/composer behavior.
  if (mode === 'agent') return 'rendered'
  if (mode === 'terminal') return 'terminal'

  // WHY draft input promotes Hybrid even without an explicit lease:
  // the composer is part of the rendered Agent Code surface. Commands like
  // Prompt Template intentionally stop at "prefill the draft, do not send";
  // if Hybrid stayed on the raw terminal after that write, the command would
  // technically succeed while hiding the only UI where the user can inspect,
  // edit, or submit the inserted text. Tying promotion to non-empty draft
  // state also gives Hybrid a natural release point: once the draft is cleared
  // or submitted, the pane falls back to the terminal without each composer
  // feature needing its own bespoke lease bookkeeping.
  if (
    runtime.draftInput.trim().length > 0 ||
    runtime.draftImages.length > 0 ||
    runtime.promptSuggestion !== null ||
    // WHY hasVisibleConditions and not `conditions !== null` (conditions audit
    // Additional Finding A): a provider can leave a non-null snapshot attached
    // whose condition map is empty or fully dismissed. Promoting to Hybrid on
    // mere snapshot presence flips pane layout with nothing to show. We promote
    // only when a condition is actually on screen and needs the pane chrome.
    hasVisibleConditions(runtime.conditions) ||
    runtime.queuedMessages.length > 0
  ) {
    // WHY these runtime fields promote Hybrid:
    // every one is a feature surface that currently exists only in TileLeaf:
    // composer draft/images, prompt suggestions, provider condition/action UI,
    // and queued-prompt feedback. Leaving Hybrid on the terminal while these
    // fields are non-empty creates hidden state: the app "has" something for
    // the user to review or act on, but the mounted surface cannot show it.
    // Hard Terminal still ignores all of this by design; Hybrid is the mode
    // that promises Agent Code will temporarily render when an Agent Code
    // feature needs the pane chrome.
    return 'rendered'
  }
  return renderedViewLeaseCount(runtime) > 0 ? 'rendered' : 'terminal'
}

export function getEffectiveAgentSurfaceForSession(args: {
  kind: SessionKind | undefined
  providerRuntime?: AgentProviderRuntime
  globalMode: AgentViewMode
  override: AgentViewModeOverride | undefined
  runtime: SessionRuntime
}): EffectiveAgentSurface {
  // WHY this composition is a named policy boundary instead of two calls at
  // every consumer: the pane renderer and any auxiliary terminal surface must
  // agree on which surface owns the provider PTY. A per-session override was
  // once added to TileTree without being added to the debug-panel guard. That
  // allowed two differently-sized xterms to call resize() for one PTY, making
  // the provider TUI alternate between their row/column pairs. Keeping global
  // mode, durable session override, provider normalization, and Hybrid runtime
  // promotion in one selector makes dropping any of those inputs harder.
  return getEffectiveAgentSurface({
    kind: args.kind,
    providerRuntime: args.providerRuntime,
    mode: resolveConfiguredAgentViewMode(args.globalMode, args.override),
    runtime: args.runtime,
  })
}

export function commandAllowedByRenderedViewPolicy(args: {
  policy: RenderedViewPolicy | undefined
  kind: SessionKind | undefined
  providerRuntime?: AgentProviderRuntime
  mode: AgentViewMode
  runtime: SessionRuntime
}): boolean {
  const policy = args.policy ?? { kind: 'none' }
  if (policy.kind === 'none') return true
  if (!isAgentKind(args.kind)) return true
  if (args.providerRuntime === 'terminal') return false
  const requestedMode: AgentViewMode =
    args.mode === 'terminal' || args.mode === 'hybrid' || args.mode === 'agent'
      ? args.mode
      : 'agent'
  const mode = normalizeAgentViewModeForKind(args.kind, requestedMode)

  // Commands that open/promote the rendered surface are exactly what Hybrid
  // exists for: show them in Agent and Hybrid, but hide them in hard Terminal
  // mode. `leases-rendered-feed` means the command owns an explicit runtime
  // lease (Copy Assistant picker). `opens-rendered-feed` covers commands whose
  // promotion is caused by other rendered state, such as composer draft text.
  // Commands that merely require an already-rendered feed do not auto-promote
  // Hybrid; they stay unavailable while Hybrid is resting on the raw terminal.
  if (policy.kind === 'leases-rendered-feed' || policy.kind === 'opens-rendered-feed') {
    return mode !== 'terminal'
  }
  return getEffectiveAgentSurface({
    kind: args.kind,
    providerRuntime: args.providerRuntime,
    mode,
    runtime: args.runtime,
  }) === 'rendered'
}
