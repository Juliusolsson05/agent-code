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
  // spawn.begin without a spawn.end on purpose: the terminal fact is already
  // recover.spawned/recover.failed, which carry the same duration. What this
  // rung adds that nothing else does is the GAP to provider.start.begin — the
  // time spent in spawn setup (MCP registration, proxy launch) before the
  // provider binary is even asked to start. A crash between them strands here.
  'spawn.begin',
  'provider.start.begin',
  'provider.start.end',

  // "Why is the composer not accepting input?"
  //
  // `gate.eval` is the single most important name here, and it is worth being
  // precise about what it does and does not do.
  //
  // `publishPromptGate` (claudeSession.ts) already deduplicates: it returns
  // early when the derived state equals the previous one, so the `prompt-gate`
  // event this rides is edge-triggered at the source. `gate.eval` therefore
  // records TRANSITIONS, not every evaluation — an earlier version of this
  // comment claimed otherwise and was simply wrong.
  //
  // What makes it valuable is the pairing with `readiness.publish`. That path
  // collapses the verdict to 'ready' | 'provider-not-ready' before it leaves
  // the provider, so a session that never becomes ready emits nothing
  // informative after the initial `{ready:false, reason:'starting'}`. Recording
  // the detailed verdict AND re-sampling it while it persists is what turns
  // "stuck at composer-unpainted for 90s" into a fact instead of a guess.
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

  // "Is this recording complete, or did I lose events?"
  //
  // Its own name rather than folding the count onto a nearby lifecycle event:
  // a reader reconstructing a ladder must be able to tell "this pane emitted
  // nothing" from "this pane's events were dropped". Attaching the count to,
  // say, `rehydrate.complete` would silently corrupt exactly the analysis this
  // stream exists to support.
  'report.suppressed',
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
// Enumerated by making `caller` a REQUIRED parameter of `ensureSessionLive` and
// letting the compiler find every call site. That forcing function turned up
// **13**, not the nine a grep had suggested — which is itself a small lesson
// about why this instrumentation exists at all.
export const WAKE_CALLERS = [
  // TileLeaf.send: the composer path. Wakes when the pane is not started/ready
  // or a raw write bounced. This is the site whose `!inputReady` gate caused
  // #598 — a live provider condition is *precisely* the state that clears
  // inputReady, so every click on a trust modal took the wake path.
  'tile-leaf.send',
  'tile-leaf.send-retry',
  // The Retry affordance under a failed pane's readiness banner.
  'tile-leaf.retry',
  // Mount-time wake. Unconditional until #597; the site that made every
  // Spotlight/Reader/Settings/tab-switch remount arm a 30s kill timer.
  'agent-terminal-leaf.mount',
  'agent-terminal-leaf.attach-retry',
  'terminal-leaf.mount',
  // Dispatch → grid placement, one per attached session.
  'pane.attach-detached',
  'pane.attach-all-detached',
  // Buried pane revival.
  'pane.revive-buried',
  'agent-index.navigate',
  // Wake the source pane before provider-switch compaction (#590).
  'provider-switch.wake-source',
  // MCP-driven: reading a child agent, and sending it a prompt. The only wake
  // callers that are not a direct human gesture — worth separating, because a
  // storm here means an orchestration loop rather than a UI remount.
  'orchestration.read-agent',
  'orchestration.send-prompt',
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
  // Free-form sub-classification for events whose variant is not an outcome.
  // Exists so `ok` is never overloaded to mean something other than success.
  'source',

  // outcome
  'ok',
  'code',
  'reason',
  'stage',
  'status',
  'retryable',
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
  // Not a session failure, but a gap in the recording — which for a stream
  // whose entire purpose is reconstructing what happened is worth surfacing at
  // the same level as one.
  'report.suppressed': 'warn',
}

export function severityForLifecycleEvent(name: SessionLifecycleEventName): 'info' | 'warn' {
  return SEVERITY_BY_NAME[name] ?? 'info'
}
