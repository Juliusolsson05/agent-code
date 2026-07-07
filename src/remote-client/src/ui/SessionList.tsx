import { useEffect, useMemo, useState } from 'react'

import type { WebSocketSessionFeed, ConnectionState } from '../WebSocketSessionFeed'
import type { RemoteSessionSummary } from '../wire'

// The picker: every agent on the Mac, most-recently-active first, with
// enough identity per row to choose confidently — workspace name (big),
// full path (small), provider badge, live working state, and recency.
// Dead sessions sink to a separate section instead of interleaving; a
// session you can't talk to should never outrank one you can.

export function SessionList({
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
  // Re-render each half-minute so the relative "2m ago" labels don't rot
  // while the screen sits open. Cheap: the list is small by construction.
  const [, setClockTick] = useState(0)

  useEffect(() => {
    const offList = feed.onSessionList(setSessions)
    const offProcess = feed.onSessionProcessState(e => {
      setActivity(prev =>
        prev[e.sessionId] === e.active ? prev : { ...prev, [e.sessionId]: e.active },
      )
    })
    const timer = window.setInterval(() => setClockTick(t => t + 1), 30_000)
    return () => {
      offList()
      offProcess()
      window.clearInterval(timer)
    }
  }, [feed])

  const { live, exited } = useMemo(() => {
    const byRecency = (a: RemoteSessionSummary, b: RemoteSessionSummary) =>
      (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    return {
      live: sessions.filter(s => s.alive).sort(byRecency),
      exited: sessions.filter(s => !s.alive).sort(byRecency),
    }
  }, [sessions])

  const row = (session: RemoteSessionSummary): React.JSX.Element => {
    const working = session.alive && activity[session.sessionId]
    return (
      <button
        key={session.sessionId}
        className="session-row"
        onClick={() => onSelect(session.sessionId)}
      >
        <span className={`marker ${working ? 'working' : ''}`}>❯</span>
        <span className="meta">
          <span className="name">
            {workspaceName(session)}
            <span className="kind">{session.kind}</span>
          </span>
          <span className="cwd">{session.cwd ?? session.sessionId}</span>
        </span>
        <span className={`status ${!session.alive ? 'dead' : working ? 'active' : ''}`}>
          {!session.alive ? 'exited' : working ? 'working' : relativeTime(session.lastActivityAt)}
        </span>
      </button>
    )
  }

  return (
    <div className="app">
      <div className="topbar">
        <span className={`conn-dot ${connection}`} />
        <span className="title">Agents</span>
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
            {live.map(row)}
            {exited.length > 0 && (
              <>
                <div className="section-label">exited</div>
                {exited.map(row)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The identity a human recognizes: the workspace directory's basename.
 *  Falls back to a shortened session id when cwd never resolved. */
function workspaceName(session: RemoteSessionSummary): string {
  if (!session.cwd) return session.sessionId.slice(0, 8)
  const parts = session.cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? session.cwd
}

function relativeTime(epochMs: number | null): string {
  if (!epochMs) return 'idle'
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
