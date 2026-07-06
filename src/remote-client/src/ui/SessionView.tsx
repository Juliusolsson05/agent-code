import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { Feed } from '@renderer/features/feed/ui/Feed'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import {
  conditionStateByKind,
  type ClaudeAskUserQuestionState,
} from '@shared/types/providerConditions'
import { isAgentProviderKind } from '@shared/types/providerKind'

import type { WebSocketSessionFeed, ConnectionState } from '../WebSocketSessionFeed'
import type { TranscriptStore } from '../transcript/store'

// One session, desktop-grade: this mounts the REAL desktop Feed component
// (see the alias table in ../vite.config.ts — the phone renders the same
// component tree the desktop does, with four documented stub
// substitutions), driven by the TranscriptStore's minimal SessionRuntime.
//
// The prop mapping below mirrors TileLeaf.tsx:475-573, the desktop's own
// runtime→Feed contract, minus the deliberately skipped subsystems
// (ghosts, pickers, reader/tail modes — see the semantic-rendering design
// doc). When TileLeaf's mapping changes, this file is the phone-side
// mirror to revisit.
//
// SessionFeedProvider wraps the tree because feed rows resolve their
// session I/O through useSessionFeed (AskUserQuestionRow answers questions
// through it) — the phone's WebSocketSessionFeed IS a SessionFeed, so the
// rows work unmodified over the WS transport.

type ConditionAction =
  | { kind: 'pty'; id: string; label: string; data: string }
  | { kind: 'custom'; id: string; label: string; name: string; payload?: unknown }

type LiveCondition = {
  conditionKind: string
  actions: ConditionAction[]
}

export function SessionView({
  feed,
  store,
  connection,
  sessionId,
  onBack,
}: {
  feed: WebSocketSessionFeed
  store: TranscriptStore
  connection: ConnectionState
  sessionId: string
  onBack: () => void
}): React.JSX.Element {
  const subscribe = useCallback(
    (cb: () => void) => store.subscribe(sessionId, cb),
    [store, sessionId],
  )
  const transcript = useSyncExternalStore(subscribe, () => store.getSnapshot(sessionId))

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Backfill on first view of a session — the live stream only covers
  // what happened after the phone connected.
  useEffect(() => {
    void store.loadInitialHistory(sessionId)
  }, [store, sessionId])

  const listedKind = feed.getSessionList().find(s => s.sessionId === sessionId)?.kind
  const provider = listedKind && isAgentProviderKind(listedKind) ? listedKind : 'claude'

  const askUserQuestionState = useMemo(
    () =>
      transcript.conditions
        ? (conditionStateByKind<ClaudeAskUserQuestionState>(
            transcript.conditions,
            'claude.ask-user-question',
          ) ?? null)
        : null,
    [transcript.conditions],
  )

  // Non-AUQ conditions keep the phone's tap-target bar (AUQ renders inline
  // in the feed via AskUserQuestionRow, same as desktop). The desktop
  // shows these as modals/outlets; big buttons are the mobile equivalent.
  const tapConditions = useMemo<LiveCondition[]>(() => {
    const snapshot = transcript.conditions
    if (!snapshot) return []
    // Object.values over the partial Record types members as possibly
    // undefined; the flatMap narrows instead of asserting.
    return Object.values(snapshot.conditions).flatMap(record => {
      if (!record || record.kind === 'claude.ask-user-question') return []
      const actions = (record.actions ?? []) as ConditionAction[]
      if (actions.length === 0) return []
      return [{ conditionKind: record.kind, actions }]
    })
  }, [transcript.conditions])

  const sendPrompt = useCallback(() => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    void feed
      .deliverPrompt(sessionId, text)
      .then(result => {
        if (!result.ok) {
          setError(result.message)
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

  const working = transcript.workingStatus

  return (
    <SessionFeedProvider value={feed}>
      <div className="app">
        <div className="topbar">
          <button onClick={onBack}>‹ Back</button>
          <span className={`conn-dot ${connection}`} />
          <span className="title mono">{sessionId.slice(0, 8)}</span>
        </div>

        <div className="feed-host">
          <Feed
            sessionId={sessionId}
            provider={provider}
            entries={transcript.entries}
            streamPhase={transcript.streamPhase}
            streamPhasePendingToolName={transcript.streamPhasePendingToolName}
            streamPhasePendingToolUseId={transcript.streamPhasePendingToolUseId}
            turnStartedAt={transcript.turnStartedAt}
            semanticTurn={transcript.semanticTurn}
            semanticHistory={transcript.semanticHistory}
            toolUseIndex={transcript.toolUseIndex}
            toolResultIndex={transcript.toolResultIndex}
            toolIndexVersion={transcript.toolIndexVersion}
            askUserQuestionState={askUserQuestionState}
            hasOlderHistory={transcript.hasOlderHistory}
            loadingOlderHistory={transcript.loadingOlderHistory}
            onLoadOlderHistory={() => store.loadOlderHistory(sessionId)}
          />
        </div>

        {working && <div className="working">● {working}</div>}

        {tapConditions.length > 0 && (
          <div className="conditions">
            {tapConditions.map(condition => (
              <div key={condition.conditionKind}>
                <div className="prompt-title">{titleFor(condition.conditionKind)}</div>
                <div className="actions">
                  {condition.actions.map(action => (
                    <button
                      key={`${condition.conditionKind}:${action.id}`}
                      onClick={() => runAction(action)}
                    >
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
          <button disabled={!draft.trim() || sending || transcript.exited} onClick={sendPrompt}>
            {sending ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </SessionFeedProvider>
  )
}

/** Human titles for condition kinds surfaced as tap bars. Unknown kinds
 *  fall back to the raw kind string — better an ugly label than a hidden
 *  prompt the agent is blocked on. */
function titleFor(kind: string): string {
  const titles: Record<string, string> = {
    'claude.permission-prompt': 'Permission requested',
    'claude.trust-dialog': 'Trust this folder?',
    'claude.resume-prompt': 'Resume session?',
    'codex.approval': 'Approval requested',
    'codex.trust-dialog': 'Trust this folder?',
  }
  return titles[kind] ?? kind
}
