import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { Feed } from '@renderer/features/feed/ui/Feed'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { useLedgerFeedItems } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { ComposerInput } from '@renderer/workspace/tile-tree/TileLeaf/ComposerInput'
import { useComposerAutoGrow } from '@renderer/workspace/tile-tree/TileLeaf/useComposerAutoGrow'
import type { RuntimeRenderInput } from '@renderer/session-runtime/state'
import type { GhostEntry } from 'agent-transcript-parser/ghost'
import { conditionStateByKind } from '@shared/types/providerConditions'
import type { ClaudeAskUserQuestionState } from '@shared/types/providerConditions'

import { ConditionOutlet } from '@shared/conditions-core/ConditionOutlet'
import type { ConditionAction, ConditionSnapshot } from '@shared/conditions-core/contract'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

import type { WebSocketSessionFeed, ConnectionState } from '../WebSocketSessionFeed'
import type { TranscriptStore } from '../transcript/store'
import { useMobileDictation } from '../dictation/mobileDictation'

// The phone has no optimistic-echo plane: it renders committed + semantic
// state streamed from the desktop, never a locally-minted ghost (see the
// "deliberately skipped subsystems" note below). A single frozen empty map
// keeps the ledger's ghost plane cache stable across renders — a fresh map
// each render would defeat the adapter's by-reference plane memoization.
const NO_GHOSTS: ReadonlyMap<string, GhostEntry> = new Map()

export type MobileComposerState = {
  draft: string
  sending: boolean
  deliveryUncertain: boolean
  error: string | null
}

export const EMPTY_MOBILE_COMPOSER_STATE: MobileComposerState = {
  draft: '',
  sending: false,
  deliveryUncertain: false,
  error: null,
}

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

