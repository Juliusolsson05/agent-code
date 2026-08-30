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
 * The Stage 0 observations that can be exported as the dedicated
 * `codex-transcript-observations` stream.
 *
 * WHY this is a named subset of the broader lifecycle vocabulary: the bundle
 * exporter and session recorder need to select only the evidence that explains
 * transcript continuity. Matching a prefix such as `submit.*` would silently
 * change the export whenever an unrelated submit diagnostic was added. A
 * closed subset makes that privacy and storage boundary reviewable here.
 *
 * These remain observations, never commands. Nothing in production may read
 * one of these events to decide delivery, attachment, reconciliation, or
 * rendering; Stage 0 must be removable without changing runtime behaviour.
 */
export const CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAMES = [
  'submit.begin',
  'submit.result',
  'submit.unwound',
  'submit.write',
  'submit.surface',
  'submit.reconcile',
  'submit.release',
  'provider.request',
  'semantic.turn',
  'transcript.attachment',
  'transcript.candidate',
  'transcript.entry',
  'transcript.outbox-gap',
  'transcript.surface-gap',
  'transcript.observation-gap',
  'transcript.snapshot',
] as const

export type CodexTranscriptObservationEventName =
  (typeof CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAMES)[number]

/** Facts whose producer actually lives in the renderer. */
export const CODEX_RENDERER_TRANSCRIPT_OBSERVATION_EVENT_NAMES = [
  'submit.begin',
  'submit.result',
  'submit.unwound',
  'submit.surface',
  'submit.reconcile',
  'submit.release',
  'transcript.outbox-gap',
  'transcript.surface-gap',
  'transcript.snapshot',
] as const satisfies readonly CodexTranscriptObservationEventName[]

const CODEX_RENDERER_TRANSCRIPT_OBSERVATION_EVENT_NAME_SET: ReadonlySet<string> =
  new Set(CODEX_RENDERER_TRANSCRIPT_OBSERVATION_EVENT_NAMES)

export function isCodexRendererTranscriptObservationEventName(
  value: unknown,
): value is (typeof CODEX_RENDERER_TRANSCRIPT_OBSERVATION_EVENT_NAMES)[number] {
  return typeof value === 'string' &&
    CODEX_RENDERER_TRANSCRIPT_OBSERVATION_EVENT_NAME_SET.has(value)
}

/** Versioned, content-safe row shared by recordings and bundle projections. */
export type CodexTranscriptObservation = {
  schemaVersion: 1
  name: CodexTranscriptObservationEventName
  ids?: SessionLifecycleCorrelationIds & { sessionId?: string }
  data?: SessionLifecycleData
}

const CODEX_TRANSCRIPT_OBSERVATION_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Main-owned pane scope accepted by the shareable Stage 0 evidence streams. */
export function isCodexTranscriptObservationSessionId(value: unknown): value is string {
  return typeof value === 'string' && CODEX_TRANSCRIPT_OBSERVATION_SESSION_ID.test(value)
}

const CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAME_SET: ReadonlySet<string> =
  new Set(CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAMES)

export function isCodexTranscriptObservationEventName(
  value: unknown,
): value is CodexTranscriptObservationEventName {
  return typeof value === 'string' && CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAME_SET.has(value)
}

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

  // "Did an authorized same-pane Codex replacement retire the old exact
  // rollout owner before the successor reached provider start?"
  'replacement.handoff.begin',
  'replacement.handoff.end',
  // "Did the renderer make the successor's random local ID durable?" Spawn
  // success alone cannot answer this because the invoking renderer may reload
  // before its workspace remap reaches disk.
  'replacement.commit',
  // "Did a successor failure restore the predecessor's stable local ID?"
  'replacement.rollback.begin',
  'replacement.rollback.end',

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
  // The Bug B repair firing. Recorded so we can measure how often a submit
  // failed with nothing written — i.e. how often the old build would have
  // wedged the pane until an agent reload.
  ...CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAMES,
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
 * Opaque identifiers permitted on transcript-continuity observations.
 *
 * WHY there is no single `promptId`: the incident evidence crosses schedulers
 * and authorities that do not expose one causal token. Pretending the local
 * Enter UUID also identifies a provider request or rollout entry would turn a
 * timing guess into recorded truth. These ids stay separate and are joined
 * only when a producer actually observed the relation.
 *
 * `sessionId` is intentionally absent. It is already a first-class app-journal
 * id and, on renderer IPC, main derives it from the report's session scope.
 * Allowing a second copy inside `correlationIds` would permit contradictory
 * pane attribution in the same event.
 */
