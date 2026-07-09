import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  AgentOverlaySnapshot,
  OverlayAgentRow,
} from '@shared/types/agentOverlay'
import type { Settings } from '@renderer/app-state/settings/types'
import { applyTheme } from '@renderer/app-state/settings/theme'
import { dispatchActivityDotClass } from '@renderer/workspace/dispatch/dispatchActivity'

// Floating agent-status overlay UI. Two modes, one component:
//
//   collapsed — a one-line pill of activity dots + counts ("am I needed?")
//   expanded  — per-agent rows; click a row to jump to that agent in the
//               main window (main raises the app, the workspace focuses
//               the pane — see main/ipc/agentOverlay.ts)
//
// Everything rendered here comes precomputed in the snapshot from the main
// renderer (see shared/types/agentOverlay.ts for why no derivation happens
// in this bundle). The one piece of shared code is dispatchActivityDotClass
// so these dots can never drift from the Dispatch list's palette.

/** Buckets for the pill. `waiting` (a pending permission/trust prompt)
 *  outranks the activity value on purpose: an agent can be nominally
 *  "running" while blocked on the user, and blocked-on-you is the single
 *  most important thing this overlay exists to surface. */
type Counts = {
  waiting: number
  active: number
  starting: number
  idle: number
  exited: number
}

function countAgents(agents: OverlayAgentRow[]): Counts {
  const counts: Counts = { waiting: 0, active: 0, starting: 0, idle: 0, exited: 0 }
  for (const agent of agents) {
    if (agent.attentionLabel) counts.waiting += 1
    else if (agent.activity === 'working' || agent.activity === 'running') counts.active += 1
    else if (agent.activity === 'starting') counts.starting += 1
    else if (agent.activity === 'exited') counts.exited += 1
    else counts.idle += 1
  }
  return counts
}

export function OverlayApp() {
  const [snapshot, setSnapshot] = useState<AgentOverlaySnapshot | null>(null)
  const [expanded, setExpanded] = useState(false)
  const lastThemeJsonRef = useRef<string | null>(null)

  useEffect(() => {
    return window.api.onAgentOverlayState(payload => {
      if (payload.snapshot) {
        setSnapshot(payload.snapshot)
        // Theme rides the snapshot (the overlay has no settings store of its
        // own). applyTheme is cheap but dispatches a window event and writes
        // font CSS vars, so gate on actual change instead of every report.
        if (payload.snapshot.theme) {
          const themeJson = JSON.stringify(payload.snapshot.theme)
          if (themeJson !== lastThemeJsonRef.current) {
            lastThemeJsonRef.current = themeJson
            applyTheme(payload.snapshot.theme as unknown as Settings)
          }
        }
      }
      // Present only on the initial post-load push — restores the persisted
      // pill/list mode. See AgentOverlayStateEvent.
      if (typeof payload.expanded === 'boolean') setExpanded(payload.expanded)
    })
  }, [])

  // The renderer owns window size: it measures its actual content and asks
  // main to fit the window around it (clamped there). This is what keeps
  // the transparent window snug — leftover transparent area would still
  // swallow clicks meant for whatever is underneath the overlay.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let lastW = 0
    let lastH = 0
    const push = () => {
      const rect = el.getBoundingClientRect()
      const width = Math.ceil(rect.width)
      const height = Math.ceil(rect.height)
      if (width === lastW && height === lastH) return
      lastW = width
      lastH = height
      window.api.agentOverlayResize({ width, height })
    }
    const observer = new ResizeObserver(push)
    observer.observe(el)
    push()
    return () => observer.disconnect()
  }, [])

  const agents = snapshot?.agents ?? []
  const counts = useMemo(() => countAgents(agents), [agents])
  const projectCount = useMemo(
    () => new Set(agents.map(agent => agent.projectTitle)).size,
    [agents],
  )

  const toggleExpanded = (next: boolean) => {
    setExpanded(next)
    window.api.agentOverlaySetExpanded(next)
  }

  return (
    <div ref={rootRef} className="w-max font-code">
      {expanded ? (
        <ExpandedPanel
          agents={agents}
          counts={counts}
          showProject={projectCount > 1}
          onCollapse={() => toggleExpanded(false)}
        />
      ) : (
        <CollapsedPill counts={counts} hasAgents={agents.length > 0} onExpand={() => toggleExpanded(true)} />
      )}
    </div>
  )
}

