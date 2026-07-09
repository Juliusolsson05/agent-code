import type { AgentProviderKind } from '@shared/types/providerKind'
import { isAgentProviderKind } from '@shared/types/providerKind'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import type { RenderLedger, OwnershipDecision } from '@renderer/rendering/model/types'
import {
  ledgerFeedContextFromRuntime,
  ledgerToFeedItems,
} from '@renderer/rendering/view/ledgerFeedItems'
import {
  applyFeedEvent,
  createReplayFoldState,
  slicesFromState,
  type FeedChannel,
} from '@renderer/rendering/replay/reconstructSlices'

// ---------------------------------------------------------------------------
// Slice 4 — the replay harness. Reads a Session Recording (meta.json +
// events.jsonl, produced by src/main/recording/SessionRecorder.ts) and replays
// its event stream tick-by-tick through the REAL rendering pipeline:
//
//   recorded 9-channel events
//        │  applyFeedEvent (reconstructSlices.ts — reuses the real reducers)
//        ▼
//   RuntimeLedgerSlices   (one per tick, field refs held stable across no-ops)
//        │  createLedgerInputAdapter()   ← constructed ONCE, holds D11 caches
//        ▼
//   LedgerInputBundle.input
//        │  createSessionLedger()        ← constructed ONCE, holds last-call cache
//        ▼
//   RenderLedger { rows, decisions }
//        │  ledgerToFeedItems(...)       ← the view bridge (exercises #239 drops)
//        ▼
//   FeedRenderItem[]
//
// The adapter and ledger are built ONCE and fed each tick (rec-research-seam.md
// §(c)): that is what makes the D11 identity caches real. Building them per tick
// would reset the caches and falsify every reference-stability assertion.
//
// This module is PURE and importable from tests — it never touches window.api,
// fs (except the explicit dir-reader below), timers, or React. See
// reconstructSlices.ts for the honest fidelity statement (reducer-faithful,
// orchestration-mirrored; NOT the React fold).
// ---------------------------------------------------------------------------

/** meta.json, the recording's header. Declared structurally here rather than
 *  imported from `@main/recording/SessionRecorder` so the replay harness (a
 *  renderer/test artifact) carries no dependency on main-process/Electron code.
 *  Fields mirror `RecordingMeta`. */
export type RecordingHeader = {
  v: number
  recordingId: string
  sessionId: string
  provider: string
  providerSessionId: string | null
  cwd: string | null
  appVersion: string | null
  startedAtWall: number
  endedAtWall?: number
  eventCount?: number
  droppedCount?: number
  capped?: boolean
}

/** One line of events.jsonl. `t` monotonic-ms (replay order), `wall` = the
 *  Date.now() captured at record time. A real event carries `ch` (a
 *  SessionFeed channel) + `payload`; the synthetic `__note` / `__truncated`
 *  lines carry their own fields and are ignored for pipeline input. */
export type RecordedLine =
  | { t: number; wall: number; ch: FeedChannel; payload: unknown }
  | { t: number; wall: number; ch: '__note'; note: { id: string; status: 'reserved' | 'filled'; text?: string } }
  | { t: number; wall: number; ch: '__truncated'; reason: string; bytes: number }

export type ParsedRecording = {
  header: RecordingHeader
  lines: RecordedLine[]
}

/** One replayed tick — the input slices AND every pipeline output, so the
 *  invariant checker (invariants.ts) can assert over rows + decisions +
 *  reference identity without re-running the pipeline. */
export type ReplayTick = {
  /** Index in the replayed line sequence (synthetic lines are skipped, so this
   *  is the ordinal among PIPELINE ticks, not the raw file line number). */
  index: number
  /** The recorded line that produced this tick. */
  line: Extract<RecordedLine, { ch: FeedChannel }>
  /** The slices fed to the adapter this tick (field refs are the running-state
   *  references — reference equality across ticks is meaningful). */
  slices: RuntimeLedgerSlices
  /** The ledger object — reference identity is load-bearing (D11). */
  ledger: RenderLedger
  /** Convenience alias for `ledger.rows` (what paints). */
  rows: RenderLedger['rows']
  /** The view-bridge output — exercises the full stack through FeedRenderItem. */
  feedItems: FeedRenderItem[]
  /** Candidate ids the view bridge could not resolve (the #239 "present but
   *  invisible" class). Non-empty is itself a smell the invariants can flag. */
  dropped: string[]
  /** Rejections the ADAPTER made at collection time (hidden meta rows,
   *  compaction-synthesis kills, duplicate-turn drops) — the half of the
   *  ledger=paint=debug promise (plan D5) that never reaches ledger.decisions.
   *  Kept per tick (finding #27) so the vanish invariant can explain a row that
   *  was killed BEFORE it ever became a ledger candidate; without it such a row
   *  read as an unexplained disappearance. Source: bundle.collectorDecisions. */
  collectorDecisions: readonly OwnershipDecision[]
}

export type ReplayResult = {
  header: RecordingHeader
  ticks: ReplayTick[]
}

