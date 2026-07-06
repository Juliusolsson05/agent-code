import { useCallback, useEffect, useRef, useState } from 'react'

import type { WebSocketSessionFeed, ConnectionState } from '../WebSocketSessionFeed'

// One session, full control: live output, condition prompts as tap targets,
// and a composer.
//
// v1 renders the provider's own TUI text (the `screen` channel's `recent`
// window) rather than mounting the desktop's semantic feed components. That
// is a deliberate first slice, not the end state: the screen text is always
// CORRECT (it is literally what the agent shows), needs zero transcript
// state, and survives any provider change. The semantic React feed — the
// product's real rendering — layers on next, once the jsonl/semantic
// channels get a history-request message; tracked in the phase-1 plan notes.
//
// Condition actions: every action offered by every live condition renders
// as a button. pty actions go through replyWithPtyAction (the server
// verifies them against the live snapshot's own menu); custom actions go
// through resolveCondition. The phone never composes keystrokes.

type ConditionAction =
  | { kind: 'pty'; id: string; label: string; data: string }
  | { kind: 'custom'; id: string; label: string; name: string; payload?: unknown }

type LiveCondition = {
  conditionKind: string
  actions: ConditionAction[]
}

export function SessionView({
  feed,
  connection,
  sessionId,
  onBack,
}: {
  feed: WebSocketSessionFeed
  connection: ConnectionState
  sessionId: string
  onBack: () => void
}): React.JSX.Element {
  const [screenText, setScreenText] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [conditions, setConditions] = useState<LiveCondition[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    const offScreen = feed.onSessionScreen(e => {
      if (e.sessionId !== sessionId) return
      // `recent` (viewport + ~200 rows of scrollback) over `plain`: phones
      // scroll; the wider window is what makes that scroll useful.
      setScreenText(e.recent)
    })
    const offProcess = feed.onSessionProcessState(e => {
      if (e.sessionId !== sessionId) return
      setWorking(e.active ? (e.status ?? 'Working') : null)
    })
    const offConditions = feed.onSessionConditions(e => {
      if (e.sessionId !== sessionId) return
      const snapshot = (e as unknown as {
        snapshot?: { conditions?: Record<string, { kind: string; actions?: ConditionAction[] }> }
      }).snapshot
      const live = Object.values(snapshot?.conditions ?? {})
        .filter(record => (record.actions ?? []).length > 0)
        .map(record => ({ conditionKind: record.kind, actions: record.actions ?? [] }))
      setConditions(live)
    })
    return () => {
      offScreen()
      offProcess()
      offConditions()
    }
  }, [feed, sessionId])

  // Stick to the bottom while the user hasn't scrolled away — same tail
  // behaviour as the desktop feed, minimal version.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [screenText])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  const sendPrompt = useCallback(() => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    void feed
      .deliverPrompt(sessionId, text)
      .then(async result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        // Prompt text lands in the provider's composer via bracketed paste;
        // the explicit submit is the Enter press. Two frames on purpose —
        // it mirrors the desktop's paste-then-submit discipline.
        const submitted = await feed.sendInput(sessionId, '\r')
        if (!submitted) {
          setError('Prompt staged but submit failed — press send again.')
          return
        }
        setDraft('')
      })
      .finally(() => setSending(false))
  }, [draft, feed, sending, sessionId])

  const interrupt = useCallback(() => {
    void feed.sendInput(sessionId, '\x1b').then(ok => {
      if (!ok) setError('Interrupt failed.')
    })
  }, [feed, sessionId])

  const runAction = useCallback(
    (action: ConditionAction) => {
      setError(null)
      const done = (ok: boolean, detail?: string): void => {
        if (!ok) setError(detail ?? 'Action failed — it may have expired.')
      }
      if (action.kind === 'pty') {
        void feed.replyWithPtyAction(sessionId, action).then(r => done(r.ok, r.error))
      } else {
        void feed
          .resolveCondition(sessionId, action)
          .then(r => done(r.ok, r.ok ? undefined : r.failedAtStep))
      }
    },
    [feed, sessionId],
  )

  return (
    <div className="app">
      <div className="topbar">
        <button onClick={onBack}>‹ Back</button>
        <span className={`conn-dot ${connection}`} />
        <span className="title mono">{sessionId.slice(0, 8)}</span>
      </div>

      <div className="screen" ref={scrollRef} onScroll={onScroll}>
        <pre className="terminal">{screenText || 'Waiting for output…'}</pre>
      </div>

      {working && <div className="working">● {working}</div>}

      {conditions.length > 0 && (
        <div className="conditions">
          {conditions.map(condition => (
            <div key={condition.conditionKind}>
              <div className="prompt-title">{titleFor(condition.conditionKind)}</div>
              <div className="actions">
                {condition.actions.map(action => (
                  <button key={`${condition.conditionKind}:${action.id}`} onClick={() => runAction(action)}>
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="working" style={{ color: 'var(--danger)' }}>{error}</div>}

      <div className="composer">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Prompt the agent…"
          rows={1}
        />
        {working ? (
          <button className="stop" onClick={interrupt}>
            Stop
          </button>
        ) : null}
        <button disabled={!draft.trim() || sending} onClick={sendPrompt}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/** Human titles for the condition kinds v1 phones encounter. Unknown kinds
 *  fall back to the raw kind string — better an ugly label than a hidden
 *  prompt the agent is blocked on. */
function titleFor(kind: string): string {
  const titles: Record<string, string> = {
    'claude.permission-prompt': 'Permission requested',
    'claude.trust-dialog': 'Trust this folder?',
    'claude.resume-prompt': 'Resume session?',
    'claude.ask-user-question': 'The agent has a question',
    'codex.approval': 'Approval requested',
    'codex.trust-dialog': 'Trust this folder?',
  }
  return titles[kind] ?? kind
}
