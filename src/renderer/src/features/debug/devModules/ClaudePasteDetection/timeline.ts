// Pure reducer: a recorded paste-debug session → one digested submit lifecycle.
//
// This is the brain of the ClaudePasteDetection dev module (#90). It is kept
// free of React and IPC so the digest logic is trivially correct and can change
// without an IPC version bump (the wire carries raw events; the meaning lives
// here).
//
// Event vocabulary is the REAL one emitted by the submit path — confirmed
// against claudePaste.ts / useComposerKeybinds.ts, not the issue sketch:
//   RENDER  keydown:enter              data.composerLen — the "issued" instant
//   SCREEN  placeholder:appeared       data.waitedMs    — the "detected" instant
//   SCREEN  placeholder:timeout        — poller gave up: the STUCK signal
//   SCREEN  placeholder:no-session     — no backend: also stuck
//   IPC     write:submit-cr            data.strategy ('event-driven' | …)
//   IPC     write:paste-and-submit-single             — plain-text path (no placeholder)
//   OUTCOME submit:returned            — submit fn returned normally
//   ERROR   submit:throw               data.message    — submit fn threw

import type { PasteDebugEvent, PasteDebugSession } from '@preload/api/types'

export type SubmitOutcome = 'submitted' | 'stuck' | 'error' | 'pending' | 'unknown'

export type SubmitLifecycle = {
  pasteId: string
  startedAt: number
  /** ms from keydown:enter to placeholder:appeared — the #90 headline metric.
   *  null for the plain-text path (no placeholder is expected there). */
  issuedToDetectedMs: number | null
  /** The poller's own measure (placeholder:appeared.data.waitedMs) as a
   *  cross-check against the ts delta above. */
  waitedMs: number | null
  /** ms from placeholder:appeared to the submit \r write. */
  detectedToSubmitMs: number | null
  outcome: SubmitOutcome
  composerLen: number | null
  strategy: string | null
  /** Which absorption signal fired: 'placeholder' (collapsed paste) or
   *  'inline' (medium paste, the #279 case) — null if it timed out. */
  via: string | null
}

function find(events: PasteDebugEvent[], layer: string, event: string): PasteDebugEvent | undefined {
  return events.find(e => e.layer === layer && e.event === event)
}

function num(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key]
  return typeof v === 'number' ? v : null
}

export function buildLifecycle(session: PasteDebugSession): SubmitLifecycle {
  const ev = session.events

  const enter = find(ev, 'RENDER', 'keydown:enter')
  // Content-match events (#279 fix) with back-compat to the older
  // placeholder-only event names so historical journals still read.
  const appeared =
    find(ev, 'PTY', 'delivery:paste-absorbed') ??
    find(ev, 'PTY', 'delivery:images-absorbed') ??
    find(ev, 'SCREEN', 'paste:absorbed') ?? find(ev, 'SCREEN', 'placeholder:appeared')
  const timedOut =
    find(ev, 'SCREEN', 'paste:absorb-timeout') ??
    find(ev, 'SCREEN', 'placeholder:timeout') ??
    find(ev, 'SCREEN', 'placeholder:no-session')
  const submitCr = find(ev, 'IPC', 'write:submit-cr')
  const singleWrite = find(ev, 'IPC', 'write:paste-and-submit-single')
  const accepted =
    find(ev, 'PTY', 'delivery:acceptance-user') ??
    find(ev, 'PTY', 'delivery:acceptance-queue')
  const mainEnter = find(ev, 'PTY', 'delivery:enter-written')
  const uncertain = find(ev, 'PTY', 'delivery:uncertain')
  const threw = ev.find(e => e.layer === 'ERROR')

  // Durable acceptance outranks renderer bookkeeping: a late UI error cannot
  // undo a user/queue entry Claude already committed. Conversely, historical
  // CR/single-write events prove only that bytes were attempted, not that the
  // TUI consumed Enter; retaining them as "submitted" would preserve the exact
  // false-success diagnosis this state machine was added to eliminate.
  const outcome: SubmitOutcome = accepted
    ? 'submitted'
    : threw
      ? 'error'
      : uncertain
        ? 'error'
        : timedOut
          ? 'pending'
          : enter || mainEnter || submitCr || singleWrite
          ? 'pending'
          : 'unknown'

  const strategy =
    (typeof submitCr?.data?.strategy === 'string' ? submitCr.data.strategy : null) ??
    (singleWrite ? 'single' : null)

  return {
    pasteId: session.pasteId,
    startedAt: session.startedAt,
    issuedToDetectedMs: enter && appeared ? appeared.ts - enter.ts : null,
    waitedMs: num(appeared?.data, 'waitedMs'),
    detectedToSubmitMs: appeared && (submitCr ?? mainEnter)
      ? (submitCr ?? mainEnter)!.ts - appeared.ts
      : null,
    outcome,
    composerLen: num(enter?.data, 'composerLen'),
    strategy,
    via: typeof appeared?.data?.via === 'string' ? appeared.data.via : null,
  }
}

export type TimelineStats = {
  count: number
  /** outcome stuck or error — the failures #90 is about. */
  failed: number
  p50Ms: number | null
  p95Ms: number | null
}

export function buildStats(rows: SubmitLifecycle[]): TimelineStats {
  const lat = rows
    .map(r => r.issuedToDetectedMs)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b)
  const pct = (p: number): number | null =>
    lat.length === 0
      ? null
      : lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]
  return {
    count: rows.length,
    failed: rows.filter(r => r.outcome === 'stuck' || r.outcome === 'error').length,
    p50Ms: pct(50),
    p95Ms: pct(95),
  }
}