function CollapsedPill({
  counts,
  hasAgents,
  onExpand,
}: {
  counts: Counts
  hasAgents: boolean
  onExpand: () => void
}) {
  return (
    // The pill body is the drag handle (a frameless window needs SOME
    // grabbable area, and the pill is nearly all of it); the content is a
    // no-drag button so a plain click still expands. See overlay.css.
    <div className="app-region-drag inline-flex h-9 items-center rounded-full border border-border bg-surface px-1.5 shadow-lg">
      <button
        type="button"
        onClick={onExpand}
        className="app-region-no-drag flex items-center gap-2.5 rounded-full px-2 py-1 hover:bg-surface-hi"
        aria-label="Expand agent status"
      >
        {hasAgents ? (
          <>
            {counts.waiting > 0 ? (
              <PillSegment
                dotClass="bg-warning animate-pulse"
                count={counts.waiting}
                textClass="text-warning font-semibold"
              />
            ) : null}
            {counts.active > 0 ? (
              <PillSegment dotClass="bg-success" count={counts.active} textClass="text-ink" />
            ) : null}
            {counts.starting > 0 ? (
              <PillSegment dotClass="bg-warning" count={counts.starting} textClass="text-ink-dim" />
            ) : null}
            {counts.idle > 0 ? (
              <PillSegment dotClass="bg-muted" count={counts.idle} textClass="text-muted" />
            ) : null}
            {counts.exited > 0 ? (
              <PillSegment dotClass="bg-danger" count={counts.exited} textClass="text-muted" />
            ) : null}
          </>
        ) : (
          <span className="text-[11px] text-muted">no agents</span>
        )}
      </button>
    </div>
  )
}

function PillSegment({
  dotClass,
  count,
  textClass,
}: {
  dotClass: string
  count: number
  textClass: string
}) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dotClass}`} />
      <span className={`text-[11px] leading-none ${textClass}`}>{count}</span>
    </span>
  )
}

function ExpandedPanel({
  agents,
  counts,
  showProject,
  onCollapse,
}: {
  agents: OverlayAgentRow[]
  counts: Counts
  showProject: boolean
  onCollapse: () => void
}) {
  return (
    <div className="w-[300px] overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
      <header className="app-region-drag flex h-8 items-center justify-between border-b border-border px-3">
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted">Agents</span>
        <div className="flex items-center gap-2">
          {counts.waiting > 0 ? (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-warning">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              {counts.waiting} waiting
            </span>
          ) : null}
          <button
            type="button"
            onClick={onCollapse}
            className="app-region-no-drag px-1 text-[14px] leading-none text-muted hover:text-ink"
            aria-label="Collapse to pill"
          >
            ─
          </button>
        </div>
      </header>
      {agents.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-muted">No agent sessions running.</div>
      ) : (
        <ul className="app-region-no-drag max-h-[420px] overflow-y-auto py-1">
          {agents.map(agent => (
            <AgentRow key={agent.sessionId} agent={agent} showProject={showProject} />
          ))}
        </ul>
      )}
    </div>
  )
}

function AgentRow({ agent, showProject }: { agent: OverlayAgentRow; showProject: boolean }) {
  const waiting = agent.attentionLabel !== null
  const dotClass = waiting
    ? 'bg-warning animate-pulse'
    : dispatchActivityDotClass(agent.activity)
  // Right-side text priority: blocked-on-you beats the provider verb beats
  // the bare activity word — most-actionable information wins the glance.
  const detail = agent.attentionLabel ?? agent.statusText ?? agent.activity
  return (
    <li>
      <button
        type="button"
        onClick={() => window.api.agentOverlayFocusSession(agent.sessionId)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hi"
        title={`${agent.title} — ${agent.projectTitle}`}
      >
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dotClass}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
          {agent.pinned ? <span className="mr-1 text-accent">★</span> : null}
          {agent.title}
        </span>
        {showProject ? (
          <span className="max-w-[72px] flex-shrink-0 truncate text-[9px] text-muted">
            {agent.projectTitle}
          </span>
        ) : null}
        <span
          className={`max-w-[110px] flex-shrink-0 truncate text-[10px] ${
            waiting
              ? 'font-semibold text-warning'
              : agent.activity === 'exited'
                ? 'text-danger'
                : 'text-muted'
          }`}
        >
          {detail}
        </span>
      </button>
    </li>
  )
}
