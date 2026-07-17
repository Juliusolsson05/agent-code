import { SENSITIVE_KEY } from '@renderer/rendering/model/sensitiveKey'

// ---------------------------------------------------------------------------
// Session-recording redaction (plan §5) — the one genuinely novel piece of
// the recording feature.
//
// A local recording (session-recordings/<id>/events.jsonl) captures the full
// rendering input STREAM verbatim: tool arguments, tool results, file
// contents, user prompts — far more sensitive than anything else the codebase
// records (the unknown registry keeps only shape-paths; the bundle corpus caps
// snippets at 360 chars). Before a recording can become a CHECKED-IN fixture
// (testing/fixtures/rendering-recordings/) it must be scrubbed. This module is
// that scrub, and it is deliberately PURE and importable so the extraction
// script, the replay tests, and the hard-gate all share one implementation —
// a second copy of the SENSITIVE_KEY regex or the caps could let the gate pass
// something a test would consider a leak.
//
// TWO MODES, matching the two-tier trust model:
//
//   'full-text-capped' — keep the real text but bound it. Every string is
//     truncated to the bundle corpus's own tiers (360/600/8000, reused so
//     recordings and bundles share size discipline) and any value whose KEY
//     matches SENSITIVE_KEY is dropped. This preserves prose for a human
//     reading the fixture, at the cost of still carrying (capped) content.
//
//   'structure-only' — THE innovation. Drop every free-text body and keep only
//     the identity/structure fields the pipeline actually keys on: message
//     ids, tool_use ids, timestamps, turn ids, block kinds, `status`, uuids,
//     roles, counts. The ownership/ordering rules decide everything on
//     IDENTITY and STRUCTURE, never on prose (committed.ts keys on uuid +
//     tool ids + message.id; semantic.ts keys on turnId + blockIndex +
//     toolUseId; ghost rules key on timestamps). So a structure-only recording
//     still exercises every ownership/ordering rule while carrying ~no
//     sensitive text — free strings become a length-preserving placeholder,
//     so the SHAPE (and how long each body was) survives for debugging while
//     the content does not.
//
// Both modes strip SENSITIVE_KEY-matched values unconditionally. The hard gate
// (`findSensitiveSurvivors`) is a belt on top: the extraction script refuses to
// emit a fixture that still contains a SENSITIVE_KEY value, exactly the way the
// bundle corpus refuses un-triaged fixtures.
// ---------------------------------------------------------------------------

// Corpus size tiers, reused verbatim from scripts/extract-rendering-fixtures.mjs
// so a recording fixture is never bulkier than a bundle fixture at the same
// altitude. Screen viewport text is the noisiest and least load-bearing (the
// ledger never reads it) so it caps at the smallest tier; tool_result-shaped
// bodies at the middle tier; everything else (prompts, tool args, assistant
// text) at the large tier.
const SCREEN_CAP = 360
const TOOL_RESULT_CAP = 600
const TEXT_CAP = 8000

// The placeholder a structure-only redaction leaves where a free-text string
// was. It stays a STRING (shape preserved — a consumer expecting `block.text`
// to be a string still gets one) and encodes the original length, because the
// plan asks structure-only to keep "shapes + lengths". `⟨…⟩` guillemets make a
// redacted value obvious on sight in a fixture diff.
const REDACTED_VALUE = '⟨redacted⟩'
function redactedText(len: number): string {
  return `⟨text:${len}⟩`
}

