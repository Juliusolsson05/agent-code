import { useEffect, useMemo, useRef, useState } from 'react'

import type { ConnectionState } from '../../WebSocketSessionFeed'
import type { WebSocketSessionFeed } from '../../WebSocketSessionFeed'
import type { RemoteNoteRecord, RemoteSessionSummary } from '../../wire'
import type { UsageSnapshot } from '@shared/types/usage'
import { PeekOverlay } from './PeekOverlay'
import type { PeekKind } from './PeekOverlay'
import { providerBadge } from './providerIdentity'
import { relativeShort } from './time'

// Fleet home — the v2 replacement for the v1 SessionList. Monitoring is an
// equal peer to driving, so the home screen is the FLEET: every agent on
// the Mac, grouped by project (the workspace projection's tabTitle),
// pinned agents first, with the TLDR one-line glance and a long-press
// TLDR/Goal peek per row.
//
// Grouping rule: tabTitle from the projection is authoritative when
// present; a cwd basename is the fallback for sessions the workspace
// hasn't claimed yet (fresh spawns before the first autosave); the raw id
// is the last resort (v1 behavior, never preferred).

const LONG_PRESS_MS = 350
// Movement beyond this many pixels cancels the hold — the user is
// scrolling, not peeking. 10px absorbs thumb jitter without letting a
// scroll masquerade as a press.
const HOLD_SLOP_PX = 10

type PeekTarget = { sessionId: string; kind: PeekKind }


/** How far ahead of this device's clock a stamp may sit and still be treated
 *  as real. Everything here is already in this device's time base, so this
 *  covers transit and rounding, not the gap between two machines. */
const FUTURE_STAMP_TOLERANCE_MS = 5_000

