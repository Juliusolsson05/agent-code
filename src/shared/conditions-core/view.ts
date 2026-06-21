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

// ── Sound provider registry typing (compile-time kind→state binding) ─────────
//
// WHY this helper exists
// ----------------------
// A provider's view registry is an object literal mapping each condition kind to
// its view: `{ 'codex.approval': approvalView, 'codex.trust-dialog': trustView }`.
// We want the COMPILER to guarantee that the key a view is filed under matches
// the kind/state that view actually handles — i.e. that you can't accidentally
// file the approval view (`ConditionView<'codex.approval', CodexApprovalState>`)
// under key `'codex.trust-dialog'` (a different kind + state shape) and still
// build. The previous code erased every view to `ConditionView` via
// `v as unknown as ConditionView` BEFORE assembling the registry, which threw
// that guarantee away: any kind could point at any component and still compile.
//
// The provider's STATE-BY-KIND map (e.g. `CodexStateByKind`) is the source of
// truth: it declares, per kind string, the exact `state` type that kind carries.
// `ViewRegistry<M>` turns that map into "the shape a fully-populated registry
// must have" — every key `K` must map to a `ConditionView<K, M[K]>`, i.e. a view
// whose kind AND state both line up with the declaration.
//
// Provider literals are checked with `... satisfies Partial<ViewRegistry<M>>`
// (Partial because not every declared kind needs a view yet — e.g.
// `codex.switch-model-prompt` is emitted but has no renderer). `satisfies`
// validates the literal against the registry shape WITHOUT widening it (so the
// concrete per-key view types are preserved), and a kind→wrong-view mapping
// becomes a compile error HERE, at the provider boundary, before the registry is
// erased to `Record<string, ConditionView>` for the outlet. The outlet's erasure
// stays sound because the outlet only routes by `kind` and never reads `state`;
// the precise binding is proven at the literal, ahead of erasure.
export type ViewRegistry<M> = {
  [K in keyof M & string]: ConditionView<K, M[K]>
}

// eraseRegistry — the ONE place the precise-to-erased cast lives.
//
// WHY a cast is unavoidable here (and why exactly ONE is sound)
// ------------------------------------------------------------
// The outlet stores views as `Record<string, ConditionView>` where
// `ConditionView = ConditionView<string, unknown>`, and at render time it hands
// each view's Component a `state: unknown` (the snapshot's `state` is `unknown`
// by the wire contract). But a precise `ConditionView<'codex.approval',
// CodexApprovalState>` has `Component: ComponentType<{ state: CodexApprovalState;
// … }>`. Because `state` sits in the Component's PARAMETER (contravariant)
// position, a Component that demands `CodexApprovalState` is NOT structurally
// assignable to one that must accept `unknown` — so a precise registry is NOT a
// subtype of the erased `Record<string, ConditionView>`. That is real, not a
// quirk: the type system is correctly refusing to promise the precise Component
// can survive an arbitrary `unknown`. The old code papered over this with a
// per-view `v as unknown as ConditionView`, which ALSO silently let a view be
// filed under the wrong kind.
//
// We accept ONE deliberate erasure cast, justified by the runtime invariant the
// types can't see: the outlet only ever passes a Component the state that came
// in the SAME snapshot record under the SAME kind. The headless emitter is the
// source of truth that `kind: 'codex.approval'` always carries a
// `CodexApprovalState`. So at the single call site where the registry crosses
// into the erased world, the `state` a Component receives is in fact its own
// precise S — the erasure is sound by construction, not by the type system.
//
// Crucially, the SOUNDNESS OF THE KIND→VIEW BINDING is no longer entangled with
// this cast: the `reg` parameter is typed `Partial<ViewRegistry<M>>`, so the
// provider's registry literal is fully checked (kind matches state, no view
// filed under the wrong key) by THIS function's signature BEFORE the cast runs.
// A wrong mapping fails to compile at the call site; the cast only erases S for
// routing. This replaces N unchecked `as unknown as ConditionView` casts with 1
// checked-input erasure.
export function eraseRegistry<M>(
  reg: Partial<ViewRegistry<M>>,
): Record<string, ConditionView> {
  return reg as Record<string, ConditionView>
}
