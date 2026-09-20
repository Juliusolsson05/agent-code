import { conditionStateByKind } from '@shared/types/providerConditions'
import type { ClaudeSlashPickerState, ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { SessionRuntime } from '@renderer/session-runtime/state'

// Folding a provider-conditions snapshot into a session runtime.
//
// WHY this lives in its own module rather than inside the IPC subscription
// that uses it: it is the ONE fold from a provider-conditions snapshot to a
// runtime, and #895's first attempt added a second producer beside it — a seed
// that read main's cached snapshot over `invoke` and ordered the two by
// timestamp. Review showed the ordering could not be made right (1 ms
// `Date.now()` ties are unordered, and OpenCode emits several snapshots per
// millisecond with no dedupe latch), and that it silently diverged on unread,
// attention and the feed-debug log.
//
// Main re-emits its cached snapshot on the ordinary `session:conditions`
// channel instead, so there is still exactly one producer and one fold. This
// module is where a reader looks for that fold, and the only thing a second
// caller may ever reuse.
//
// It also owns the COMPOSER PICKER, which is the part a hand-written copy
// forgets: `conditions` and `picker` are two projections of one snapshot, and
// they must never be written apart.

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
