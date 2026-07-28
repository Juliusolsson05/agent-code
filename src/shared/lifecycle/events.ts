// The session-lifecycle event vocabulary.
//
// WHY this file exists at all — read `docs/decomposition/agent-boot-readiness.md`
// §0 before changing anything here. Agent boot has been patched ~30 times since
// 2026-04-11 and has never converged, for one measured reason: **no boot event
// has ever been recorded.** Every fix was authored from source reading against a
// failure nobody had captured. This vocabulary is the instrument that ends that.
//
// WHY the vocabulary is CLOSED (a union, not `string`):
// An open event name is how a diagnostic channel rots into noise nobody reads.
// A closed set means a human — or a summarizer script — can enumerate every
// event the system can emit by reading this one file top to bottom. Adding a
// name is a deliberate contract change, reviewed like any other.
//
// WHY the data keys are an ALLOWLIST and not "whatever the call site passes":
// This stream is always on and lands on disk. An open payload is how a debug
// channel becomes a privacy incident (a caller adds `{ prompt }` "just for
// now"). The allowlist inverts the default: unknown keys are dropped, so a
// careless call site loses a field instead of leaking one. This is the same
// posture as the rendering fixture redactor, which is hard-gated rather than
// best-effort.
//
// This module must remain Node- and DOM-free: main, preload, and the renderer
// all import it (the renderer needs the same name/key validation main applies,
// so a bad renderer event is rejected at BOTH ends rather than trusted).

/**
 * `AppRunJournalEvent.area` for every event in this vocabulary.
 *
 * WHY these ride the existing incident journal instead of a new store: see
 * `SessionLifecycleJournal`. Short version — `AppRunJournal` is already
 * always-on, byte-capped, redacting, and degrades to a no-op on an unwritable
 * `~/.config`. Re-earning that scar tissue in a second store would be strictly
 * worse, and co-locating with heap/crash breadcrumbs means a stall can be
 * correlated against main-process health in ONE file.
 */
export const SESSION_LIFECYCLE_AREA = 'session.lifecycle'

/**
 * Every event this subsystem can emit.
 *
 * Grouped by the question each group answers. If you find yourself wanting an
 * event that answers a NEW question, that is a signal worth pausing on — the
 * decomposition's Stage 4 catalog is where new questions are supposed to come
 * from, derived from recordings, not from imagination.
 */
export const SESSION_LIFECYCLE_EVENT_NAMES = [
  // "What did restore try to do, and did every pane get an answer?"
  'rehydrate.start',
  'rehydrate.complete',

  // "Who owns this pane's backend, and how did that get decided?"
  'recover.request',
  'recover.claim',
  'recover.join',
  'recover.adopted',
  'recover.spawned',
  'recover.conflict',
  'recover.cancelled',
  'recover.failed',

  // "How long did actually starting a provider process take?"
  'spawn.begin',
  'spawn.end',
  'provider.start.begin',
  'provider.start.end',

  // "Why is the composer not accepting input?"
  //
  // `gate.eval` is the single most important name here. `publishPromptGate`
  // (claudeSession.ts) is EDGE-triggered — it emits only on a transition into
  // or out of ready. A session that never becomes ready therefore emits
  // nothing at all after the initial `{ready:false, reason:'starting'}`, which
  // is precisely why "the agent takes minutes to start" has never been
  // diagnosable. `gate.eval` fires on EVERY evaluation, so "stuck at
  // composer-unpainted for 90s" becomes a recorded fact instead of a guess.
  'gate.eval',
  'readiness.publish',

  // "Who asked for this session to be woken, and what happened?"
  //
  // There are nine distinct wake call sites across seven files (decomposition
  // §3, Tier 4). Every historical incident is one of them behaving differently
  // from the others. `caller` is what will finally tell us WHICH of them
  // actually differ — which is why this PR instruments them in place rather
  // than consolidating them on a guess.
  'wake.request',
  'wake.result',

  // "Did the transcript ever finish loading?" (#283's stuck-at-loading class)
  'history.load.start',
  'history.load.end',

  // "Did the prompt reach the provider?"
  'submit.begin',
  'submit.result',
  // The Bug B repair firing. Recorded so we can measure how often a submit
  // failed with nothing written — i.e. how often the old build would have
  // wedged the pane until an agent reload.
  'submit.unwound',
  'delivery.reject',

  // "Did something kill this backend, and who?"
  'kill.request',
] as const

export type SessionLifecycleEventName = (typeof SESSION_LIFECYCLE_EVENT_NAMES)[number]

const EVENT_NAME_SET: ReadonlySet<string> = new Set(SESSION_LIFECYCLE_EVENT_NAMES)

export function isSessionLifecycleEventName(value: unknown): value is SessionLifecycleEventName {
  return typeof value === 'string' && EVENT_NAME_SET.has(value)
}