// String keys that carry IDENTITY or STRUCTURE, not prose — kept as-is even in
// structure-only. This is the allowlist the whole "structure-only still
// exercises ownership" claim rests on: every field below is read by a
// collector or a ledger rule to DECIDE ownership/ordering. Add to it only when
// a real pipeline rule reads a new string field; never add a prose field.
//
// Sources: committed.ts (uuid/parentUuid/type/role/timestamp/message.id/
// permissionMode/tool ids), semantic.ts (turnId/kind/toolName/toolUseId/callId/
// itemId/source/status), collectLedgerInput.ts (provider/streamPhase),
// SessionRecorderManager header (sessionId/providerSessionId/recordingId/
// provider), sub-agent state (agentId/agentType/status).
const STRUCTURAL_STRING_KEYS: ReadonlySet<string> = new Set([
  // identity
  'uuid',
  'parentUuid',
  'id',
  'tool_use_id',
  'toolUseId',
  'callId',
  'itemId',
  'turnId',
  'message_id',
  'requestId',
  'sessionId',
  'providerSessionId',
  'recordingId',
  'agentId',
  // kinds / discriminators
  'type',
  'role',
  'kind',
  'subtype',
  'status',
  'source',
  'sourcePlane',
  'contentKind',
  'disposition',
  'stop_reason',
  'stopReason',
  'agentType',
  // tool identity — the tool NAME (Bash/Read/Grep) is a discriminator the
  // semantic collector reads (`toolName`) and is never prose or a secret; the
  // sensitive part of a tool call is its `input`/args, which is NOT here.
  'name',
  'toolName',
  // provider / lifecycle
  'provider',
  'sessionKind',
  'model',
  'streamPhase',
  'permissionMode',
  'file',
  // ordering — timestamp can arrive as an ISO STRING; ownership reads it, so
  // it is structural even though it looks like free text.
  'timestamp',
])

// Per-key caps for 'full-text-capped'. A key absent here caps at TEXT_CAP.
const CAP_BY_KEY: ReadonlyMap<string, number> = new Map([
  ['plain', SCREEN_CAP],
  ['markdown', SCREEN_CAP],
  ['recent', SCREEN_CAP],
  ['recentMarkdown', SCREEN_CAP],
  ['content', TOOL_RESULT_CAP],
  ['resultContent', TOOL_RESULT_CAP],
  ['stdout', TOOL_RESULT_CAP],
  ['stderr', TOOL_RESULT_CAP],
])

export type RedactionMode = 'full-text-capped' | 'structure-only'

// One recorded line. Mirrors SessionRecorder.record / .note output: real
// channel events carry `payload`; synthetic `__note` lines carry `note`;
// `__truncated` lines carry reason/bytes. Extra fields tolerated (unknown
// future markers pass through untouched).
export type RecordingEvent = {
  t: number
  wall: number
  ch: string
  payload?: unknown
  note?: { id: string; status: 'reserved' | 'filled'; text?: string }
  reason?: string
  bytes?: number
}

export type Recording = {
  meta: Record<string, unknown>
  events: RecordingEvent[]
}

// Channels the LEDGER-level replay provably ignores, dropped by structure-only
// minimization. `session:screen` is pure terminal viewport text — it feeds the
// screen-fallback extractor in the full fold, never the ledger, and it is the
// single largest text source in a recording. The full-text-capped (faithful)
// mode keeps it so a full-fold replay can still use it. See plan §5.
const STRUCTURE_ONLY_DROP_CHANNELS: ReadonlySet<string> = new Set(['session:screen'])

function capString(s: string, key: string | undefined): string {
  const cap = (key !== undefined ? CAP_BY_KEY.get(key) : undefined) ?? TEXT_CAP
  return s.length > cap ? `${s.slice(0, cap)}…[truncated ${s.length}]` : s
}

/**
 * Recursively redact one value. `key` is the object key this value sat under
 * (drives both the SENSITIVE_KEY value-strip and the structural/prose
 * decision); it is undefined at the root and passed through for array elements
 * (so `content: ["long string"]` caps like a `content` field).
 */
