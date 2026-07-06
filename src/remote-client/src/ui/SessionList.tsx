import { useEffect, useState } from 'react'

import type { WebSocketSessionFeed, ConnectionState } from '../WebSocketSessionFeed'
import type { RemoteSessionSummary } from '../wire'

// All sessions on the Mac, one tap from control. Activity dots come from
// process-state events (the same signal the desktop's spinner rides), so
// "which agent needs me" is answerable from the lock screen in one glance.

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

  useEffect(() => {
    const offList = feed.onSessionList(setSessions)
    const offProcess = feed.onSessionProcessState(e => {
      setActivity(prev =>
        prev[e.sessionId] === e.active ? prev : { ...prev, [e.sessionId]: e.active },
      )
    })
    return () => {
      offList()
      offProcess()
    }
  }, [feed])

  return (
    <div className="app">
      <div className="topbar">
        <span className={`conn-dot ${connection}`} />
        <span className="title">Agents</span>
        <button onClick={onUnpair}>Unpair</button>
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
            {sessions.map(session => (
              <button
                key={session.sessionId}
                className="session-row"
                onClick={() => onSelect(session.sessionId)}
              >
                <span className="kind">{session.kind}</span>
                <span className="meta">
                  <span className="cwd">{session.cwd ?? session.sessionId}</span>
                </span>
                <span
                  className={`status ${
                    !session.alive ? 'dead' : activity[session.sessionId] ? 'active' : ''
                  }`}
                >
                  {!session.alive
                    ? 'exited'
                    : activity[session.sessionId]
                      ? '● working'
                      : 'idle'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
