import { conditionStateByKind } from '@shared/types/providerConditions'
import type { ClaudeSlashPickerState, ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { SessionRuntime } from '@renderer/session-runtime/state'

// Folding a provider-conditions snapshot into a session runtime.
//
// WHY this is one function in a neutral module rather than a helper inside the
// IPC subscription that first needed it: there are now TWO producers of a
// snapshot — the live `session:conditions` channel, and the backend snapshot a
// window reads when it ADOPTS another window's sessions (#895) — and they must
// project it identically. A second copy of the projection is how the composer
// picker would end up stale on exactly one of the two paths.

/**
 * WHY only the composer picker is projected out of the normalized snapshot:
 * it is a distinct renderer-owned UI model consumed by the input composer.
 * Prompt mirrors used to copy trust/permission/resume/approval into four
 * additional runtime fields, but every real consumer now reads `conditions`
 * through provider policy. Retaining those copies would recreate split
 * authority whenever a new condition or field is added.
 *
 * The composer picker kind is provider policy (claude.slash-picker today;
 * codex has none). Absence from the map means "not live" and must clear the
 * composer picker — the legacy sticky fallback was deliberately removed.
 */
export function applyConditionSnapshot(
  runtime: SessionRuntime,
  snapshot: ProviderConditionSnapshot,
): SessionRuntime {
  const pickerKind = getRendererProviderCapabilities(snapshot.provider)
    .conditionPolicy.composerPickerKind
  const slashPicker = pickerKind
    ? conditionStateByKind<ClaudeSlashPickerState>(snapshot, pickerKind)
    : null

  return {
    ...runtime,
    conditions: snapshot,
    picker: slashPicker ?? { visible: false, items: [] },
  }
}

/**
 * Is `incoming` newer than what the runtime already holds?
 *
 * WHY `ts` and not "is there anything there yet" (#895): a window adopting
 * another window's sessions already owns their event routing before the
 * adoption offer arrives, and the live channel CREATES a runtime for a session
 * it has never seen (`prev[sessionId] ?? emptyRuntime()`). So a prompt
 * dismissed while main's cached snapshot is in flight is already in the map
 * when the seed runs, and a seed that simply overwrites it puts the dismissed
 * prompt back — in the surface the user acts on.
 *
 * Ties go to what is already there: a snapshot with the same `ts` carries the
 * same facts, and replacing it would churn the picker for nothing.
 */
export function conditionSnapshotIsNewer(
  incoming: ProviderConditionSnapshot,
  held: ProviderConditionSnapshot | null | undefined,
): boolean {
  return !held || incoming.ts > held.ts
}

/**
 * Fold a backend snapshot's cached conditions into a runtime being SEEDED —
 * on adoption, on cold rehydrate, and on waking a parked session.
 *
 * All three build their runtime from `emptyRuntime()` or from a spread that
 * predates the snapshot, and all three used to leave `conditions: null` on a
 * backend that was already blocked (#895). `observed` is whatever the live
 * channel has written for this session in the meantime, which on the adoption
 * path can be NEWER than the cache main answered with.
 *
 * Re-applying the held snapshot rather than copying the field is deliberate:
 * the projection also owns the composer picker, and a seed that carried
 * `conditions` without it would leave the two disagreeing.
 */
export function seedBackendConditions(
  seeded: SessionRuntime,
  observed: SessionRuntime | undefined,
  incoming: ProviderConditionSnapshot | null | undefined,
): SessionRuntime {
  const held = observed?.conditions ?? null
  if (incoming && conditionSnapshotIsNewer(incoming, held)) return applyConditionSnapshot(seeded, incoming)
  return held ? applyConditionSnapshot(seeded, held) : seeded
}