export const SESSION_LIFECYCLE_CORRELATION_ID_KEYS = [
  'sessionRunId',
  'submissionId',
  'proxyRequestId',
  'proxyFlowId',
  'semanticTurnId',
  'rolloutEntryId',
  'fileGenerationId',
  'renderCandidateId',
  'candidateFingerprint',
  'providerWindowFingerprint',
  'providerWindowGenerationId',
  'providerSessionMetaFingerprint',
] as const

export type SessionLifecycleCorrelationIdKey =
  (typeof SESSION_LIFECYCLE_CORRELATION_ID_KEYS)[number]

export type SessionLifecycleCorrelationIds = Partial<
  Record<SessionLifecycleCorrelationIdKey, string>
>

const CORRELATION_ID_KEY_SET: ReadonlySet<string> =
  new Set(SESSION_LIFECYCLE_CORRELATION_ID_KEYS)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POSITIVE_COUNTER_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/
const FILE_GENERATION_PATTERN = /^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/
const ROLLOUT_ENTRY_PATTERN = /^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/

/**
 * Validate each identity according to the producer that minted it.
 *
 * WHY a shared punctuation regex is not a privacy boundary: ordinary prompt
 * prose such as `my-secret-prompt-is-this` contains no spaces and therefore
 * looks just like a dashed identifier. The dedicated observation stream is
 * user-shareable, so an approved KEY must not turn arbitrary renderer text
 * into approved DATA. These shapes mirror the actual producers: UUIDs from
 * app submission/run creation, monotonic proxy counters, dev:ino rollout
 * generations, provider response ids, and domain-separated SHA-256
 * fingerprints of provider UUIDs.
 */
function isLifecycleCorrelationId(
  key: SessionLifecycleCorrelationIdKey,
  value: string,
): boolean {
  switch (key) {
    case 'sessionRunId':
      return UUID_PATTERN.test(value)
    case 'submissionId':
      return UUID_PATTERN.test(value) || /^sub(?:mission)?-[0-9]{1,12}$/.test(value)
    case 'proxyRequestId':
      return /^req-[0-9]{1,12}$/.test(value)
    case 'proxyFlowId':
      return /^proxy-[0-9]{1,12}$/.test(value)
    case 'semanticTurnId':
      return UUID_PATTERN.test(value) ||
        /^rollout-[0-9]{10,16}$/.test(value) ||
        /^resp-[0-9]{1,12}$/.test(value) ||
        /^(?:resp|msg)_[0-9a-f]{32,96}$/i.test(value)
    case 'rolloutEntryId':
      return ROLLOUT_ENTRY_PATTERN.test(value)
    case 'fileGenerationId':
      return FILE_GENERATION_PATTERN.test(value)
    case 'renderCandidateId':
      return (value.startsWith('queued:') && UUID_PATTERN.test(value.slice(7))) ||
        (value.startsWith('optimistic-submission:') && UUID_PATTERN.test(value.slice(22)))
    case 'candidateFingerprint':
      return /^[0-9a-f]{64}$/i.test(value)
    case 'providerWindowFingerprint':
    case 'providerSessionMetaFingerprint':
      return /^[0-9a-f]{64}$/i.test(value)
    case 'providerWindowGenerationId':
      return POSITIVE_COUNTER_PATTERN.test(value)
  }
}

/**
 * Keep only closed, bounded, opaque correlation identifiers.
 *
 * Applied at both renderer and main boundaries for the same reason as
 * `pickLifecycleData`: renderer filtering catches mistakes close to the emit
 * point, while main remains the authority at an IPC trust boundary. Values are
 * rejected rather than trimmed or truncated because changing an identifier can
 * merge two genuinely different observations into one false relation.
 */