export function SessionView({
  feed,
  store,
  connection,
  sessionId,
  token,
  onBack,
  composerState,
  updateComposerState,
}: {
  feed: WebSocketSessionFeed
  store: TranscriptStore
  connection: ConnectionState
  sessionId: string
  /** The device token — sent as the Authorization bearer on /dictate. */
  token: string
  onBack: () => void
  composerState: MobileComposerState
  updateComposerState: (
    updater: (current: MobileComposerState) => MobileComposerState,
  ) => void
}): React.JSX.Element {
  const subscribe = useCallback(
    (cb: () => void) => store.subscribe(sessionId, cb),
    [store, sessionId],
  )
  const transcript = useSyncExternalStore(subscribe, () => store.getSnapshot(sessionId))

  const { draft, sending, deliveryUncertain, error } = composerState
  // Delivery state lives in App, not this navigable screen. An unsafe result
  // must keep blocking resend after Back → reopen, and an in-flight promise
  // must still publish its verdict after this component unmounts.
  const setDraft = useCallback((next: string | ((current: string) => string)) => {
    updateComposerState(current => ({
      ...current,
      draft: typeof next === 'function' ? next(current.draft) : next,
    }))
  }, [updateComposerState])
  const setError = useCallback((next: string | null) => {
    updateComposerState(current => ({ ...current, error: next }))
  }, [updateComposerState])
  // The session's cwd for the real PaneHeader title strip. Self-subscribed
  // here rather than threaded App→SessionList so the header stays
  // self-contained; cwd is effectively static per session, but onSessionList
  // also covers the race where the list arrives after this view mounts.
  const [cwd, setCwd] = useState<string | null>(
    () => feed.getSessionList().find(s => s.sessionId === sessionId)?.cwd ?? null,
  )

  // The composer's textarea ref, auto-grown by the desktop hook (pure DOM,
  // reused verbatim) so the mounted ComposerInput shell reflows exactly like
  // the desktop as the draft wraps.
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useComposerAutoGrow(inputRef, draft)

  // Backfill on first view of a session — the live stream only covers
  // what happened after the phone connected.
  useEffect(() => {
    void store.loadInitialHistory(sessionId)
  }, [store, sessionId])

  useEffect(() => {
    const off = feed.onSessionList(list => {
      const summary = list.find(s => s.sessionId === sessionId)
      if (summary) setCwd(summary.cwd ?? null)
    })
    return off
  }, [feed, sessionId])

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
  const ledgerFeedPlan = useLedgerFeedItems(runtimeView, provider, sessionId, {
    toolUseIndex: transcript.toolUseIndex,
    toolResultIndex: transcript.toolResultIndex,
    version: transcript.toolIndexVersion,
  })

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

  const sendPrompt = useCallback(() => {
    const submittedDraft = draft
    const text = submittedDraft.trim()
    if (!text || sending || deliveryUncertain) return
    updateComposerState(current => ({ ...current, sending: true, error: null }))
    void feed
      .deliverPrompt(sessionId, text)
      .then(result => {
        if (!result.ok) {
          updateComposerState(current => ({
            ...current,
            deliveryUncertain: !result.retrySafe,
            error: !result.retrySafe
              ? `${result.message}. It may already be submitted; resend is blocked.`
              : result.message,
          }))
          return
        }
        updateComposerState(current => ({
          ...current,
          deliveryUncertain: false,
          // Whitespace is user input too. Comparing normalized transport text
          // erased next-draft whitespace edits made during acknowledgement.
          draft: current.draft === submittedDraft ? '' : current.draft,
        }))
      })
      .finally(() => updateComposerState(current => ({ ...current, sending: false })))
  }, [deliveryUncertain, draft, feed, sending, sessionId, updateComposerState])

  const interrupt = useCallback(() => {
    void feed.sendInput(sessionId, '\x1b').then(ok => {
      if (!ok) setError('Interrupt failed.')
    })
  }, [feed, sessionId])

  // Phone composer key handling. Enter submits; Shift+Enter inserts a newline
  // (native — we don't preventDefault); Esc interrupts. These are the only
  // shapes the v1 wire accepts. Slash-command escapes and image paste are
  // deliberately absent (out of scope — they'd need the wire to widen). This
  // matters mainly for an external keyboard paired to a phone/tablet; the
  // on-screen Send/Stop buttons cover pure-touch use.
  const onComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendPrompt()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        interrupt()
      }
    },
    [sendPrompt, interrupt],
  )

  // Server-declared STT capability from the WS hello. Self-subscribed (same
  // pattern as cwd above) because the hello lands asynchronously after the
  // socket opens — a mount-time read alone could permanently miss the
  // verdict. Drives the mic's disabled state so a desktop with no Deepgram
  // key disables dictation up front instead of failing after the user has
  // already recorded and uploaded.
  const [sttAvailable, setSttAvailable] = useState<boolean | null>(() =>
    feed.getSttAvailability(),
  )
  useEffect(() => feed.onSttAvailability(setSttAvailable), [feed])

  // Voice dictation. Feeds the real ComposerInput shell's dictation slot (so
  // the activity meter lights up while recording) AND the tap mic button
  // below. The transcript comes back <stt>-wrapped from the server; append it
  // to the draft on its own line so it reads as a distinct dictated segment.
  const dictation = useMobileDictation({
    token,
    sttAvailable,
    onTranscript: text => setDraft(prev => (prev ? `${prev}\n${text}` : text)),
    onError: setError,
  })

  // The dispatch the generic ConditionOutlet drives. Same routing the old
  // hand-rolled tap-bar used (pty -> structured replyWithPtyAction, custom ->
  // resolveCondition), just expressed as the (action) => Promise<void> the
  // core outlet expects. WHY the STRUCTURED replyWithPtyAction and not a raw
  // sendInput: the phone wire refuses arbitrary bytes, and the pty reply must
  // carry the action's own {id,label,data} so the desktop can verify it
  // against the live condition menu — which is exactly why we mount the core
  // ConditionOutlet directly and NOT ProviderConditionOutlet (its
  // makeDispatchFromOnSend collapses the action to bytes and throws the id
  // away). The error branches differ by result shape: pty replies carry
  // `error`, custom resolutions carry `failedAtStep`.
  const dispatch = useCallback(
    async (action: ConditionAction): Promise<void> => {
      setError(null)
      if (action.kind === 'pty') {
        const r = await feed.replyWithPtyAction(sessionId, action)
        if (!r.ok) setError(r.error ?? 'Action failed — it may have expired.')
      } else {
        const r = await feed.resolveCondition(sessionId, action)
        if (!r.ok) setError(r.failedAtStep ?? 'Action failed — it may have expired.')
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
        </div>
        {/* The REAL desktop pane header (provider badge + shortened cwd) in
            place of the old 8-char session id. Kept as its own bar below the
            phone's Back/conn nav — on desktop this IS the pane's top bar.
            statusMode off (a multi-pane-grid glance affordance, meaningless on
            a single phone screen) and related-agent chips empty (the v1 wire
            emits no sub-agent data).

            sessionId feeds the header's color-flag chunk. On the phone that
            always resolves to "no flag": the store is the frozen
            DEFAULT_SETTINGS snapshot from src/stubs/appStateHooks, whose
            dispatchColorFlags is `{}`, and the v1 wire carries no settings.
            It is still passed honestly rather than stubbed out, so that if the
            phone ever syncs real settings the flag appears with no edit here —
            and so a reader does not have to wonder which sessionId the header
            would have used. */}
        <PaneHeader
          sessionId={sessionId}
          paneLabel={provider}
          projectDir={cwd}
          statusMode={false}
          isSessionLive={Boolean(working) || !transcript.exited}
          relatedAgentTabs={[]}
        />

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
            renderItemsOverride={ledgerFeedPlan.items}
            committedOperationDecisionOverride={ledgerFeedPlan.resolveOperation}
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

        {/* The REAL desktop condition rendering. The generic core outlet routes
            the live snapshot through the provider's own conditionViews registry
            (Claude/Codex permission, trust, approval, AskUserQuestion views) —
            the exact components the desktop draws — instead of the old flat
            label+button bar. It also preserves the old "guaranteed fallback"
            property the hand-rolled bar had: it is snapshot-driven, so even if
            the feed's inline AskUserQuestionRow is mid-stream or malformed, the
            outlet still shows real, server-verified action buttons. The `.conditions`
            wrapper keeps the phone's sticky-above-composer placement. */}
        {transcript.conditions && (
          <div className="conditions">
            <ConditionOutlet
              snapshot={transcript.conditions as ConditionSnapshot}
              registry={getRendererProviderCapabilities(transcript.conditions.provider).conditionViews}
              dispatch={dispatch}
              // The phone renders exactly one selected SessionView, unlike the
              // desktop's split-pane tree. Its inline condition is therefore
              // always the active keyboard owner while this view is mounted.
              interactionActive
            />
          </div>
        )}

        {error && <div className="working" style={{ color: 'var(--danger)' }}>
          {error}
          {deliveryUncertain ? (
            <button type="button" onClick={() => {
              updateComposerState(current => ({
                ...current,
                deliveryUncertain: false,
                error: null,
              }))
            }}>
              I verified the transcript — allow sending again
            </button>
          ) : null}
        </div>}

        {/* The REAL desktop composer shell — pixel-identical ❯ chevron,
            focus-accent border, auto-grow, dictation slot. Driven by a phone
            controller: local draft state, Enter/Shift+Enter/Esc key handling,
            and (until Task 6) a disabled dictation controller. Slash picker and
            image strip are inert via props (pickerState=null, draftImages=[]).
            The Send/Stop buttons below are a touch affordance the desktop
            (Enter-to-send) doesn't need but a phone does. */}
        <div className="composer">
          <ComposerInput
            sessionId={sessionId}
            inputRef={inputRef}
            input={draft}
            focused={true}
            slashMode={false}
            provider={provider}
            draftImages={[]}
            pickerState={null}
            historyIndex={null}
            history={[]}
            setInputText={setDraft}
            endHistoryCycle={() => {}}
            onKeyDown={onComposerKeyDown}
            onPaste={() => {}}
            onFocusRequest={() => {}}
            onUserEngagement={() => {}}
            onHoverChange={() => {}}
            removeDraftImage={() => {}}
            dictation={dictation}
            promptSuggestion={null}
            onApplySuggestion={() => {}}
            onDismissSuggestion={() => {}}
            promptDelivery={deliveryUncertain
              ? {
                  kind: 'uncertain',
                  prompt: draft,
                  message: error ?? 'Delivery uncertain',
                  failedAt: Date.now(),
                  // The remote protocol does not forward main's write
                  // evidence, so the phone client genuinely cannot tell
                  // "submitted but unconfirmed" from "never submitted".
                  // null keeps the banner on its cautious wording instead
                  // of letting the client fabricate a claim.
                  enterWritten: null,
                }
              : { kind: 'idle' }}
            onResolveUncertainDelivery={() => {
              updateComposerState(current => ({
                ...current,
                deliveryUncertain: false,
                error: null,
              }))
            }}
          />
          <div className="composer-actions">
            {/* Explicit tap mic button — the desktop starts dictation from the
                Fn hotkey, which a phone has no equivalent for. Tap to record,
                tap again to stop → transcribe → append. Disabled during the
                transient start/stop transitions (so a double-tap can't race
                the recorder) AND when the controller says dictation can't
                work at all — insecure LAN origin (getUserMedia needs a secure
                context) or no STT key on the desktop. In the disabled states
                the controller's label carries the full reason, surfaced here
                as title/aria-label so the mic explains itself instead of
                fake-failing with a permission error (review finding). */}
            <button
              type="button"
              className={`mic${dictation.status === 'recording' ? ' recording' : ''}`}
              onClick={dictation.toggle}
              disabled={
                !dictation.enabled ||
                dictation.status === 'starting' ||
                dictation.status === 'stopping'
              }
              aria-label={
                !dictation.enabled
                  ? dictation.label
                  : dictation.status === 'recording'
                    ? 'Stop recording'
                    : 'Dictate'
              }
              title={dictation.label}
            >
              {dictation.status === 'recording'
                ? '⏺'
                : dictation.status === 'starting' || dictation.status === 'stopping'
                  ? '…'
                  : '🎤'}
            </button>
            {working ? (
              <button className="stop" onClick={interrupt}>
                Stop
              </button>
            ) : null}
            <button disabled={!draft.trim() || sending || deliveryUncertain || transcript.exited} onClick={sendPrompt}>
              {sending ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </SessionFeedProvider>
  )
}