function redactValue(value: unknown, key: string | undefined, mode: RedactionMode): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    // A string sitting directly under a secret-looking key is a secret VALUE —
    // strip it in both modes regardless of the mode's text policy.
    if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED_VALUE
    if (mode === 'structure-only') {
      if (key !== undefined && STRUCTURAL_STRING_KEYS.has(key)) return value
      return redactedText(value.length)
    }
    return capString(value, key)
  }

  // numbers / booleans are always structural (timestamps, counts, indices,
  // flags) — never prose, never a secret on their own.
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    // Array elements inherit the parent key so a homogeneous string array caps/
    // redacts consistently; object elements ignore it and use their own keys.
    return value.map(v => redactValue(v, key, mode))
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Value-level strip for a secret key holding a NON-string (nested object,
    // array of tokens): drop the whole subtree, do not recurse into it.
    if (SENSITIVE_KEY.test(k)) {
      out[k] = REDACTED_VALUE
      continue
    }
    out[k] = redactValue(v, k, mode)
  }
  return out
}

/**
 * Redact a whole recording. Envelope fields (`t`/`wall`/`ch`) and synthetic
 * markers (`__note` text, `__truncated` reason) pass through untouched — the
 * note text is the human bug description that becomes the fixture's
 * description and is author-typed, not captured content. Only `payload` (the
 * verbatim channel body — the sensitive part) is scrubbed. Returns a NEW
 * recording; the input is not mutated (pure).
 */
export function redactRecording(recording: Recording, mode: RedactionMode): Recording {
  const events: RecordingEvent[] = []
  for (const ev of recording.events) {
    // structure-only drops provably-ignored channels wholesale (still records
    // that they existed is unnecessary — the ledger never keyed on them).
    if (mode === 'structure-only' && STRUCTURE_ONLY_DROP_CHANNELS.has(ev.ch)) continue
    if (ev.payload === undefined) {
      // __note / __truncated / any marker line: keep verbatim.
      events.push({ ...ev })
      continue
    }
    events.push({ ...ev, payload: redactValue(ev.payload, undefined, mode) })
  }
  // The header is a small identity record (recordingId/sessionId/provider/
  // cwd/appVersion), not captured content, so it is NOT run through the prose
  // redactor — that would placeholder cwd and lose readability for no safety
  // gain. But it still gets the SENSITIVE_KEY value-strip: a header should
  // never carry a secret, and the hard gate scans meta too, so scrubbing here
  // keeps `findSensitiveSurvivors` empty even if a future header field lands a
  // token.
  const meta: Record<string, unknown> = { redaction: mode }
  for (const [k, v] of Object.entries(recording.meta)) {
    meta[k] = SENSITIVE_KEY.test(k) ? REDACTED_VALUE : v
  }
  return { meta, events }
}

/**
 * HARD GATE. Walk a (redacted) recording and return the paths where a value
 * whose KEY matches SENSITIVE_KEY survived un-redacted. Empty ⇒ safe to check
 * in. `redactRecording` should always leave this empty; the gate exists so a
 * bug in redaction (or a future channel the walker missed) cannot silently
 * ship a secret. The extraction core refuses to emit when this is non-empty.
 */
export function findSensitiveSurvivors(node: unknown, path = ''): string[] {
  if (node === null || typeof node !== 'object') return []
  const out: string[] = []
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...findSensitiveSurvivors(v, `${path}[${i}]`)))
    return out
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k
    if (SENSITIVE_KEY.test(k) && v !== REDACTED_VALUE && v != null && v !== '') {
      out.push(here)
    }
    out.push(...findSensitiveSurvivors(v, here))
  }
  return out
}

// A reserved `__note` line pins the tick the user reacted to; the paired
// `filled` line carries the description. This is how a recording says "the
// interesting region is HERE" (plan §7b).
function reservedNoteIndices(events: readonly RecordingEvent[]): number[] {
  const out: number[] = []
  events.forEach((ev, i) => {
    if (ev.ch === '__note' && ev.note?.status === 'reserved') out.push(i)
  })
  return out
}

function noteDescription(events: readonly RecordingEvent[], noteId: string): string | null {
  for (const ev of events) {
    if (ev.ch === '__note' && ev.note?.id === noteId && ev.note.status === 'filled' && ev.note.text) {
      return ev.note.text
    }
  }
  return null
}

