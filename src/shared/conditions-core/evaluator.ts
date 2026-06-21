// conditions-core / evaluator.ts
//
// The GENERIC HEADLESS EVALUATOR. This is the headless half's runtime engine:
// given a list of ConditionModules and a per-tick set of `inputs`, it produces
// the unified ConditionSnapshot that goes over the wire, and it owns the
// change-detection (dedupe) that decides whether a snapshot is worth emitting.
//
// WHY this file exists
// --------------------
// Before this, each provider's headless package re-implemented the SAME loop by
// hand: call each builder, drop the nulls, stuff the survivors into a `conditions`
// map keyed by `kind`, JSON.stringify it to dedupe, then emit. Codex did this in
// `evaluateCodexConditions` + `codexConditionSnapshotKey` + the dedupe latch
// inside `CodexHeadless.publishConditionSnapshot`. Claude will need the exact
// same shape next. Re-deriving identical glue per provider is how subtle drift
// (different key ordering, different dedupe semantics) creeps in. This evaluator
// is that glue, written ONCE, parameterized over the provider tag `P` and the
// per-provider input bundle `I`.
//
// WHY it's pure + clock-injected
// ------------------------------
// `now` is injected rather than calling `Date.now()` inline so the whole thing
// is deterministic and testable: the golden byte-for-byte verification (PR-2)
// pins `ts` to a fixed value to compare the OLD and NEW paths, and any future
// test can do the same. The evaluator holds exactly one piece of mutable state —
// `lastKey` for dedupe — and nothing else; everything else is a pure function of
// its arguments.
//
// THE ONE INVARIANT THAT MUST NOT DRIFT: insertion order is observable.
// --------------------------------------------------------------------
// `keyOf` is `JSON.stringify(snapshot.conditions)`. JSON.stringify serializes a
// plain object's keys in INSERTION ORDER. The dedupe latch compares these
// strings verbatim. Therefore the order in which modules add their records to
// the `conditions` map is part of the wire contract: two snapshots with the same
// records inserted in a different order produce DIFFERENT keys and would be
// treated as a change. This mirrors the legacy Codex behavior exactly (trust
// inserted before approval). The caller's `modules` array order IS that
// insertion order — DO NOT sort, DO NOT reorder. See CODEX_MODULES.

import type {
  ConditionAction,
  ConditionCustomAction,
  ConditionModule,
  ConditionRecord,
  ConditionSnapshot,
} from './contract.js'

// The evaluator the factory returns. Generic over provider tag `P` and the
// per-provider input bundle `I` so a single implementation serves Codex, Claude,
// and anything later.
export type ConditionEvaluator<P extends string, I> = {
  // Run every module over `inputs` and assemble the snapshot. Pure apart from
  // reading the injected clock; does NOT touch the dedupe state (that's `changed`).
  evaluate: (inputs: I) => ConditionSnapshot<P>
  // The dedupe key for a snapshot. IDENTICAL to the legacy
  // `codexConditionSnapshotKey`: JSON.stringify of the `conditions` map only
  // (NOT `ts` — `ts` changes every tick and would defeat deduping). Insertion
  // order is load-bearing; see the file header.
  keyOf: (snapshot: ConditionSnapshot<P>) => string
  // Change-detection latch. Returns true (and updates the stored key) when `key`
  // differs from the last key passed in. This is the single mutable cell in the
  // evaluator; callers gate their emit on it exactly as the old latch did.
  changed: (key: string) => boolean
  // Route a `custom` action to the first module that can resolve it. Dormant
  // today (no live module defines `resolve`), present so the contract is whole.
  resolveAction: (
    action: ConditionCustomAction,
    ctx: unknown,
  ) => void | Promise<void>
}

export function makeEvaluator<P extends string, I>(
  provider: P,
  // `readonly` + the `any` state param: a module list is heterogeneous — each
  // module has its own concrete state type S, and there is no single S that
  // unifies them. The contract's ConditionModule<string, I, any> is the erased
  // form the evaluator routes over (it only ever reads `kind` and calls
  // `actions(state)`; it never inspects the state's shape), so erasing S to
  // `any` here is sound and matches how ConditionOutlet erases the view side.
  modules: readonly ConditionModule<string, I, any>[],
  now: () => number,
): ConditionEvaluator<P, I> {
  // The dedupe cell. Seeded to '{}' so the FIRST evaluation of an empty
  // conditions map is correctly treated as "no change from the initial empty
  // snapshot" — matching CodexHeadless, whose `lastConditionKey` starts at '{}'
  // and whose initial `conditionSnapshot` is `{ conditions: {}, ts }`.
  let lastKey = '{}'

  function evaluate(inputs: I): ConditionSnapshot<P> {
    // Plain object, NOT a Map: JSON.stringify(conditions) must serialize in
    // insertion order for the dedupe key to be stable, and that's exactly what a
    // plain object gives us. Keys are added in module-array order below.
    const conditions: Record<string, ConditionRecord> = {}

    for (const module of modules) {
      const state = module.detect(inputs)
      // `detect` returning null means the condition is not live this tick — skip
      // it. (A module never emits a record for a condition that isn't present;
      // that's how the map stays "at most one record per live kind".)
      //
      // NOTE: we compare against `null` specifically, NOT a general falsy check.
      // A module's state could legitimately be a falsy-but-present value; the
      // contract's `detect: (I) => S | null` says null is the ONLY "not live"
      // sentinel, so that's the only thing we skip on.
      if (state === null) continue
      const actions: ConditionAction[] = module.actions(state)
      // Insertion happens HERE, in module order. This is the observable ordering
      // the dedupe key depends on. The record shape { kind, state, actions } is
      // exactly the legacy CodexCondition shape, so the serialized bytes match.
      conditions[module.kind] = { kind: module.kind, state, actions }
    }

    return {
      provider,
      conditions,
      ts: now(),
    }
  }

  function keyOf(snapshot: ConditionSnapshot<P>): string {
    // EXACTLY codexConditionSnapshotKey: stringify the conditions map, excluding
    // `ts`. Do not sort keys — see header invariant.
    return JSON.stringify(snapshot.conditions)
  }

  function changed(key: string): boolean {
    if (key === lastKey) return false
    lastKey = key
    return true
  }

  function resolveAction(
    action: ConditionCustomAction,
    ctx: unknown,
  ): void | Promise<void> {
    // First module whose `resolve` exists handles it. We don't try to match by
    // kind because a custom action's `name` (not `kind`) identifies its
    // resolver, and the dispatch contract narrows to ConditionCustomAction
    // already. Returns the first resolver's result (which may be a Promise the
    // caller awaits). No live module defines `resolve` yet, so today this is a
    // no-op fall-through; it exists so the multi-step answering driver (later PR)
    // has a wired path. The first module that defines `resolve` wins — if more
    // than one ever does, the registration order decides, matching how the
    // detect loop above is order-sensitive.
    for (const module of modules) {
      if (module.resolve) return module.resolve(action, ctx)
    }
  }

  return { evaluate, keyOf, changed, resolveAction }
}