export function FleetHome({
  feed,
  connection,
  onSelect,
  onUnpair,
}: {
  feed: WebSocketSessionFeed
  connection: ConnectionState
  onSelect: (sessionId: string) => void
  onUnpair: () => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>(feed.getSessionList())
  const [activity, setActivity] = useState<Record<string, boolean>>({})
  const [usage, setUsage] = useState<UsageSnapshot | null>(feed.getUsage())
  const [peek, setPeek] = useState<PeekTarget | null>(null)
  const [clockTick, setClockTick] = useState(0)

  useEffect(() => {
    const offs = [
      feed.onSessionList(setSessions),
      feed.onSessionProcessState(e => {
        setActivity(prev =>
          prev[e.sessionId] === e.active ? prev : { ...prev, [e.sessionId]: e.active },
        )
      }),
      feed.onUsage(next => setUsage(next)),
    ]
    // Re-render each half-minute so relative labels don't rot while the
    // screen sits open — same cadence the v1 list established.
    const timer = window.setInterval(() => setClockTick(t => t + 1), 30_000)
    return () => {
      for (const off of offs) off()
      window.clearInterval(timer)
    }
  }, [feed])

  const groups = useMemo(() => {
    // Recomputed on the clock tick as well as on new sessions (see the memo's
    // dependencies): a clamped row's place depends on `now`, so without the
    // tick the arrangement froze at whatever the clock said when the list was
    // opened (#1055 review).
    const now = Date.now()
    // Every comparison ends in the session id, and the groups are ordered by a
    // rule rather than by arrival.
    //
    // WHY (#T18): this list reorders itself from `lastActivityAt`, and two
    // agents working at once produce stamps that are equal or a millisecond
    // apart. With no tiebreak, Array.sort left them in whatever order the feed
    // last rebuilt the array in — so the rows swapped places on every update.
    // The group list had it worse: it was Map INSERTION order, i.e. the order
    // the first live session of each project happened to appear in, so whole
    // sections jumped. The feed's own rate limit stops most of the churn; this
    // makes the remaining updates land on the same arrangement instead of a
    // reshuffled one.
    // A stamp cannot describe activity that has not happened yet (#1055
    // review). Every stamp reaching here is in THIS device's time base — the
    // feed converts a server frame on arrival — so an overshoot is not skew
    // between two machines. It is this phone's own clock having been fast
    // when the row last emitted, and then corrected.
    //
    // Under a few seconds, that is transit and rounding: clamp and keep the
    // row where it is. Beyond it, the value says nothing about when that
    // agent last worked, and a QUIET row has no further event to retire it,
    // so it ranks as unknown rather than as the most recent thing on the
    // phone — which is what an hour-fast clock had made it, above everything
    // genuinely newer.
    const seenAt = (row: RemoteSessionSummary): number => {
      const at = row.lastActivityAt ?? 0
      if (at <= now) return at
      return at - now <= FUTURE_STAMP_TOLERANCE_MS ? now : 0
    }
    const byRecency = (a: RemoteSessionSummary, b: RemoteSessionSummary) =>
      seenAt(b) - seenAt(a)
      || a.sessionId.localeCompare(b.sessionId)
    const live = sessions.filter(s => s.alive)
    const exited = sessions.filter(s => !s.alive)
    const grouped = new Map<string, RemoteSessionSummary[]>()
    for (const session of live) {
      const name = session.tabTitle ?? workspaceName(session)
      const bucket = grouped.get(name)
      if (bucket) bucket.push(session)
      else grouped.set(name, [session])
    }
    for (const bucket of grouped.values()) {
      // Pinned first within the group, then recency — mirrors the desktop
      // dispatch list's ordering contract.
      bucket.sort((a, b) => {
        const pinDelta = Number(b.pinned ?? false) - Number(a.pinned ?? false)
        return pinDelta !== 0 ? pinDelta : byRecency(a, b)
      })
    }
    // The group with the most recent work first, ties broken by name. A group
    // keeps its place while its rows do.
    const groupOrder = [...grouped.entries()].sort(([nameA, rowsA], [nameB, rowsB]) => {
      const recencyA = Math.max(...rowsA.map(seenAt))
      const recencyB = Math.max(...rowsB.map(seenAt))
      // localeCompare is not a TOTAL order: two distinct strings can compare
      // equal (composed `café` and decomposed `café` do), and they stay
      // separate groups, so the arrangement would again depend on arrival
      // order. The code-unit comparison after it is the tiebreak that makes
      // this deterministic for every pair (#1055 review).
      return recencyB - recencyA || nameA.localeCompare(nameB) || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0)
    })
    return { grouped: groupOrder, exited: exited.sort(byRecency) }
  }, [sessions, clockTick])

  const peekSession = peek ? sessions.find(s => s.sessionId === peek.sessionId) ?? null : null
  const peekRecord: RemoteNoteRecord | null =
    peek && peekSession
      ? peek.kind === 'tldr'
        ? feed.getTldrRecord(peek.sessionId)
        : feed.getGoalRecord(peek.sessionId)
      : null

  const usageWorst = worstUsageSeverity(usage)

  return (
    <div className="app">
      <div className="topbar">
        <span className={`conn-dot ${connection}`} />
        <span className="title">Agents</span>
        {usageWorst && (
          <span className={`usage-chip ${usageWorst}`} title="Account usage">
            usage {usageWorst}
          </span>
        )}
        <button onClick={onUnpair}>unpair</button>
      </div>
      <div className="screen">
        {sessions.length === 0 ? (
          <div className="empty">
            {connection === 'open'
              ? 'No live sessions. Start an agent on the desktop and it appears here.'
              : 'Connecting to the desktop…'}
          </div>
        ) : (
          <div className="session-list">
            {groups.grouped.map(([tabName, rows]) => (
              <section key={tabName}>
                <div className="section-label">{tabName}</div>
                {rows.map(session => (
                  <FleetRow
                    key={session.sessionId}
                    session={session}
                    working={Boolean(activity[session.sessionId])}
                    tldrLine={firstLine(feed.getTldrRecord(session.sessionId)?.text)}
                    onSelect={onSelect}
                    onPeek={kind => setPeek({ sessionId: session.sessionId, kind })}
                  />
                ))}
              </section>
            ))}
            {groups.exited.length > 0 && (
              <section>
                <div className="section-label">exited</div>
                {groups.exited.map(session => (
                  <FleetRow
                    key={session.sessionId}
                    session={session}
                    working={false}
                    tldrLine={null}
                    onSelect={onSelect}
                    onPeek={() => {}}
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </div>
      {peek && peekSession && (
        <PeekOverlay
          kind={peek.kind}
          record={peekRecord}
          lastActiveAt={peekSession.lastActivityAt}
          onDismiss={() => setPeek(null)}
          onToggleKind={() =>
            setPeek(current =>
              current ? { ...current, kind: current.kind === 'tldr' ? 'goal' : 'tldr' } : current,
            )
          }
        />
      )}
    </div>
  )
}

function FleetRow({
  session,
  working,
  tldrLine,
  onSelect,
  onPeek,
}: {
  session: RemoteSessionSummary
  working: boolean
  tldrLine: string | null
  onSelect: (sessionId: string) => void
  onPeek: (kind: PeekKind) => void
}): React.JSX.Element {
  // Long-press = peek (hold-to-glance, the touch form of Cmd+L); tap =
  // open. A press that MOVES is a scroll and cancels; release before the
  // threshold is a tap. The ref pair + timer live here so each row owns
  // its own gesture, and the cleanup on unmount kills a pending timer.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const held = useRef(false)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const cancelHold = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }

  const badge = providerBadge(session.kind)
  const displayName =
    session.agentName ?? session.title ?? workspaceName(session)
  const pinned = session.pinned ?? false

  return (
    <button
      type="button"
      className={`session-row${pinned ? ' pinned' : ''}`}
      onClick={() => {
        if (held.current) {
          // The long-press already fired; this click is its release tail —
          // swallowing it prevents peek-dismiss from ALSO navigating.
          held.current = false
          return
        }
        onSelect(session.sessionId)
      }}
      onPointerDown={e => {
        origin.current = { x: e.clientX, y: e.clientY }
        timer.current = setTimeout(() => {
          held.current = true
          onPeek('tldr')
        }, LONG_PRESS_MS)
      }}
      onPointerMove={e => {
        if (!origin.current) return
        const dx = e.clientX - origin.current.x
        const dy = e.clientY - origin.current.y
        if (dx * dx + dy * dy > HOLD_SLOP_PX * HOLD_SLOP_PX) cancelHold()
      }}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onContextMenu={e => {
        // Long-press on touch emits a contextmenu on some browsers; the
        // peek already opened — suppress the menu, not the glance.
        e.preventDefault()
      }}
    >
      <span className={`marker${working ? ' working' : ''}`}>{badge.glyph}</span>
      <span className="meta">
        <span className="name">
          {displayName}
          {pinned ? <span className="pin-flag">pinned</span> : null}
          {typeof session.subAgentCount === 'number' && session.subAgentCount > 0 ? (
            <span className="kind">+{session.subAgentCount}</span>
          ) : null}
        </span>
        {tldrLine ? <span className="tldr-line">{tldrLine}</span> : null}
        <span className="cwd">{session.cwd ?? session.sessionId}</span>
      </span>
      <span className={`status${!session.alive ? ' dead' : working ? ' active' : ''}`}>
        {!session.alive
          ? 'exited'
          : session.providerRuntime === 'terminal'
            ? 'tui'
            : working
              ? 'working'
              : relativeShort(session.lastActivityAt)}
      </span>
    </button>
  )
}

/** The identity a human recognizes when no projection title exists: the
 *  workspace directory's basename, v1's rule — kept as the FALLBACK only. */
function workspaceName(session: RemoteSessionSummary): string {
  if (!session.cwd) return session.sessionId.slice(0, 8)
  const parts = session.cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? session.cwd
}

function firstLine(text: string | undefined): string | null {
  if (!text) return null
  const line = text.split('\n', 1)[0]?.trim()
  return line ? line : null
}

/** The worst provider status on the snapshot — one chip, honest wording. */
function worstUsageSeverity(snapshot: UsageSnapshot | null): string | null {
  if (!snapshot) return null
  let worst: string | null = null
  const rank: Record<string, number> = { normal: 0, unknown: 0, warning: 1, critical: 2 }
  for (const provider of snapshot.providers) {
    if (provider.status !== 'ok') continue
    for (const row of provider.rows) {
      if (worst === null || (rank[row.severity] ?? 0) > (rank[worst] ?? 0)) {
        worst = row.severity
      }
    }
  }
  return worst && worst !== 'normal' && worst !== 'unknown' ? worst : null
}