/**
 * Identifies which of the nine wake call sites issued a `wake.request`.
 *
 * WHY a closed union rather than a free string: the whole point of tagging the
 * caller is to compare sites against each other in the Stage 4 catalog. Free
 * strings drift (`'TileLeaf'` vs `'tileleaf-send'`) and a drifted tag silently
 * splits one shape into two, which is worse than no tag at all.
 */
export const WAKE_CALLERS = [
  'tile-leaf.send',
  'tile-leaf.retry',
  'agent-terminal-leaf.mount',
  'terminal-leaf.mount',
  'composer-actions.retry',
  'pane.attach',
  'pane.focus',
  'agent-index.navigate',
  'provider-switch.wake-source',
  'undo-close.revive',
  'orchestration.request',
] as const

export type WakeCaller = (typeof WAKE_CALLERS)[number]

/**
 * The allowlisted top-level payload keys.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRAP — READ BEFORE ADDING A KEY.
 *
 * `AppRunJournal.createEvent` runs every payload through
 * `sanitizePerformanceData`, which DROPS any top-level key matching
 *
 *     /prompt|content|text|env|token|secret|key/i
 *
 * ...silently. That regex is a privacy control and is deliberately not being
 * relaxed. But it means a naively-named field vanishes with no error:
 *
 *   - `promptWritten` → dropped (matches `prompt`)   → use `bodyWritten`
 *   - `context`       → dropped (matches `text`)     → use a specific noun
 *   - `envKind`       → dropped (matches `env`)      → rename
 *
 * Every key below has been checked against that regex. If you add one, check
 * it too, or you will ship an event that records nothing and looks fine in
 * review.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY metadata only: this stream is always on and retained on disk. It records
 * ids, kinds, phases, reasons, counts, durations and booleans — never prompts,
 * assistant output, tool payloads, file contents, commands, MCP URLs, or
 * tokens. The allowlist is what makes that a structural guarantee rather than a
 * convention someone eventually forgets.
 */
export const SESSION_LIFECYCLE_DATA_KEYS = [
  // identity / classification
  'kind',
  'caller',
  'disposition',
  'lifecycle',
  'provider',
  'source',

  // outcome
  'ok',
  'code',
  'reason',
  'stage',
  'status',
  'retryable',
  'exitCode',
  'cause',

  // readiness
  'ready',
  'revision',
  'gate',
  'resolvable',
  'conditionKind',

  // delivery evidence (see the trap above — NOT `promptWritten`)
  'bodyWritten',
  'enterWritten',
  'registryHit',
  'hasResumeId',

  // shape / volume
  'tabs',
  'leaves',
  'detached',
  'buried',
  'expectedCount',
  'resolvedCount',
  'entryCount',
  'suppressed',
  'attempt',

  // timing
  'durationMs',
  'elapsedMs',
] as const

export type SessionLifecycleDataKey = (typeof SESSION_LIFECYCLE_DATA_KEYS)[number]

const DATA_KEY_SET: ReadonlySet<string> = new Set(SESSION_LIFECYCLE_DATA_KEYS)

/**
 * A lifecycle payload. Every value is a primitive: the journal's sanitizer only
 * inspects TOP-LEVEL keys, so a nested object would sail past the allowlist
 * carrying whatever it liked. Keeping values flat makes the allowlist total.
 */
export type SessionLifecycleData = Partial<
  Record<SessionLifecycleDataKey, string | number | boolean | null>
>

/**
 * Drop every key that is not allowlisted, and every value that is not a
 * primitive.
 *
 * Applied at BOTH ends of the renderer→main bridge on purpose. Main cannot
 * trust a renderer payload (the sender may itself be misbehaving — the same
 * reasoning `ipc/incident.ts` already applies), and the renderer filtering
 * first means a mistake shows up in a renderer unit test rather than only in a
 * file on someone's disk.
 */
export function pickLifecycleData(data: unknown): SessionLifecycleData | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!DATA_KEY_SET.has(key)) continue
    if (value === null) {
      out[key] = null
      continue
    }
    const t = typeof value
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out[key] = value as string | number | boolean
    }
    // Anything else (object, array, function, undefined) is dropped rather than
    // stringified: a stringified object is exactly how payload text sneaks into
    // a metadata-only stream.
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Severity is derived from the event name, not passed by callers.
 *
 * WHY: severity is a property of WHAT HAPPENED, not of who is reporting it. Two
 * call sites emitting `recover.failed` at different severities would make the
 * stream un-filterable, and "which severity do I pass here?" is a decision no
 * instrumentation call site should have to make — every such decision is one
 * more way for an emit point to be subtly wrong.
 */
const SEVERITY_BY_NAME: Partial<Record<SessionLifecycleEventName, 'warn'>> = {
  'recover.conflict': 'warn',
  'recover.cancelled': 'warn',
  'recover.failed': 'warn',
  'delivery.reject': 'warn',
  'submit.unwound': 'warn',
}

export function severityForLifecycleEvent(name: SessionLifecycleEventName): 'info' | 'warn' {
  return SEVERITY_BY_NAME[name] ?? 'info'
}