export function pickLifecycleCorrelationIds(
  ids: unknown,
): SessionLifecycleCorrelationIds | undefined {
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(ids as Record<string, unknown>)) {
    if (!CORRELATION_ID_KEY_SET.has(key)) continue
    if (typeof value !== 'string' ||
      !isLifecycleCorrelationId(key as SessionLifecycleCorrelationIdKey, value)) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const CODEX_OBSERVATION_CORRELATION_KEYS: Readonly<
  Record<CodexTranscriptObservationEventName, readonly SessionLifecycleCorrelationIdKey[]>
> = {
  'submit.begin': ['submissionId'],
  'submit.result': ['submissionId'],
  'submit.unwound': ['submissionId'],
  'submit.write': ['submissionId'],
  'submit.surface': ['submissionId', 'renderCandidateId'],
  'submit.reconcile': [
    'submissionId',
    'renderCandidateId',
    'fileGenerationId',
    'rolloutEntryId',
  ],
  'submit.release': ['submissionId', 'renderCandidateId'],
  'provider.request': [
    'proxyRequestId',
    'proxyFlowId',
    'providerWindowFingerprint',
    'providerWindowGenerationId',
  ],
  'semantic.turn': ['proxyRequestId', 'proxyFlowId', 'semanticTurnId'],
  'transcript.attachment': ['candidateFingerprint', 'providerSessionMetaFingerprint'],
  'transcript.candidate': ['candidateFingerprint', 'providerSessionMetaFingerprint'],
  'transcript.entry': [
    'fileGenerationId',
    'rolloutEntryId',
    'providerSessionMetaFingerprint',
  ],
  'transcript.outbox-gap': [],
  'transcript.surface-gap': [],
  'transcript.observation-gap': [],
  'transcript.snapshot': [],
}

/**
 * Keep only relations the named producer could actually observe.
 *
 * WHY shape validation alone is insufficient: all of these IDs are opaque and
 * can therefore look individually valid while asserting a relation that never
 * existed—for example a renderer attaching a proxy request to submit.begin.
 * The event schema closes that second dimension. Composite checks then refuse
 * internally contradictory pairs rather than serializing two incompatible
 * coordinates into an apparently authoritative chronology.
 */
export function pickCodexTranscriptObservationCorrelationIds(
  name: CodexTranscriptObservationEventName,
  ids: unknown,
  data?: unknown,
): SessionLifecycleCorrelationIds | undefined {
  const shaped = pickLifecycleCorrelationIds(ids)
  if (!shaped) return undefined
  const allowed = new Set<SessionLifecycleCorrelationIdKey>([
    'sessionRunId',
    ...CODEX_OBSERVATION_CORRELATION_KEYS[name],
  ])
  const out: SessionLifecycleCorrelationIds = {}
  for (const [key, value] of Object.entries(shaped)) {
    if (allowed.has(key as SessionLifecycleCorrelationIdKey)) {
      out[key as SessionLifecycleCorrelationIdKey] = value
    }
  }

  const submissionId = out.submissionId
  const renderCandidateId = out.renderCandidateId
  if (renderCandidateId) {
    const candidateSubmissionId = renderCandidateId.startsWith('queued:')
      ? renderCandidateId.slice(7)
      : renderCandidateId.startsWith('optimistic-submission:')
        ? renderCandidateId.slice(22)
        : null
    if (!submissionId || candidateSubmissionId !== submissionId) {
      // The pair is the relation. Keeping either half after observing a
      // contradiction would make a corrupt row look merely incomplete.
      delete out.submissionId
      delete out.renderCandidateId
    }
  }

  const fileGenerationId = out.fileGenerationId
  const rolloutEntryId = out.rolloutEntryId
  if (fileGenerationId || rolloutEntryId) {
    const consistentPair = Boolean(
      fileGenerationId &&
      rolloutEntryId?.startsWith(`${fileGenerationId}:`),
    )
    const safeData = pickCodexTranscriptObservationData(name, data)
    const entryCoordinate = safeData?.entryByteOffset ?? safeData?.entryOrdinal
    const recordedOrdinal = rolloutEntryId
      ? Number(rolloutEntryId.slice(rolloutEntryId.lastIndexOf(':') + 1))
      : null
    const consistentOrdinal = typeof entryCoordinate !== 'number' ||
      recordedOrdinal === entryCoordinate
    if (!consistentPair || !consistentOrdinal) {
      delete out.fileGenerationId
      delete out.rolloutEntryId
    }
  }

  if (out.providerWindowGenerationId && !out.providerWindowFingerprint) {
    delete out.providerWindowGenerationId
  }

  return Object.keys(out).length > 0 ? out : undefined
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
  // Selecting an agent into a Grid Dispatch lane — the index click, a lane
  // strip, ⌥↑/↓, or ⌘N. Separate from `agent-index.navigate` because these are
  // the high-frequency in-layout gestures: a storm here means lane churn (a
  // held arrow key), not command-palette navigation.
  'dispatch-lane.select',
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
  'predecessorSessionId',
  // Free-form sub-classification for events whose variant is not an outcome.
  // Exists so `ok` is never overloaded to mean something other than success.
  'source',
  'surface',
  'queueReason',
  'phase',
  'matchedBy',
  'confidence',
  // Main compares renderer-retained sessionRunId against the live registry.
  // This is a relation verdict, not another identity; recording the current id
  // beside a stale id would create the very false join the verdict prevents.
  'runDisposition',

  // outcome
  'ok',
  'code',
  'reason',
  'stage',
  'status',
  'retryable',
  'cause',
  'decision',
  'changed',
  'selected',
  'matched',
  'visible',
  'attached',
  'tailing',
  'trackingCapped',
  'providerSessionMetaValid',

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
  'deliveryInFlight',
  'subagentHeaderPresent',

  // shape / volume
  'tabs',
  'leaves',
  'detached',
  'buried',
  'expectedCount',
  'resolvedCount',
  // Comma-joined session ids that were expected but never resolved. Ids are
  // already first-class in this stream (`ids.sessionId`), so this adds no new
  // category of data — it answers "which pane" for an event that previously
  // only said "one pane", which cost three weeks of a frozen workspace to
  // diagnose by hand. Joined into a string because payload values must stay
  // flat: the sanitizer only inspects top-level keys, so an array would sail
  // past the allowlist.
  'unresolvedSessionIds',
  'entryCount',
  'totalEntries',
  'queueCount',
  'candidateCount',
  'matchingCandidateCount',
  'entryOrdinal',
  'entryByteOffset',
  'bytes',
  'suppressed',
  'missedFeedRows',
  'missedObservationRows',
  'countCapped',

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
 * Re-validate the dedicated Codex observation projection by event shape.
 *
 * `pickLifecycleData` closes the KEY vocabulary for the broader lifecycle
 * journal, whose historical events intentionally carry some free-form reason
 * labels. That is not sufficient for a file promising content safety: a
 * hostile renderer could put prompt prose in an otherwise-approved `reason`
 * value. Transcript observations therefore close the string VALUES too. The
 * bundle exporter reuses this exact function, so the always-on writer and the
 * user-shareable projection cannot drift into separate privacy schemas.
 */
export function pickCodexTranscriptObservationData(
  name: CodexTranscriptObservationEventName,
  data: unknown,
): SessionLifecycleData | undefined {
  const input = pickLifecycleData(data)
  if (!input) return undefined
  const out: SessionLifecycleData = {}
  const string = (key: SessionLifecycleDataKey, allowed: readonly string[]): void => {
    const value = input[key]
    if (typeof value === 'string' && allowed.includes(value)) out[key] = value
  }
  const boolean = (key: SessionLifecycleDataKey): void => {
    const value = input[key]
    if (typeof value === 'boolean') out[key] = value
  }
  const count = (key: SessionLifecycleDataKey): void => {
    const value = input[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value
  }
  const duration = (key: SessionLifecycleDataKey): void => {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }

  const provider = (): void => string('provider', ['codex'])
  // Applied to every transcript observation before its event-specific fields.
  // A delayed old-run row remains useful in the app journal, but bundle readers
  // must be able to distinguish it from evidence about the replacement now
  // occupying the same stable pane id.
  string('runDisposition', [
    'current',
    'stale',
    'retired-or-unknown',
    'missing',
  ])
  const deliveryCode = (): void => string('code', [
    'delivery-in-flight',
    'missing-capability',
    'not-ready',
    'write-failed',
    'absorption-timeout',
    'acceptance-timeout',
    'session-exited',
    'transport-failed',
    'threw',
  ])
  const deliveryStage = (): void => string('stage', [
    'reservation',
    'before-write',
    'absorption',
    'after-enter',
    'session-exit',
  ])

  switch (name) {
    case 'submit.begin':
      provider()
      string('source', ['text-only', 'with-images'])
      break
    case 'submit.result':
      provider()
      boolean('ok')
      deliveryCode()
      deliveryStage()
      boolean('bodyWritten')
      boolean('enterWritten')
      boolean('retryable')
      duration('durationMs')
      break
    case 'submit.unwound':
      provider()
      deliveryCode()
      deliveryStage()
      string('source', ['delivery-result', 'no-successful-send'])
      break
    case 'submit.write':
      string('phase', ['body', 'enter', 'body-enter'])
      boolean('ok')
      boolean('deliveryInFlight')
      break
    case 'submit.surface':
      string('surface', [
        'optimistic-entry',
        'queued-strip',
        'duplicate-suppressed',
        'render-selected',
        'queue-strip',
      ])
      string('queueReason', ['live-current-turn', 'unowned-history'])
      boolean('changed')
      boolean('visible')
      count('entryOrdinal')
      break
    case 'submit.reconcile':
      string('matchedBy', ['exact-text', 'normalized-text'])
      count('entryByteOffset')
      break
    case 'submit.release':
      string('cause', [
        'before-write-failure',
        'write-status-uncertain',
        'process-idle',
        'semantic-idle',
        'idle-convergence',
        'bootstrap-complete',
        'session-exit',
        'committed-user-observed',
      ])
      break
    case 'provider.request':
      string('phase', [
        'created',
        'selected',
        'ignored',
        'completed',
        'failed',
        'incomplete',
        'cancelled',
        'unknown',
      ])
      string('source', ['proxy', 'unknown'])
      string('cause', [
        'request-created',
        'first-chunk',
        'active-at-request',
        'concurrent-active',
        'semantic-terminal',
        'transport-ended-before-semantic-terminal',
        'response-error',
        'upstream-error',
        'watchdog-timeout',
        'adapter-detached',
        'unknown',
      ])
      boolean('selected')
      boolean('subagentHeaderPresent')
      break
    case 'semantic.turn':
      string('phase', ['started'])
      string('source', ['proxy', 'rollout', 'screen', 'unknown'])
      break
    case 'transcript.attachment':
      string('decision', ['error', 'hold', 'ambiguous', 'accept', 'unknown'])
      string('reason', [
        'prompt-evidence-disabled',
        'jsonl-error',
        'awaiting-local-prompt',
        'awaiting-candidate-evidence',
        'ownership-contended',
        'path-leased',
        'unknown',
      ])
      string('code', ['unsupported-cli', 'unknown'])
      boolean('attached')
      boolean('tailing')
      count('candidateCount')
      count('matchingCandidateCount')
      count('suppressed')
      boolean('trackingCapped')
      break
    case 'transcript.candidate':
      string('phase', ['pre-lease'])
      boolean('matched')
      break
    case 'transcript.entry':
      string('source', ['session-meta'])
      count('entryByteOffset')
      boolean('attached')
      boolean('tailing')
      boolean('providerSessionMetaValid')
      break
    case 'transcript.outbox-gap':
      count('missedFeedRows')
      count('missedObservationRows')
      break
    case 'transcript.surface-gap':
      count('candidateCount')
      count('suppressed')
      break
    case 'transcript.observation-gap':
      string('phase', ['opened', 'closed'])
      count('suppressed')
      boolean('countCapped')
      string('runDisposition', [
        'current',
        'stale',
        'missing',
        'retired-or-unknown',
      ])
      break
    case 'transcript.snapshot':
      count('entryCount')
      count('totalEntries')
      count('queueCount')
      string('status', ['idle', 'loading', 'ready', 'error', 'disconnected'])
      break
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
  'transcript.outbox-gap': 'warn',
  'transcript.surface-gap': 'warn',
  'transcript.observation-gap': 'warn',
  // Not a session failure, but a gap in the recording — which for a stream
  // whose entire purpose is reconstructing what happened is worth surfacing at
  // the same level as one.
  'report.suppressed': 'warn',
}

export function severityForLifecycleEvent(name: SessionLifecycleEventName): 'info' | 'warn' {
  return SEVERITY_BY_NAME[name] ?? 'info'
}
