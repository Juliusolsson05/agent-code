// ClaudePasteDetection — dev-debug module for issue #90 (prompt submit
// unreliable, detection falls behind under load). Built on the #101 Dev Debug
// Panel framework; renderer-only except for the read-back IPC added to
// dev-debug. Two panes:
//
//   1. LIVE DETECTION — runs the *actual* submit-detection rules against the
//      live screen snapshot so you can watch detection fire in real time, with
//      the current streamPhase. (Same idea as HeadlessSnapshotProbe.)
//   2. SUBMIT TIMELINE — reads back the per-paste journals already written to
//      disk and reconstructs issued→detected latency + outcome per submit, with
//      p50/p95 + failure count. This is #90's "see the actual latency
//      distribution" ask, surfaced from data we already capture but never read.
//
// Instrumentation only: this module changes nothing in the submit path.

import { useEffect, useMemo, useState } from 'react'

import type { DevDebugModule, DevDebugModuleProps } from '@renderer/features/debug/devModules/types'
import type { PasteDebugSession } from '@preload/api/types'

import { buildLifecycle, buildStats } from './timeline'

// The real submit-detection rules, mirrored from claude-code-headless so we can
// watch them fire against the same screen text the parser sees:
//   * placeholder — ClaudeCodeHeadless.awaitPastePlaceholder polls /\[Pasted text #\d+/ at 10ms
//   * spinner     — ScreenParser.detectActivity spinner glyph + verb…
const DETECT_RULES: { label: string; pattern: string; flags: string }[] = [
  { label: 'pasted-placeholder', pattern: '\\[Pasted text #\\d+', flags: 'i' },
  { label: 'spinner-activity', pattern: '^\\s*[^\\w\\s⏺]\\s+(\\S+)…', flags: 'm' },
]

export const claudePasteDetectionModule: DevDebugModule = {
  id: 'claude-paste-detection',
  title: 'Claude Paste / Submit Detection',
  description: 'Live submit-detection regexes + issued→detected latency timeline (#90).',
  Component: ClaudePasteDetection,
}

function matches(value: string, pattern: string, flags: string): boolean {
  try {
    return new RegExp(pattern, flags).test(value)
  } catch {
    return false
  }
}