export type RecordingFixture = {
  meta: {
    recordingId: string | null
    sessionId: string | null
    provider: string | null
    // From the paired __note fill text when this fixture windows a note, else
    // a caller-supplied label. Seeds the golden-corpus test's `it(...)` name,
    // exactly like a bundle's note.json seeds the corpus verdict.
    note: string | null
    redaction: RedactionMode
    eventCount: number
    // The reserved note this window centers on (null for a whole-session
    // extraction), for traceability back into the source recording.
    windowNoteId: string | null
  }
  events: RecordingEvent[]
  // Populated by the recordingCorpus test's BLESS pass (the pipeline output is
  // the golden — there is no external ground truth to extract, unlike the
  // bundle corpus). Emitted empty; a human blesses to fill it.
  expected: { units: unknown[] }
  // Tolerated divergences, normally empty for a self-golden (see
  // recordingCorpus.test.ts). Kept for schema symmetry with the bundle corpus.
  triage: unknown[]
}

export type ExtractOptions = {
  mode: RedactionMode
  /** Window radius in EVENTS (ticks) around a reserved note. When set and the
   *  recording has notes, one fixture is produced per note, each carrying only
   *  the events within ±radius of the reserved marker. Omit to extract the
   *  whole recording as a single fixture. */
  windowRadius?: number
  /** Description for a whole-session (no-note) extraction. */
  description?: string
}

/**
 * THE extraction core, kept pure so scripts/extract-rendering-recordings.mjs is
 * a thin file-IO wrapper over it (tested directly by redact.test.ts — there
 * are no real recordings to run the CLI against yet). Redacts, optionally
 * windows around `__note` markers, and hard-gates. Throws if a SENSITIVE_KEY
 * value survives redaction (never emit a leaky fixture).
 *
 * Returns one fixture per reserved note when windowing, else a single
 * whole-session fixture.
 */
export function extractRecordingFixture(recording: Recording, opts: ExtractOptions): RecordingFixture[] {
  const redacted = redactRecording(recording, opts.mode)

  const survivors = findSensitiveSurvivors(redacted)
  if (survivors.length > 0) {
    throw new Error(
      `refusing to emit recording fixture: ${survivors.length} SENSITIVE_KEY value(s) survived redaction ` +
        `(${survivors.slice(0, 5).join(', ')}${survivors.length > 5 ? ', …' : ''})`,
    )
  }

  const meta = redacted.meta as Record<string, unknown>
  const base = {
    recordingId: (meta.recordingId as string) ?? null,
    sessionId: (meta.sessionId as string) ?? null,
    provider: (meta.provider as string) ?? null,
    redaction: opts.mode,
  }

  const noteIdxs = reservedNoteIndices(redacted.events)
  const shouldWindow = opts.windowRadius !== undefined && noteIdxs.length > 0
  if (!shouldWindow) {
    return [
      {
        meta: {
          ...base,
          note: opts.description ?? noteDescriptionFromFirst(redacted.events),
          eventCount: redacted.events.length,
          windowNoteId: null,
        },
        events: redacted.events,
        expected: { units: [] },
        triage: [],
      },
    ]
  }

  const radius = opts.windowRadius as number
  return noteIdxs.map(centerIdx => {
    const from = Math.max(0, centerIdx - radius)
    const to = Math.min(redacted.events.length, centerIdx + radius + 1)
    const windowEvents = redacted.events.slice(from, to)
    const noteId = redacted.events[centerIdx]?.note?.id ?? null
    return {
      meta: {
        ...base,
        note: noteId ? noteDescription(redacted.events, noteId) : null,
        eventCount: windowEvents.length,
        windowNoteId: noteId,
      },
      events: windowEvents,
      expected: { units: [] },
      triage: [],
    }
  })
}

/** Description for a whole-session fixture with no explicit label: the first
 *  filled note's text, if any. */
function noteDescriptionFromFirst(events: readonly RecordingEvent[]): string | null {
  for (const ev of events) {
    if (ev.ch === '__note' && ev.note?.status === 'filled' && ev.note.text) return ev.note.text
  }
  return null
}
