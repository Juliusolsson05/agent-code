// See docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md
// §"Exhaustion signal".
//
// WHY this lives in `src/shared` and is a pure function of a snapshot:
//
// Two very different consumers need the same answer. The bulk switch modal uses
// it to choose a default direction and to disable "compact on source first"
// (the renderer), and the same derivation has to be readable from main when the
// usage IPC wants to carry it alongside the snapshot. A pure derivation over the
// already-normalized `UsageProviderSnapshot` keeps both sides agreeing by
// construction, with no provider payload knowledge here at all — Claude's `kind`
// and Codex's payload position are classified once, in the normalizers.
//
// WHY it is a read-only SIGNAL and never a gate: nothing in the switch
// transaction may branch on it. A provider's usage endpoint can be stale, wrong,
// or unreachable, and this feature exists precisely for people whose provider is
// misbehaving. It picks defaults in a modal the user can always override
// (decomposition, Stage 4: "it must not become a hard gate inside the
// transaction").
import type {
  UsageLimitRow,
  UsageLimitScope,
  UsageProviderKind,
  UsageProviderSnapshot,
} from '@shared/types/usage.js'

export type ProviderExhaustion = {
  provider: UsageProviderKind
  exhausted: boolean
  scope: UsageLimitScope
  /** When the blocking window resets, when the provider said; else null. */
  resetsAt: string | null
  /** The blocking row's label, for the banner. Empty when nothing blocks. */
  label: string
}

// WHY 100 and not the 95 that `severityFromPercent` already calls "critical":
// severity colors a header chip; this value gates defaults in a modal that
// MOVES AGENTS. A window at 96 percent still accepts turns, and switching a
// batch of agents to another provider on that basis would cost every one of
// them a transcript translation they did not need. Only a window the provider
// itself reports as fully used counts, and even then the modal is a default the
// user can override.
const EXHAUSTED_PERCENT = 100

export function deriveProviderExhaustion(snapshot: UsageProviderSnapshot): ProviderExhaustion {
  if (snapshot.status !== 'ok') {
    // An unreadable snapshot is NOT evidence of exhaustion — the Keychain item
    // may be missing or the endpoint down. `label` carries the provider's own
    // message so a banner can explain why no signal is available.
    return { provider: snapshot.provider, exhausted: false, scope: 'unknown', resetsAt: null, label: snapshot.message }
  }
  const hit = (scope: UsageLimitScope): UsageLimitRow | undefined => snapshot.rows.find(row => (
    row.active && row.scope === scope && row.percent !== null && row.percent >= EXHAUSTED_PERCENT
  ))
  // Order matters: a family window can be full at the same moment the account's
  // shared window is, and the shared one is the stronger claim (no model on this
  // provider will answer). Reporting `model-family` there would offer a model
  // switch that cannot possibly help.
  const shared = hit('all-models')
  if (shared) {
    return { provider: snapshot.provider, exhausted: true, scope: 'all-models', resetsAt: shared.resetsAt, label: shared.label }
  }
  const family = hit('model-family')
  if (family) {
    return { provider: snapshot.provider, exhausted: true, scope: 'model-family', resetsAt: family.resetsAt, label: family.label }
  }
  // `unknown`-scoped rows are never consulted: an unclassified window cannot say
  // whether the remedy is a provider switch or a model switch, and guessing
  // either way moves agents on evidence nobody has seen.
  return { provider: snapshot.provider, exhausted: false, scope: 'unknown', resetsAt: null, label: '' }
}
