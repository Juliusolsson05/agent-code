import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { Feed } from '@renderer/features/feed/ui/Feed'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { useLedgerFeedItems } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import type { RuntimeRenderInput } from '@renderer/session-runtime/state'
import type { GhostEntry } from 'agent-transcript-parser/ghost'
import {
  conditionStateByKind,
  type ClaudeAskUserQuestionState,
} from '@shared/types/providerConditions'

import type { WebSocketSessionFeed, ConnectionState } from '../WebSocketSessionFeed'
import type { TranscriptStore } from '../transcript/store'

// The phone has no optimistic-echo plane: it renders committed + semantic
// state streamed from the desktop, never a locally-minted ghost (see the
// "deliberately skipped subsystems" note below). A single frozen empty map
// keeps the ledger's ghost plane cache stable across renders — a fresh map
// each render would defeat the adapter's by-reference plane memoization.
const NO_GHOSTS: ReadonlyMap<string, GhostEntry> = new Map()

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

  const provider = store.getKind(sessionId)

  // Stage 3 cutover: the phone paints from the SAME ownership-ledger pipeline
  // the desktop does. It used to rely on Feed's legacy deriveFeedRenderModel
  // path (the only remaining consumer of it after the desktop flip); that
  // path is deleted, so the phone must produce renderItemsOverride too. The
  // ledger takes the DECLARED RuntimeRenderInput contract (#493 PR-2), so
  // this view is honestly typed — the old `as unknown as SessionRuntime`
  // cast over a fabricated partial object is gone; `semantic` is the store's
  // REAL fold state. Only entries + semantic + phase differ across renders;
  // ghosts is the frozen empty map (no optimistic plane on the phone) and
  // lastJsonlEntryAt is irrelevant with no ghosts to invalidate.
  //
  // Memo deps stay the scalar mirrors (semanticTurn/semanticHistory), NOT
  // transcript.semantic: the fold object also changes reference on
  // flows/log-only updates, and re-firing on those would recompute the
  // pipeline more often than the desktop does for the same stream.
  const runtimeView = useMemo(
    (): RuntimeRenderInput => ({
      entries: transcript.entries,
      semantic: transcript.semantic,
      ghosts: NO_GHOSTS,
      streamPhase: transcript.phase.streamPhase,
      streamPhasePendingToolName: transcript.phase.streamPhasePendingToolName,
      streamPhasePendingToolUseId: transcript.phase.streamPhasePendingToolUseId,
      lastJsonlEntryAt: 0,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
    [
      transcript.entries,
      transcript.semanticTurn,
      transcript.semanticHistory,
      transcript.phase.streamPhase,
      transcript.phase.streamPhasePendingToolName,
      transcript.phase.streamPhasePendingToolUseId,
    ],
  )
  const ledgerFeedItems = useLedgerFeedItems(runtimeView, provider, sessionId)

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

  // EVERY live condition renders in the tap-target bar — including
  // AskUserQuestion, even though the feed also renders it inline via
  // AskUserQuestionRow. WHY the redundancy is deliberate (review finding):
  // the inline row depends on the transcript pipeline having delivered a
  // parseable AUQ block; when the input is still streaming, malformed, or
  // the backfill raced, the row shows a placeholder with no buttons and the
  // agent sits blocked with no answer path. The snapshot-driven bar is the
  // guaranteed fallback — its actions are server-verified against the live
  // condition's own menu, so a duplicated affordance is safe; a hidden
  // prompt is not.
  const tapConditions = useMemo<LiveCondition[]>(() => {
    const snapshot = transcript.conditions
    if (!snapshot) return []
    // Object.values over the partial Record types members as possibly
    // undefined; the flatMap narrows instead of asserting.
    return Object.values(snapshot.conditions).flatMap(record => {
      if (!record) return []
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

        {/* Pre-transcript fallback: states that never reach the jsonl/
            semantic channels (trust dialog body, login prompts, provider
            crash output) exist ONLY as TUI text. Render it until the feed
            has real content — dropping this entirely made a fresh session's
            trust dialog a blank page (review finding). */}
        {transcript.entries.length === 0 &&
        !transcript.semanticTurn &&
        transcript.screenText ? (
          <div className="screen">
            {transcript.historyError && (
              <div className="working" style={{ color: 'var(--danger)' }}>
                Rich transcript unavailable ({transcript.historyError}) — showing
                raw terminal. The desktop app may need an update/restart.
              </div>
            )}
            <pre className="terminal">{transcript.screenText}</pre>
          </div>
        ) : (
        <div className="feed-host">
          <Feed
            sessionId={sessionId}
            provider={provider}
            renderItemsOverride={ledgerFeedItems}
            entries={transcript.entries}
            streamPhase={transcript.phase.streamPhase}
            streamPhasePendingToolName={transcript.phase.streamPhasePendingToolName}
            streamPhasePendingToolUseId={transcript.phase.streamPhasePendingToolUseId}
            turnStartedAt={transcript.phase.turnStartedAt}
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
        )}

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
    'claude.ask-user-question': 'The agent has a question',
    'codex.approval': 'Approval requested',
    'codex.trust-dialog': 'Trust this folder?',
  }
  return titles[kind] ?? kind
}