export type ReplayOptions = {
  /**
   * Clock-injection seam (plan §6 "inject wall as the fold clock"). Called with
   * the tick's recorded `wall` BEFORE the event is folded. The pure reducers
   * (foldSemanticEvent, reduceStreamPhase) read `Date.now()` directly for turn
   * `startedAt` / phase stamps; there is no injectable clock inside them and
   * the task forbids adding one to runtime code. So the seam lives OUTSIDE the
   * reducers: a test passes `wall => vi.setSystemTime(wall)` here to pin
   * `Date.now()` to the recorded wall clock, making those fold-clock reads
   * deterministic without touching a line of production code. Omit it and the
   * reducers use real wall-time — fine for row CONTENT (the ledger is pure over
   * entry.timestamp), only the receipt-time stamps drift.
   */
  onBeforeFold?: (wall: number) => void
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const REAL_CHANNELS = new Set<FeedChannel>([
  'session:started',
  'session:screen',
  'session:jsonl-entries',
  'session:jsonl-error',
  'session:semantic-event',
  'session:conditions',
  'session:process-state',
  'session:sub-agents',
  'session:exit',
])

function isSyntheticChannel(ch: string): boolean {
  return ch === '__note' || ch === '__truncated'
}

/**
 * Parse a recording from an in-memory header + events lines. Accepts the
 * events.jsonl body either as a raw newline-delimited string or as an array of
 * already-split lines / pre-parsed objects — so a test can hand-build a
 * recording without ever touching disk. Torn-tail tolerant: a trailing partial
 * line (crash mid-write) is skipped, matching the recorder's append-only,
 * flush-may-be-lost contract.
 */
export function parseRecording(input: {
  header: RecordingHeader
  events: string | Array<string | RecordedLine>
}): ParsedRecording {
  const rawLines: Array<string | RecordedLine> =
    typeof input.events === 'string'
      ? input.events.split('\n')
      : input.events

  const lines: RecordedLine[] = []
  for (const raw of rawLines) {
    if (typeof raw !== 'string') {
      lines.push(raw)
      continue
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Torn tail from a crash mid-append — the recorder's own reader tolerates
      // it, and so do we. A partial line is never in the middle of the stream.
      continue
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.ch !== 'string') continue
    if (!REAL_CHANNELS.has(obj.ch as FeedChannel) && !isSyntheticChannel(obj.ch)) {
      // An unknown channel is dropped defensively rather than fed to the
      // pipeline — the 9-channel allowlist is a hard contract on replay too.
      continue
    }
    lines.push(obj as unknown as RecordedLine)
  }

  return { header: input.header, lines }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** Thin SessionRuntime view for the view-stage context builder. The bridge
 *  (`ledgerFeedContextFromRuntime`) reads only these seven fields; casting a
 *  partial object is far cheaper — and clearer — than fabricating a full
 *  SessionRuntime. If the bridge ever grows a new read, tsc flags it here. */
function runtimeViewFor(
  state: ReturnType<typeof createReplayFoldState>,
): SessionRuntime {
  return {
    entries: state.entries,
    ghosts: state.ghosts,
    semantic: {
      currentTurn: state.semantic.currentTurn,
      history: state.semantic.history,
    },
    streamPhase: state.phase.streamPhase,
    streamPhasePendingToolName: state.phase.streamPhasePendingToolName,
    streamPhasePendingToolUseId: state.phase.streamPhasePendingToolUseId,
  } as unknown as SessionRuntime
}

/**
 * Replay a parsed recording through the real pipeline. Returns one tick per
 * PIPELINE-relevant event (synthetic `__note` / `__truncated` lines are
 * skipped). The adapter and ledger are constructed ONCE (D11) and driven each
 * tick.
 */
export function replayRecording(
  recording: ParsedRecording,
  options: ReplayOptions = {},
): ReplayResult {
  const provider: AgentProviderKind = isAgentProviderKind(recording.header.provider)
    ? recording.header.provider
    : 'claude'

  const state = createReplayFoldState(provider, recording.header.sessionId)
  // Constructed ONCE — the per-plane and last-call D11 caches must persist
  // across every tick for the reference-stability invariant to be real.
  const adapter = createLedgerInputAdapter()
  const ledger = createSessionLedger()

  const ticks: ReplayTick[] = []
  let index = 0

  for (const line of recording.lines) {
    if (isSyntheticChannel(line.ch)) continue // notes/tombstones are not input
    const eventLine = line as Extract<RecordedLine, { ch: FeedChannel }>

    options.onBeforeFold?.(eventLine.wall)

    applyFeedEvent(state, eventLine.ch, (eventLine as { payload: unknown }).payload)

    const slices = slicesFromState(state)
    const bundle = adapter(slices)
    const rl = ledger(bundle.input)
    const { items, dropped } = ledgerToFeedItems(
      rl,
      ledgerFeedContextFromRuntime(runtimeViewFor(state), provider),
    )

    ticks.push({
      index,
      line: eventLine,
      slices,
      ledger: rl,
      rows: rl.rows,
      feedItems: items,
      dropped,
      collectorDecisions: bundle.collectorDecisions,
    })
    index += 1
  }

  return { header: recording.header, ticks }
}

// ---------------------------------------------------------------------------
// Optional disk reader — a convenience for pointing the harness at a real
// captured recording folder. Kept out of the pure path above so the core
// harness has zero fs dependency; a test may import this to load a fixture.
// ---------------------------------------------------------------------------

/**
 * Load a recording folder (`<dir>/meta.json` + `<dir>/events.jsonl`) from disk
 * and parse it. Node-only (uses `node:fs`); the pure `parseRecording` /
 * `replayRecording` above never touch the filesystem.
 */
export async function parseRecordingDir(dir: string): Promise<ParsedRecording> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const header = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RecordingHeader
  const events = await readFile(join(dir, 'events.jsonl'), 'utf8')
  return parseRecording({ header, events })
}
