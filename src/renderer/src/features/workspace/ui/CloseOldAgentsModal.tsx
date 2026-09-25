import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { SegmentedControl } from '@renderer/components/ui/segmented-control'
import { Input } from '@renderer/components/ui/input'
import { Select } from '@renderer/components/ui/select'
import type { SessionKind } from '@shared/types/providerKind'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { closeGrantedSessions } from '@renderer/workspace/bulkClose'
import {
  describePartialClose,
  isSessionLiveForClose,
} from '@renderer/workspace/closeConfirmation'
import type { CloseTargetSnapshot } from '@renderer/workspace/closeConfirmation'
import { useGlobalToast } from '@renderer/ui/GlobalToastContext'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { relativeTime } from '@renderer/lib/relativeTime'
import { cwdBasename, providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import {
  buildProjectScopeRows,
  filterProjectScopeRows,
  rowsInSelectedProjects,
} from '@renderer/features/workspace/lib/projectScope'
import type { ProjectScopeRow } from '@renderer/features/workspace/lib/projectScope'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { terminalLastUsedUpperBound } from '@renderer/workspace/terminalLastUsed'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { Entry } from '@shared/types/transcript'
import { withVisibleControls } from '@shared/text/visibleControls'

type Props = {
  open: boolean
  workspace: Pick<Workspace, 'state' | 'runtimes' | 'closeSession'>
  onClose: () => void
}

type ThresholdUnit = 'minutes' | 'hours' | 'days'
type ScopeMode = 'all' | 'selected'

type AgentRow = {
  sessionId: SessionId
  tabId: string
  tabTitle: string
  title: string
  tabIndex: number
  kind: SessionKind
  cwd: string
  cwdBase: string
  isLive: boolean
  /** A terminal nobody is observing yet: counted as live, but the row must
   *  not claim it IS running (review of #1179). */
  livenessUnknown: boolean
  lastActiveAt: number | null
  ageMs: number | null
}

/**
 * A terminal nobody is observing yet counts as possibly running (review of
 * #1179).
 *
 * WHY: after a restart a parked tmux shell is not re-attached or
 * foreground-polled until something wakes it, so its runtime has no
 * foreground observation and `isSessionLiveForClose` reads it as idle — while
 * the shell may be running a dev server. Before #1178 such a shell had no age
 * at all and was never listed. Its durable record now gives it an age, so the
 * missing liveness has to be stated explicitly: unknown is treated as running,
 * which means "excluded unless Include running is ticked". The user can still
 * close it deliberately; the default never kills what it cannot see.
 */
function terminalLivenessUnknown(kind: SessionKind, runtime: Workspace['runtimes'][string] | undefined): boolean {
  return kind === 'terminal' && (runtime?.terminalForeground ?? null) === null && runtime?.exited == null
}

/** One preview row for a session filed under `tab` (null without metadata). */
function agentRowFor(
  state: Workspace['state'],
  runtimes: Workspace['runtimes'],
  now: number,
  tab: Tab,
  tabIndex: number,
  sessionId: SessionId,
): AgentRow | null {
  const meta = state.sessions[sessionId]
  if (!meta) return null
  const kind = meta.kind ?? DEFAULT_PROVIDER

  const runtime = runtimes[sessionId]
  // Every session kind can be old (#865). Agents age by transcript
  // timestamps. Shells age by their DURABLE last-used record (#1178): typing,
  // a command starting or finishing, a cd. It used to be the runtime's
  // `terminalForeground.changedAt`, which every restart re-stamps to "now",
  // so no terminal could ever be old after a restart. The record lives on the
  // metadata, so a parked shell whose runtime was never rebuilt ages too.
  const lastActiveAt = kind === 'terminal'
    ? terminalLastUsedUpperBound(meta)
    : runtime ? latestAgentActivityAt(runtime) : null

  return {
    sessionId,
    tabId: tab.id,
    tabTitle: tab.title,
    title: sessionDisplayTitle(meta),
    tabIndex,
    kind,
    cwd: meta.cwd,
    cwdBase: cwdBasename(meta.cwd),
    // Shared with every other close path (expansion, the confirmation
    // dialog, Kill Buried). Three private copies of "is this busy" is how a
    // preview and a confirmation come to disagree about the same session.
    isLive: isSessionLiveForClose(runtimes, sessionId) || terminalLivenessUnknown(kind, runtime),
    livenessUnknown: !isSessionLiveForClose(runtimes, sessionId) && terminalLivenessUnknown(kind, runtime),
    lastActiveAt,
    ageMs: lastActiveAt == null ? null : Math.max(0, now - lastActiveAt),
  }
}

/**
 * The single row `buildAgentRows` would produce for `sessionId`, without
 * building every other row.
 *
 * WHY (#886 review m2): the close loop revalidates one target per kill — once
 * before calling closeSession and once more inside its synchronous `onlyIf` —
 * and each of those used to rebuild rows for the whole workspace, scanning
 * every transcript, although only one row was needed. It uses the same
 * first-owning-tab rule as the `seen` set in buildAgentRows, so the single row
 * and the full list cannot disagree about a session's project.
 */
export function buildAgentRow(
  state: Workspace['state'],
  runtimes: Workspace['runtimes'],
  now: number,
  sessionId: SessionId,
): AgentRow | null {
  for (let tabIndex = 0; tabIndex < state.tabs.length; tabIndex += 1) {
    const tab = state.tabs[tabIndex]
    if (resolveTabSessions(state, tab.id).includes(sessionId)) {
      return agentRowFor(state, runtimes, now, tab, tabIndex, sessionId)
    }
  }
  return null
}

/**
 * Build the preview rows from a workspace snapshot.
 *
 * Module-level and snapshot-in / rows-out so the SAME row derivation runs in the
 * render memo and again at the close loop's per-kill revalidation (which builds
 * just its target's row through buildAgentRow). The revalidation previously
 * re-read only `sessions` + liveness, which meant it could not see the two
 * criteria that actually put a row in the list — its age and its project. An
 * agent that received a message after the preview and went idle again passed a
 * liveness check while no longer being an OLD agent.
 *
 * Exported for its colocated test.
 */
export function buildAgentRows(
  state: Workspace['state'],
  runtimes: Workspace['runtimes'],
  now: number,
): AgentRow[] {
  const rows: AgentRow[] = []
  const seen = new Set<SessionId>()

  state.tabs.forEach((tab: Tab, tabIndex: number) => {
    for (const sessionId of resolveTabSessions(state, tab.id)) {
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      const row = agentRowFor(state, runtimes, now, tab, tabIndex, sessionId)
      if (row) rows.push(row)
    }
  })

  rows.sort((a, b) => {
    const at = a.ageMs ?? -1
    const bt = b.ageMs ?? -1
    if (at !== bt) return bt - at
    // Age first (the modal's purpose), then project tab, then the directory
    // inside it, so equal-age worktree agents of one project sit together.
    if (a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex
    return a.cwdBase.localeCompare(b.cwdBase)
  })
  return rows
}

function filterEligibleRows(
  rows: readonly AgentRow[],
  criteria: { thresholdMs: number | null; includeLive: boolean },
): AgentRow[] {
  if (criteria.thresholdMs == null) return []
  const thresholdMs = criteria.thresholdMs
  return rows.filter(row => {
    if (row.ageMs == null || !Number.isFinite(row.ageMs) || row.ageMs < thresholdMs) return false
    if (!criteria.includeLive && row.isLive) return false
    return true
  })
}

function filterMatchingRows(
  rows: readonly AgentRow[],
  criteria: { scopeMode: ScopeMode; selectedProjects: ReadonlySet<string> },
): AgentRow[] {
  if (criteria.scopeMode === 'all') return [...rows]
  // Projects are tabs (#908): a worktree agent belongs to its tab's project.
  return rowsInSelectedProjects(rows, criteria.selectedProjects)
}

const DEFAULT_THRESHOLD_VALUE = 4
const DEFAULT_THRESHOLD_UNIT: ThresholdUnit = 'hours'

function unitToMs(unit: ThresholdUnit): number {
  if (unit === 'minutes') return 60 * 1000
  if (unit === 'hours') return 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function absoluteTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Cleanup uses renderer evidence from both durable history and live work. PTY
// screen receipt alone is not activity: cursor redraws must not make an idle
// agent look new. Unknown/bootstrap history remains ineligible until observed.
//
// WHY this is its own, deliberately conservative rule instead of the shared
// `sessionActivity` helper (#886 review m1, revisited when #915 landed):
// #915 unified the TLDR footer and Agent Management on `sessionActivity`,
// which takes the newest of the ingest watermark, the transcript tail and the
// three runtime clocks. This rule keeps TWO signals that helper does not have:
// the semantic turn boundaries (`semantic.currentTurn`/`history`), and the
// refusal to answer at all while history is still bootstrapping. Both exist
// because the question here is narrower and destructive — "is it SAFE to kill
// this as old?" — and `null` is a real answer to it, while `sessionActivity`
// is a display value that must always produce something.
//
// So `latestAgentActivityAt(runtime) >= sessionActivity(runtime).timestamp`
// by construction: this rule can call an agent recent that Agent Activity
// (which reads `sessionActivity` since #1170) shows as "8h ago", and for
// a destructive filter that is the right direction to be wrong in. Keep it
// that way — if these ever need to converge, the move is to give
// `sessionActivity` an optional conservative mode, never to loosen this one to
// match a display surface.
function latestAgentActivityAt(runtime: Workspace['runtimes'][string]): number | null {
  // A replayed transcript is historical evidence, not proof that this live
  // agent has been idle since then. Submission/phase clocks survive the gap
  // before the provider commits new history; use the newest evidence, never
  // `oldTranscript ?? newerTurn`. An in-flight bootstrap cannot prove age.
  if (runtime.bootstrapping || runtime.processStatus === 'spawning' || runtime.transcriptStatus === 'loading') return null
  const turns = [runtime.semantic.currentTurn, ...runtime.semantic.history]
  const timestamps = [
    extractLatestEntryTs(runtime.entries), runtime.lastJsonlEntryAt,
    runtime.turnStartedAt, runtime.phaseChangedAt, runtime.submittedAt,
    ...turns.flatMap(turn => turn ? [turn.startedAt, turn.endedAt] : []),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  return timestamps.length ? Math.max(...timestamps) : null
}

/**
 * Newest valid transcript timestamp: scan from the end, stop at the first one.
 *
 * WHY not a full max over every entry (the first #886 version, review m2):
 * this runs inside the preview memo, which recomputes on every streaming
 * runtime update while the modal is open, for every session, and again at each
 * kill. freshness.ts made the same trade for the TLDR footer. The O(n) scan
 * bought nothing for safety: freshly ingested records also advance
 * `lastJsonlEntryAt`, and latestAgentActivityAt takes the max of this with that
 * watermark and the submission/phase/turn clocks, so a newer record that lands
 * out of order still makes the agent recent.
 */
function extractLatestEntryTs(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = (entries[i] as { timestamp?: unknown }).timestamp
    if (typeof raw !== 'string') continue
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`
}

export function CloseOldAgentsModal({ open, workspace, onClose }: Props) {
  const { showToast } = useGlobalToast()
  const [thresholdValue, setThresholdValue] = useState(String(DEFAULT_THRESHOLD_VALUE))
  const [thresholdUnit, setThresholdUnit] = useState<ThresholdUnit>(DEFAULT_THRESHOLD_UNIT)
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(() => new Set())
  const [includeLive, setIncludeLive] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')
  const [closing, setClosing] = useState(false)
  const [nowTick, setNowTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setThresholdValue(String(DEFAULT_THRESHOLD_VALUE))
    setThresholdUnit(DEFAULT_THRESHOLD_UNIT)
    setScopeMode('all')
    setSelectedProjects(new Set())
    setIncludeLive(false)
    setProjectFilter('')
    setClosing(false)
    // (Initial focus moved to DialogContent's onOpenAutoFocus: the rAF here
    // raced Radix's own mount focus, which landed on the header's "Esc"
    // button first.)
  }, [open])

  // Recompute ages while the modal is open so a borderline row ages into the
  // preview without the user changing a field. 10s matches Agent Activity:
  // precise enough for human decisions, cheap enough for large workspaces.
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNowTick(t => t + 1), 10_000)
    return () => window.clearInterval(id)
  }, [open])

  const thresholdNumber = Number(thresholdValue)
  const thresholdMs =
    Number.isFinite(thresholdNumber) && thresholdNumber > 0
      ? thresholdNumber * unitToMs(thresholdUnit)
      : null

  const agentRows = useMemo<AgentRow[]>(() => {
    // Dialog hides content, not this component's hooks. Do not scan every
    // retained transcript on visible agents' updates for an invisible preview.
    // Keep the mounted state and action-time revalidation lifetime unchanged;
    // the open dependency rebuilds current rows as soon as the user shows it.
    if (!open) return []
    void nowTick
    return buildAgentRows(workspace.state, workspace.runtimes, Date.now())
  }, [open, workspace.runtimes, workspace.state, nowTick])

  const selectedProjectSet = useMemo(
    () => selectedProjects,
    [selectedProjects],
  )

  const eligibleRows = useMemo(
    () => filterEligibleRows(agentRows, { thresholdMs, includeLive }),
    [agentRows, includeLive, thresholdMs],
  )

  const matchingRows = useMemo(
    () => filterMatchingRows(eligibleRows, { scopeMode, selectedProjects: selectedProjectSet }),
    [eligibleRows, scopeMode, selectedProjectSet],
  )

  // Projects are TABS, keyed by tab id and labelled like the Dispatch index
  // (#908). `matching` is how many of the tab's agents pass the age threshold,
  // so the "2/7" count still tells the user what a tick would actually close.
  const projects = useMemo<ProjectScopeRow[]>(
    () => buildProjectScopeRows(agentRows, eligibleRows),
    [agentRows, eligibleRows],
  )

  const filteredProjects = useMemo(
    () => filterProjectScopeRows(projects, projectFilter),
    [projectFilter, projects],
  )

  const liveMatchCount = matchingRows.filter(row => row.isLive).length
  // Count only tabs that still exist: a selected tab closed while the modal is
  // open keeps its id in the set (membership is unaffected, its rows are gone)
  // and would otherwise inflate "N selected".
  const selectedCount = projects.filter(project => selectedProjects.has(project.tabId)).length
  const thresholdValid = thresholdMs != null

  const toggleProject = useCallback((tabId: string) => {
    setSelectedProjects(prev => {
      const next = new Set(prev)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      return next
    })
  }, [])

  const selectAllProjects = useCallback(() => {
    setSelectedProjects(new Set(projects.map(project => project.tabId)))
  }, [projects])

  const clearProjects = useCallback(() => {
    setSelectedProjects(new Set())
  }, [])

  /** Re-run the FULL eligibility predicate for ONE session against the given
   *  state. Not just liveness: age and project scope are what put a row in the
   *  list, so they are what a stale grant must be re-checked against. One row
   *  rather than the whole workspace, because each kill needs only its own
   *  target (see buildAgentRow).
   *
   *  closeGrantedSessions runs this at each kill boundary with the close
   *  action's LIVE state. That is why no workspace ref is kept here any more:
   *  the modal once revalidated from the `workspace` captured in its callback's
   *  closure, which never changes during the loop and so re-derived the same
   *  answer for every kill; a render-updated ref fixed that, and the kill
   *  boundary check made both unnecessary. */
  const currentCloseTarget = useCallback((
    state: Workspace['state'],
    runtimes: Workspace['runtimes'],
    sessionId: SessionId,
  ): CloseTargetSnapshot | null => {
    const row = buildAgentRow(state, runtimes, Date.now(), sessionId)
    if (!row) return null
    const eligible = filterEligibleRows([row], { thresholdMs, includeLive })
    const [match] = filterMatchingRows(eligible, { scopeMode, selectedProjects: selectedProjectSet })
    return match
      ? { sessionId: match.sessionId, title: `${match.title} · ${match.cwdBase}`, live: match.isLive }
      : null
  }, [thresholdMs, includeLive, scopeMode, selectedProjectSet])

  const closeMatchingAgents = useCallback(async () => {
    if (matchingRows.length === 0 || closing) return
    setClosing(true)
    try {
      // THE GRANT. What the user saw and approved, captured at click time. This
      // modal IS the confirmation surface: it shows the exact list, the count
      // and the running count, and requires an explicit click.
      // closeGrantedSessions carries that grant through every kill, including
      // the linked-children-first order and the per-kill revalidation.
      const granted = matchingRows.map(row => ({
        sessionId: row.sessionId,
        title: `${row.title} · ${row.cwdBase}`,
        live: row.isLive,
      }))
      const outcome = await closeGrantedSessions({
        granted,
        sessions: workspace.state.sessions,
        closeSession: workspace.closeSession,
        currentTarget: currentCloseTarget,
        killCaller: 'bulk.close-old-agents',
      })

      const report = describePartialClose(outcome)
      showToast(report ?? `Closed ${outcome.closed.length} session${outcome.closed.length === 1 ? '' : 's'}.`, 6000)
      onClose()
    } finally {
      setClosing(false)
    }
  }, [currentCloseTarget, closing, matchingRows, onClose, showToast, workspace.closeSession, workspace.state.sessions])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        size="lg"
        className="flex max-h-[86vh] flex-col overflow-hidden"
        // IN-FLIGHT EXIT INVARIANT (steering note k3): while the batch close
        // runs, NO path may hide the dialog — not Cancel (disabled below), not
        // Escape, not an outside click. The old footer disabled Cancel while
        // closing; the first DialogActions migration passed only `busy`, which
        // disables the CONFIRM, so Cancel hid a destructive batch that was
        // still killing agents and made the result look cancelled. Same model
        // as Bulk Provider Switch: cancelDisabled + escapeCancels + these two
        // guards.
        onEscapeKeyDown={event => { if (closing) event.preventDefault() }}
        onInteractOutside={event => { if (closing) event.preventDefault() }}
        onOpenAutoFocus={event => {
          // Focus the threshold: it is what the user came to change. Radix
          // would otherwise focus the first tabbable node.
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        {/* Standard header (plan T3). The "Esc" BUTTON that sat here is gone:
            it was a second, differently-styled Cancel that described a KEY
            rather than an action — the footer's `Cancel ⎋` is the exit, and
            the chip is where the key hint lives (plan H5). */}
        <DialogHeader>
          <DialogTitle>Close Old Agents</DialogTitle>
          <DialogDescription>
            Close agents and terminals that have been inactive past the threshold.
            Running agents, terminals with a command in progress, and terminals
            not observed since the app started are excluded unless explicitly
            included.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <div className="grid grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)] gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted">
                Inactive for more than
              </label>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  ref={inputRef}
                  type="number"
                  min="1"
                  step="1"
                  value={thresholdValue}
                  onChange={e => setThresholdValue(e.target.value)}
                  aria-label="Inactive for more than"
                  // T4: `focus:border-accent` (any focus, accent colour) →
                  // the input focus tokens on :focus-visible, like <Input>.
                  className="w-24"
                />
                <Select
                  value={thresholdUnit}
                  onChange={e => setThresholdUnit(e.target.value as ThresholdUnit)}
                  aria-label="Threshold unit"
                  
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </Select>
              </div>
              {!thresholdValid && (
                <div className="mt-1 text-[10px] text-danger">
                  Enter a number greater than zero.
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted">
                Project scope
              </div>
              {/* The shared segmented look (UI pass, G-10); toggle-button
                  semantics as before (aria-pressed, each a Tab stop). */}
              <SegmentedControl
                className="mt-1"
                label="Project scope"
                value={scopeMode}
                onChange={setScopeMode}
                options={[{ value: 'all', label: 'All projects' }, { value: 'selected', label: 'Selected projects' }] as const}
              />
              <label className="mt-3 flex items-center gap-2 text-[11px] text-ink-dim">
                <input
                  type="checkbox"
                  checked={includeLive}
                  onChange={e => setIncludeLive(e.target.checked)}
                />
                Include agents that are currently running
              </label>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border flex flex-col">
            <div className="flex-shrink-0 px-3 py-2 border-b border-border">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-ink">Projects</div>
                {scopeMode === 'selected' && (
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="xs" onClick={selectAllProjects}>
                      All
                    </Button>
                    <Button type="button" variant="ghost" size="xs" onClick={clearProjects}>
                      Clear
                    </Button>
                  </div>
                )}
              </div>
              {scopeMode === 'selected' && projects.length > 8 && (
                <Input
                  type="text"
                  value={projectFilter}
                  onChange={e => setProjectFilter(e.target.value)}
                  placeholder="Filter projects"
                  aria-label="Filter projects"
                  className="mt-2"
                />
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {projects.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] text-muted">
                  No open agents or terminals.
                </div>
              ) : (
                filteredProjects.map(project => {
                  const selected = selectedProjects.has(project.tabId)
                  const disabled = scopeMode === 'all'
                  return (
                    <label
                      key={project.tabId}
                      className={`
                        flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0
                        ${disabled ? 'text-ink-dim' : 'cursor-pointer hover:bg-row-hover-bg'}
                      `}
                    >
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={scopeMode === 'all' || selected}
                        onChange={() => toggleProject(project.tabId)}
                        className="mt-0.5 disabled:opacity-50"
                      />
                      <span className="min-w-0 flex-1">
                        {/* The Dispatch vocabulary (A · title), so this picker
                            names projects the way the index does. Worktrees
                            appear below as directories inside the project. */}
                        {/* Escaped like the session rows below: these two
                            lines are what the user reads to decide WHICH
                            project they are ticking for a bulk close, and both
                            come from titles and paths an agent can influence
                            (#1049 re-review). */}
                        <span className="block text-[11px] text-ink truncate">
                          {withVisibleControls(project.label)}
                        </span>
                        <span className="block text-[10px] text-muted truncate">
                          {withVisibleControls(project.directories.join(' · '))}
                        </span>
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted tabular-nums">
                        {project.matching}/{project.total}
                      </span>
                    </label>
                  )
                })
              )}
            </div>
          </div>

          <div className="min-h-0 flex flex-col">
            <div className="flex-shrink-0 px-4 py-2 border-b border-border flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] text-ink">Preview</div>
                <div className="mt-0.5 text-[10px] text-muted">
                  {matchingRows.length === 0
                    ? 'No agents match the current filters.'
                    : `${matchingRows.length} agent${matchingRows.length === 1 ? '' : 's'} will be closed${liveMatchCount > 0 ? `, including ${liveMatchCount} running` : ''}.`}
                </div>
              </div>
              {scopeMode === 'selected' && (
                <div className="text-[10px] text-muted">
                  {selectedCount} selected
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {matchingRows.length === 0 ? (
                <div className="px-4 py-10 text-center text-[12px] text-muted">
                  {thresholdValid
                    ? `No agents have been inactive for more than ${thresholdValue || '0'} ${thresholdUnit}.`
                    : 'Enter a valid threshold to preview matching agents.'}
                </div>
              ) : (
                matchingRows.map(row => (
                  <div
                    key={row.sessionId}
                    className="flex items-start gap-3 px-4 py-2.5 border-b border-border last:border-b-0"
                  >
                    <div className="flex-shrink-0 w-[72px] flex items-center gap-2">
                      <span className={row.isLive ? 'text-danger' : 'text-muted'}>
                        {providerGlyph(row.kind)}
                      </span>
                      <span className="text-[11px] uppercase tracking-wider text-muted">
                        {row.kind}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      {/* Same rule as the close confirmation: these identify
                          what a bulk close is about to terminate (#1049). */}
                      <div className="text-[12px] text-ink truncate">
                        {withVisibleControls(row.title)}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted truncate">
                        {tabIndexLabel(row.tabIndex)} · {withVisibleControls(row.tabTitle)} · {withVisibleControls(row.cwd)}
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-[150px] text-right">
                      {row.livenessUnknown ? (
                        // The guidance is VISIBLE (K2-20). It was only a hover
                        // title on a non-focusable div, and it is the one
                        // thing that tells the user how to proceed with this
                        // row.
                        <>
                          <div className="text-[11px] text-warning">not observed yet</div>
                          <div className="text-[10px] leading-snug text-muted">
                            may still be running · wake it, or include running agents
                          </div>
                        </>
                      ) : row.isLive ? (
                        <div className="text-[11px] text-danger">running</div>
                      ) : null}
                      {row.lastActiveAt != null && row.ageMs != null ? (
                        <>
                          <div className="text-[11px] text-ink-dim">
                            inactive {formatDuration(row.ageMs)}
                          </div>
                          <div className="text-[10px] text-muted">
                            {relativeTime(row.lastActiveAt)} · {absoluteTime(row.lastActiveAt)}
                          </div>
                        </>
                      ) : (
                        <div className="text-[10px] text-muted">unknown activity</div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* DESTRUCTIVE and bulk (plan K1): no commit key. Focus opens in
            the threshold field, and Enter there must never close a batch of
            agents; the red button is Tab-then-Enter or a click. Cancel keeps
            ⎋. The exclusion note that lived here moved into the header
            description — a footer left slot is one truncating line. */}
        <DialogActions
          tone="danger"
          confirmKey={null}
          busy={closing}
          confirmDisabled={matchingRows.length === 0 || !thresholdValid}
          confirmLabel={
            liveMatchCount > 0
              ? `Close ${matchingRows.length} Agents, Including ${liveMatchCount} Running`
              : `Close ${matchingRows.length} Agent${matchingRows.length === 1 ? '' : 's'}`
          }
          onConfirm={() => void closeMatchingAgents()}
          onCancel={onClose}
          cancelDisabled={closing}
          escapeCancels={!closing}
        />
      </DialogContent>
    </Dialog>
  )
}
