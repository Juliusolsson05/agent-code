// conditions-core / view.ts
//
// The RENDERER half of the condition contract. Where contract.ts describes how
// a condition is DETECTED and what ACTIONS it offers, view.ts describes how a
// condition's `state` is PRESENTED and how a chosen action is dispatched back.
//
// WHY a separate "view" abstraction
// ---------------------------------
// The old design hand-switched on provider and hand-mounted each modal inside a
// per-provider outlet (ClaudeConditionOutlet / CodexConditionOutlet). Adding a
// condition meant editing the outlet, the selectors, the keybinds — the logic
// for one condition was smeared across files. A ConditionView co-locates
// everything the renderer needs to know about ONE kind: its Component, its
// attention level, and its layout. The generic outlet (ConditionOutlet.tsx)
// then routes purely by `kind`, so adding a condition is "register one view",
// not "edit the switch".

import type { ComponentType } from 'react'
import type { ConditionAction } from './contract'

// AttentionLevel classifies how loudly a live condition should pull the user's
// focus. These mirror the labels the existing renderer already computes in
// `src/renderer/src/workspace/conditions/selectors.ts`
// (dispatchAttentionLabelFromConditions): permission/approval → action-ish,
// trust → TRUST, resume → RESUME, compaction-error → ERROR.
//
// IMPORTANT: in THIS PR the `attention` field is DEFINED but NOT CONSUMED. The
// live attention/unread/dispatch-badge plumbing still reads selectors.ts as-is
// (left deliberately untouched — see the design doc's "deferred seam"). A later
// PR retires selectors.ts in favor of reading attention off the registered
// views. We define it now so the views are authored with the right metadata
// from day one and the migration is a deletion, not a re-derivation.
export type AttentionLevel = 'ACTION' | 'TRUST' | 'RESUME' | 'ERROR'

// Props every condition Component receives. `state` is the provider-specific
// state for this kind; `actions` is the wire action list; `dispatch` routes a
// chosen action back to the session (pty arm → sendInput today). Components are
// thin adapters over the EXISTING modal components — they translate the modal's
// `onSend(data)` callback into `dispatch({ kind: 'pty', … })`.
export type ConditionViewProps<S> = {
  state: S
  actions: ConditionAction[]
  dispatch: (action: ConditionAction) => Promise<void>
}

export type ConditionView<K extends string = string, S = unknown> = {
  kind: K
  Component: ComponentType<ConditionViewProps<S>>
  // Optional focus classifier (see AttentionLevel note above). Returns null
  // when this state shouldn't raise attention (e.g. a non-error compaction
  // strip). Not consumed yet.
  attention?: (state: S) => AttentionLevel | null
  // Presentation hint. 'modal' = full-screen overlay dialog; 'strip' = inline
  // bottom-pane strip (compaction, resume, approval). Defaults to 'modal' in
  // spirit; only used for documentation/future layout decisions today.
  layout?: 'modal' | 'strip'
}

// Identity helper so view definitions read as `defineView({ ... } as const)`
// and infer K/S from the literal. No runtime behavior.
export function defineView<K extends string, S>(
  view: ConditionView<K, S>,
): ConditionView<K, S> {
  return view
}
