import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { SessionKind } from '@shared/types/providerKind'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  describePartialClose,
  isSessionLiveForClose,
  narrowGrantToCurrent,
} from '@renderer/workspace/closeConfirmation'
import type {
  CloseTargetSnapshot,
  PartialCloseOutcome,
} from '@renderer/workspace/closeConfirmation'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
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
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { CloseRefusalReason } from '@renderer/workspace/hook/actions/pane'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { Entry } from '@shared/types/transcript'

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
  lastActiveAt: number | null
  ageMs: number | null
}

/**
 * Build the preview rows from a workspace snapshot.
 *
 * Module-level and snapshot-in / rows-out so the SAME derivation runs in the
 * render memo and again inside the close loop's per-kill revalidation. The
 * revalidation previously re-read only `sessions` + liveness, which meant it
 * could not see the two criteria that actually put a row in the list — its age
 * and its project. An agent that received a message after the preview and went
 * idle again passed a liveness check while no longer being an OLD agent.
 *
 * Exported for its colocated test; still the one derivation the render memo
 * and the close loop share.
 */
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
  // timestamps; shells by their last foreground change (a command
  // starting/finishing or a cd), which is the only activity a shell has.
  const lastActiveAt = runtime
    ? kind === 'terminal'
      ? runtime.terminalForeground?.changedAt ?? null
      : latestAgentActivityAt(runtime)
    : null

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
    isLive: isSessionLiveForClose(runtimes, sessionId),
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
// WHY this is its own, deliberately conservative rule instead of a shared
// "last active" helper (#886 review m1): #915 documents that the TLDR footer
// (features/tldr/freshness.ts) and Agent Management (agentManagementMcp.ts)
// already derive last-active differently, and unifying them changes Agent
// Management's MCP output for existing callers — #915 owns that decision, so
// this PR does not pre-empt it. This rule answers a narrower question, "is it
// SAFE to kill this as old?", so it takes the newest of every channel
// (transcript tail, ingest watermark, submission, phase, semantic turns) and
// refuses to age incomplete history. It can call an agent recent that Agent
// Activity (AgentActivityModal: last entry ?? turnStartedAt) shows as "8h ago";
// for a destructive filter that is the right direction to be wrong in. When
// #915 lands one helper, this should become its most conservative consumer,
// not be loosened to match the display surfaces.
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
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // Recompute ages while the modal is open so a borderline row ages into the
  // preview without the user changing a field. 10s matches AgentActivityModal:
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

  // A LIVE handle on the workspace, updated on every render.
  //
  // The revalidation below used to read the `workspace` captured by
  // `closeMatchingAgents`'s closure. That object is the value from the render
  // in which the callback was created and never changes during the loop — so
  // "re-enumerate before every kill" re-derived the identical answer twelve
  // times and could not detect anything. React re-renders this modal as each
  // close mutates workspace state, which is what keeps this ref current.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  /** Re-run the FULL eligibility predicate for ONE session against the given
   *  state, in the shape the grant comparison expects. Not just liveness: age
   *  and project scope are what put a row in the list, so they are what a
   *  stale grant must be re-checked against. One row rather than the whole
   *  workspace, because each kill needs only its own target (see buildAgentRow). */
  const currentCloseTarget = useCallback((
    state: Workspace['state'],
    runtimes: Workspace['runtimes'],
    sessionId: SessionId,
  ): CloseTargetSnapshot[] => {
    const row = buildAgentRow(state, runtimes, Date.now(), sessionId)
    if (!row) return []
    const eligible = filterEligibleRows([row], { thresholdMs, includeLive })
    return filterMatchingRows(eligible, { scopeMode, selectedProjects: selectedProjectSet })
      .map(match => ({
        sessionId: match.sessionId,
        title: `${match.title} · ${match.cwdBase}`,
        live: match.isLive,
      }))
  }, [thresholdMs, includeLive, scopeMode, selectedProjectSet])

  const closeMatchingAgents = useCallback(async () => {
    if (matchingRows.length === 0 || closing) return
    setClosing(true)
    try {
      // Sequential close is intentional. workspace.closeSession mutates the
      // tile tree, detached-session map, undo stack, runtime maps, and linked
      // children. Firing N closes concurrently would make each call read a
      // slightly stale snapshot and could drop layout/undo bookkeeping. Batch
      // cleanup is rare enough that predictable mutation beats raw speed.
      // THE GRANT. What the user saw and approved, captured at click time.
      const granted = matchingRows.map(row => ({
        sessionId: row.sessionId,
        title: `${row.title} · ${row.cwdBase}`,
        live: row.isLive,
      }))

      const outcome: PartialCloseOutcome = { closed: [], failed: [], kept: [], skipped: [] }

      // Close linked descendants first. A parent whose child is still present —
      // excluded from the preview, woke up, or failed to close — is KEPT by
      // closeSession's linked-child verdict and reported in its own bucket
      // (onRefused 'linked-session-open'). This preserves the lifecycle edge
      // without implicitly granting the parent permission to kill more sessions.
      const sessions = workspaceRef.current.state.sessions
      const depth = (id: SessionId): number => {
        const seen = new Set<SessionId>()
        while (sessions[id]?.linkedParentId && !seen.has(id)) {
          seen.add(id)
          id = sessions[id].linkedParentId!
        }
        return seen.size
      }
      granted.sort((a, b) => depth(b.sessionId) - depth(a.sessionId))
      for (const target of granted) {
        // RE-ENUMERATE BEFORE EVERY KILL, not once after confirmation.
        //
        // The audit's finding: a preview the user approved goes stale. Between
        // clicking and the tenth kill, agents finish, new ones spawn, and one
        // of the idle agents in the list can wake up and start working. A grant
        // checked once at the top would authorize killing it.
        //
        // Re-reading per iteration is affordable because the loop is already
        // sequential (closeSession mutates the tree, so concurrency would make
        // each call read a stale snapshot) and bulk cleanup is rare.
        const ws = workspaceRef.current
        const current = currentCloseTarget(ws.state, ws.runtimes, target.sessionId)
        const stillGranted = narrowGrantToCurrent([target], current)
        if (stillGranted.length === 0) {
          outcome.skipped.push(target.sessionId)
          continue
        }
        try {
          // preConfirmed: this modal IS the confirmation surface. It shows the
          // exact list, the count, and the live count, and requires an explicit
          // click — a strictly stronger grant than the generic dialog, which
          // would otherwise fire once per agent and turn a twelve-agent cleanup
          // into twelve modals. The per-kill revalidation above is what keeps
          // that grant honest.
          // captureUndo: false — this surface exists to PURGE N stale agents, which in a
          // Dispatch-heavy workspace are overwhelmingly detached rows. Capturing one
          // entry each would flush the user's real close history out of the 10-entry
          // stack, so ⌘⇧T would resurrect something they just deliberately cleared.
          // onRefused: closeSession's boolean cannot say WHY it refused, and a
          // parent kept for its still-open linked child is not a "changed" skip
          // (#886 review m7). Holder object for the same TypeScript narrowing
          // reason as elsewhere: a `let` would stay typed as its initial value.
          const refusal: { reason?: CloseRefusalReason } = {}
          const closed = await ws.closeSession(target.sessionId, {
            preConfirmed: true,
            captureUndo: false,
            // Synchronous, and built for this one session only: it runs at the
            // kill boundary with the action's live state (see onlyIf).
            onlyIf: (state, runtimes) => {
              const [row] = currentCloseTarget(state, runtimes, target.sessionId)
              return row !== undefined && (!row.live || target.live)
            },
            onRefused: reason => { refusal.reason = reason },
          })
          if (closed) outcome.closed.push(target.sessionId)
          else if (refusal.reason === 'linked-session-open') outcome.kept.push(target.sessionId)
          else outcome.skipped.push(target.sessionId)
        } catch (error) {
          // One backend refusing must not abandon the rest of the batch — the
          // user asked for twelve agents closed, and nine succeeding is a
          // better outcome than stopping at the first failure with no report.
          outcome.failed.push({ sessionId: target.sessionId, error })
        }
      }

      const report = describePartialClose(outcome)
      showToast(report ?? `Closed ${outcome.closed.length} session${outcome.closed.length === 1 ? '' : 's'}.`, 6000)
      onClose()
    } finally {
      setClosing(false)
    }
  }, [currentCloseTarget, closing, matchingRows, onClose, showToast])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent className="flex max-h-[86vh] w-[min(860px,94vw)] flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>Close Old Agents</DialogTitle>
              <DialogDescription>
                Close agents and terminals that have been inactive past the threshold.
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-control px-2 py-1 text-[10px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
            >
              Esc
            </button>
          </div>

          <div className="mt-4 grid grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)] gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted">
                Inactive for more than
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  ref={inputRef}
                  type="number"
                  min="1"
                  step="1"
                  value={thresholdValue}
                  onChange={e => setThresholdValue(e.target.value)}
                  className="rounded-control w-24 px-2 py-1.5 bg-canvas border border-border text-[12px] text-ink outline-none focus:border-accent"
                />
                <select
                  value={thresholdUnit}
                  onChange={e => setThresholdUnit(e.target.value as ThresholdUnit)}
                  className="rounded-control px-2 py-1.5 bg-canvas border border-border text-[12px] text-ink outline-none focus:border-accent"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
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
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScopeMode('all')}
                  className={`rounded-control px-2.5 py-1.5 text-[11px] border ${
                    scopeMode === 'all'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-ink-dim hover:text-ink hover:border-border-hi'
                  }`}
                >
                  All projects
                </button>
                <button
                  type="button"
                  onClick={() => setScopeMode('selected')}
                  className={`rounded-control px-2.5 py-1.5 text-[11px] border ${
                    scopeMode === 'selected'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-ink-dim hover:text-ink hover:border-border-hi'
                  }`}
                >
                  Selected projects
                </button>
              </div>
              <label className="mt-3 flex items-center gap-2 text-[11px] text-ink-dim">
                <input
                  type="checkbox"
                  checked={includeLive}
                  onChange={e => setIncludeLive(e.target.checked)}
                  className="accent-current"
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
                    <button
                      type="button"
                      onClick={selectAllProjects}
                      className="px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                    >
                      all
                    </button>
                    <button
                      type="button"
                      onClick={clearProjects}
                      className="px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                    >
                      clear
                    </button>
                  </div>
                )}
              </div>
              {scopeMode === 'selected' && projects.length > 8 && (
                <input
                  type="text"
                  value={projectFilter}
                  onChange={e => setProjectFilter(e.target.value)}
                  placeholder="Filter projects"
                  className="rounded-control mt-2 w-full px-2 py-1 bg-canvas border border-border text-[11px] text-ink outline-none focus:border-accent"
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
                        ${disabled ? 'text-ink-dim' : 'cursor-pointer hover:bg-surface-hi'}
                      `}
                    >
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={scopeMode === 'all' || selected}
                        onChange={() => toggleProject(project.tabId)}
                        className="mt-0.5 accent-current disabled:opacity-50"
                      />
                      <span className="min-w-0 flex-1">
                        {/* The Dispatch vocabulary (A · title), so this picker
                            names projects the way the index does. Worktrees
                            appear below as directories inside the project. */}
                        <span className="block text-[11px] text-ink truncate">
                          {project.label}
                        </span>
                        <span className="block text-[10px] text-muted truncate">
                          {project.directories.join(' · ')}
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
                      <div className="text-[12px] text-ink truncate">
                        {row.title}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted truncate">
                        {tabIndexLabel(row.tabIndex)} · {row.tabTitle} · {row.cwd}
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-[150px] text-right">
                      {row.isLive ? (
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

        <div className="flex-shrink-0 border-t border-border px-4 py-3 flex items-center justify-between gap-3">
          <div className="text-[10px] text-muted">
            Running agents and terminals with a command in progress are excluded unless explicitly included.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={closing}
              className="rounded-control px-3 py-1.5 text-[11px] border border-border text-ink-dim hover:text-ink hover:border-border-hi disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void closeMatchingAgents()}
              disabled={closing || matchingRows.length === 0 || !thresholdValid}
              className={`rounded-control
                px-3 py-1.5 text-[11px] border
                ${matchingRows.length > 0 && thresholdValid
                  ? 'border-danger-border bg-danger-soft text-danger hover:bg-danger-soft/80'
                  : 'border-border text-muted opacity-60 cursor-not-allowed'}
              `}
            >
              {closing
                ? 'Closing…'
                : liveMatchCount > 0
                  ? `Close ${matchingRows.length} Agents, Including ${liveMatchCount} Running`
                  : `Close ${matchingRows.length} Agent${matchingRows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