function ClaudePasteDetection({ sessionId, runtime, kind }: DevDebugModuleProps) {
  const plain = runtime.screen ?? ''
  const markdown = runtime.screenMarkdown ?? ''
  const [sessions, setSessions] = useState<PasteDebugSession[]>([])

  // Poll the read-back IPC. 1s is plenty: the journal flushes every 100ms and
  // we are surfacing recent history, not racing the live submit. The interval
  // only runs while the module is mounted (i.e. enabled), so there is zero cost
  // when the module is off — the ship-safety contract of the dev panel.
  useEffect(() => {
    let alive = true
    const tick = () => {
      void window.api
        .readPasteEvents(20)
        .then(s => {
          if (alive) setSessions(s)
        })
        .catch(() => {
          /* dev-only: ignore transient IPC failures */
        })
    }
    tick()
    const handle = window.setInterval(tick, 1000)
    return () => {
      alive = false
      window.clearInterval(handle)
    }
  }, [])

  const rows = useMemo(() => sessions.map(buildLifecycle), [sessions])
  const stats = useMemo(() => buildStats(rows), [rows])

  return (
    <div className="border border-border bg-[#101010]">
      <div className="border-b border-border px-3 py-2 flex items-center justify-between gap-3">
        <div className="text-[10px] text-red-300 uppercase tracking-[0.12em]">
          claude paste / submit detection
        </div>
        <div className="text-[10px] text-muted truncate">
          {kind} · {sessionId} · phase{' '}
          <span className="text-ink-dim">{String(runtime.streamPhase)}</span>
        </div>
      </div>

      <div className="p-3 flex flex-col gap-3">
        {/* Pane 0 — live screen copy. Reads runtime.screen every render, so it
            stays in lock-step with the headless TUI: paste, and you watch the
            composer fill (placeholder or inlined text) right here. This is the
            exact snapshot the content-match submit detector keys on. */}
        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[9px] text-muted uppercase tracking-[0.12em]">
              screen copy (live)
            </span>
            <span className="text-[10px] text-muted tabular-nums">
              {plain.length} chars · {(plain.match(/\[Pasted text #\d+/g) ?? []).length} placeholders
            </span>
          </div>
          <pre className="max-h-[140px] overflow-auto whitespace-pre-wrap break-words border border-[#222] bg-[#0b0b0b] px-2 py-1 text-[10px] leading-[1.45] text-ink-dim">
            {plain.slice(-600) || '(screen empty)'}
          </pre>
        </section>

        {/* Pane 1 — live detection */}
        <section>
          <div className="mb-1 text-[9px] text-muted uppercase tracking-[0.12em]">live detection</div>
          <div className="grid grid-cols-2 gap-2">
            {DETECT_RULES.map(rule => {
              const plainHit = matches(plain, rule.pattern, rule.flags)
              const mdHit = matches(markdown, rule.pattern, rule.flags)
              return (
                <div key={rule.label} className="border border-border bg-canvas px-2 py-1">
                  <div className="text-[9px] text-muted uppercase tracking-[0.12em] truncate">
                    {rule.label}
                  </div>
                  <div className="mt-1 flex gap-3 text-[10px]">
                    <span className={plainHit ? 'text-green-400' : 'text-red-400'}>
                      plain {plainHit ? '● match' : '○'}
                    </span>
                    <span className={mdHit ? 'text-green-400' : 'text-red-400'}>
                      md {mdHit ? '● match' : '○'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Pane 2 — submit timeline */}
        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[9px] text-muted uppercase tracking-[0.12em]">submit timeline</span>
            <span className="text-[10px] text-muted tabular-nums">
              {stats.count} submits · p50 {stats.p50Ms ?? '—'}ms · p95 {stats.p95Ms ?? '—'}ms ·{' '}
              <span className={stats.failed > 0 ? 'text-red-400' : 'text-muted'}>
                {stats.failed} failed
              </span>
            </span>
          </div>
          <div className="overflow-auto max-h-[260px] border border-[#222] bg-[#0b0b0b]">
            <table className="w-full text-[10px] tabular-nums">
              <thead className="text-muted">
                <tr className="border-b border-[#222]">
                  <th className="text-left px-2 py-1 font-normal">pasteId</th>
                  <th className="text-right px-2 py-1 font-normal">issued→det</th>
                  <th className="text-right px-2 py-1 font-normal">det→cr</th>
                  <th className="text-left px-2 py-1 font-normal">outcome</th>
                  <th className="text-left px-2 py-1 font-normal">via</th>
                  <th className="text-right px-2 py-1 font-normal">len</th>
                  <th className="text-left px-2 py-1 font-normal">strategy</th>
                </tr>
              </thead>
              <tbody className="text-ink-dim">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-2 py-3 text-center text-muted">
                      no submits recorded yet
                    </td>
                  </tr>
                ) : (
                  rows.map(row => (
                    <tr key={row.pasteId} className="border-b border-[#1a1a1a]">
                      <td className="px-2 py-0.5">{row.pasteId.slice(0, 6)}</td>
                      <td className="px-2 py-0.5 text-right">{row.issuedToDetectedMs ?? '—'}</td>
                      <td className="px-2 py-0.5 text-right">{row.detectedToSubmitMs ?? '—'}</td>
                      <td
                        className={`px-2 py-0.5 ${
                          row.outcome === 'stuck' || row.outcome === 'error'
                            ? 'text-red-400'
                            : row.outcome === 'submitted'
                              ? 'text-green-400'
                              : 'text-muted'
                        }`}
                      >
                        {row.outcome}
                      </td>
                      <td
                        className={`px-2 py-0.5 ${
                          row.via === 'inline'
                            ? 'text-amber-400'
                            : row.via === 'placeholder'
                              ? 'text-green-400'
                              : 'text-muted'
                        }`}
                      >
                        {row.via ?? '—'}
                      </td>
                      <td className="px-2 py-0.5 text-right">{row.composerLen ?? '—'}</td>
                      <td className="px-2 py-0.5 truncate">{row.strategy ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
