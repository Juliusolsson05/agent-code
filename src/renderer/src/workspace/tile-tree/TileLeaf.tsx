import { conditionStateByKind } from '@shared/types/providerConditions'
import type { ClaudeAskUserQuestionState } from '@shared/types/providerConditions'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { Feed } from '@renderer/features/feed/ui/Feed'
import type { ScrollInfo } from '@renderer/features/feed/ui/Feed'
import { ProviderConditionOutlet } from '@providers/shared/renderer/conditions/ProviderConditionOutlet'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { SessionRuntime, Workspace } from '@renderer/workspace/workspaceStore'
import type { GridRelatedAgentTab } from '@renderer/workspace/gridRelatedAgents'
import {
  selectMergedEntries,
} from '@renderer/session-runtime/mergedEntries'
import type { SessionId } from '@renderer/workspace/types'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { QueueStrip } from '@renderer/workspace/tile-tree/TileLeaf/QueueStrip'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { ScrollIndicator } from '@renderer/workspace/tile-tree/TileLeaf/ScrollIndicator'
import { ComposerInput } from '@renderer/workspace/tile-tree/TileLeaf/ComposerInput'
import { ComposerActions } from '@renderer/workspace/tile-tree/TileLeaf/ComposerActions'
import { useComposerAutoGrow } from '@renderer/workspace/tile-tree/TileLeaf/useComposerAutoGrow'
import { useComposerKeybinds } from '@renderer/workspace/tile-tree/TileLeaf/useComposerKeybinds'
import { useComposerDictation } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'
import { useSessionFeed } from '@renderer/features/sessionFeed/SessionFeedContext'
import { useTypeToFocus } from '@renderer/workspace/tile-tree/TileLeaf/useTypeToFocus'
import { usePasteToFocus } from '@renderer/workspace/tile-tree/TileLeaf/usePasteToFocus'
import { usePromptHistory } from '@renderer/workspace/tile-tree/TileLeaf/usePromptHistory'
import { useClaudeImagePaste } from '@renderer/workspace/tile-tree/TileLeaf/useClaudeImagePaste'
import { registerComposerEnterTarget } from '@renderer/workspace/tile-tree/TileLeaf/composerEnterRegistry'
import { readinessStatusSince, resolveReadinessText } from '@renderer/workspace/tile-tree/TileLeaf/readiness'
import { recordHtmlTraceSnapshot } from '@renderer/features/debug/renderTrace'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
import { useLedgerFeedItems } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import { collectWorkflowRunReferences } from '@renderer/features/workflows/model/workflowTool'
import { useSessionWorkflowViews } from '@renderer/features/workflows/model/useSessionWorkflowViews'
import { WorkflowRunView } from '@renderer/features/workflows/ui/WorkflowRunRow'
import { WorkflowViewSelector } from '@renderer/features/workflows/ui/WorkflowViewSelector'
import { useElapsedSeconds } from '@renderer/lib/useElapsedSeconds'
import { reportLifecycle } from '@renderer/lifecycle/report'
import { codexOptimisticRenderCandidateId } from '@renderer/lifecycle/codexTranscriptObservationOutbox'
import {
  optimisticEntrySubmissionId,
  optimisticEntrySubmissionRunId,
  queuedMessageSubmissionId,
  queuedMessageSubmissionRunId,
} from '@renderer/workspace/hook/actions/streaming'
import {
  commitVisibleSubmitSurfaceOwner,
  useVisibleSubmitSurfaceUnmountCleanup,
  type VisibleSubmitSurface,
} from '@renderer/workspace/tile-tree/TileLeaf/useVisibleSubmitSurfaceUnmountCleanup'

const MAX_TRACKED_VISIBLE_SUBMIT_SURFACES = 2_048

// Claude paste-state-machine constants + helpers moved to
// ./TileLeaf/claudePaste.ts. Image helpers moved to
// ./TileLeaf/claudeImages.ts. Label helpers moved to
// ./TileLeaf/labels.ts. See those files for the full rationale on
// the paste debounce, the image size/format gates, and the pane
// header shortening.

// TileLeaf — one pane. A "mini Agent Code" self-contained in a box:
//   header strip (project dir + status)
//   Feed (structured JSONL + streaming preview)
//   composer (input box routing keystrokes to this pane's session)
//   SlashCommandPicker overlay (when slashMode is active)
//   trust dialog overlay (scoped to this pane, not window-global)
//
// All per-session runtime state comes in through the `runtime` prop —
// this component never touches window.api except for sendInput.
// That's the boundary: the store owns event subscriptions + mutations,
// TileLeaf owns rendering and keyboard input for its specific session.
//
// Slash-mode behavior:
//   When the input is empty and the user types `/`, we flip into
//   "slash mode". In slash mode EVERY keystroke is forwarded directly
//   to the PTY (including the `/` itself), and we keep the React input
//   value in sync with what we've sent so the user still sees their
//   filter text. The slash command picker renders as a dropdown above
//   the composer, driven entirely by picker state the main-process
//   parser detected from CC's screen buffer. Arrow keys navigate the
//   picker (forwarded), Enter commits, Escape cancels. See
//   src/core/parsers/slashCommandPicker.ts for the parser.
//
// We deliberately DON'T track "is the picker visible?" to decide when
// to enter/exit slash mode. That would race the IPC snapshot interval:
// the user types `/` and expects the next keystroke to go to CC, but
// picker.visible might still be false in state for another 16ms. So
// slashMode is local state that flips on `/` and flips off on
// Enter/Escape/backspace-to-empty. The picker is a purely visual
// reflection of CC's state; it doesn't gate anything.

type Props = {
  sessionId: SessionId
  runtime: SessionRuntime
  paneLabel?: string
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
  showStatusMode?: boolean
  showWorktreeBadges?: boolean
  ownerSessionId?: SessionId
  relatedAgentTabs?: GridRelatedAgentTab[]
  selectedRelatedSessionId?: SessionId
  onSelectRelatedSession?: (sessionId: SessionId) => void
}

export function TileLeaf({
  sessionId,
  runtime,
  paneLabel,
  focused,
  onFocusRequest,
  workspace,
  showStatusMode = true,
  showWorktreeBadges = true,
  ownerSessionId,
  relatedAgentTabs = [],
  selectedRelatedSessionId,
  onSelectRelatedSession,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const { showToast } = useGlobalToast()
  // Session input goes through the injected SessionFeed (not window.api):
  // the send path below is the composer submit for a REAL agent session, and
  // the remote client mounts this same component tree over a WebSocket feed.
  // See src/shared/sessionFeed/SessionFeed.ts for the contract's WHY.
  const feed = useSessionFeed()
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const tailAllMode = useAppStore(state => state.tailAllMode)
  // The one place the "mounted ⇒ visible" shortcut genuinely breaks: Global
  // Editor fullscreen hides the whole workspace subtree with `display: 'none'`
  // (GlobalEditorShell) while deliberately keeping it mounted so editor state
  // survives. Reading the flag here is what turns "mounted" back into
  // "visible" — see the mask below.
  const workspaceHiddenByEditor = useGlobalEditorStore(state => state.editorFullscreen)
  // This one OR is the ENTIRE implementation of "Tail All" scoping, and it is
  // load-bearing in a way that is easy to mistake for a shortcut.
  //
  // The feature asks for "tail every visible agent, scoped by layout mode":
  // single dispatch = the one agent, tiled = every lane, grid = the current
  // tab's panes only. The obvious implementation is to enumerate the visible
  // sessions and write each one's `tailMode`. That enumeration does not exist
  // and should not be written: there is no canonical visible-session selector
  // here (`resolveTabSessions` answers membership, not visibility — see its
  // header), and visibility is independently re-derived by MainSurface,
  // DispatchLayout, TiledDispatchLayout, TileTabsView, SpotlightView,
  // agentIndexNavigation, paneLabels, and useKeybinds. A ninth derivation would
  // have to hand-encode the mode ladder, the fact that tileTabs/spotlight/
  // readerMode live in a different store and can be non-null simultaneously,
  // duplicate tiled lanes on one session, and grid leaves that render a related
  // detached child instead of their own session.
  //
  // TileLeaf is *almost* the visibility predicate: it mounts only for panes that
  // are on screen, with exactly one exception, which the `&& !hidden` term below
  // corrects for. So every case resolves correctly for free, including layout
  // modes that did not exist when this was written. Verified against the mount
  // sites: TileTree renders it as the else-branch after TerminalLeaf and
  // AgentTerminalLeaf (so terminals never reach it), Spotlight renders one leaf,
  // Classic Dispatch renders the active row, Tiled Dispatch renders every lane,
  // and TileTabs renders every tiled tab — all simultaneously visible.
  //
  // THE EXCEPTION, and do not delete this paragraph: Global Editor fullscreen
  // keeps the whole workspace subtree mounted under `display: 'none'`
  // (GlobalEditorShell.tsx, the `editorFullscreen ? { display: 'none' }` branch)
  // so editor state survives. Reviewers found this — the original version of this
  // comment claimed "mounts if and only if visible", which is false, and the
  // whole design rests on the claim being true.
  //
  // WHY it is corrected rather than tolerated: while hidden the pin is a no-op
  // anyway (a display:none element has scrollHeight 0), so the tempting move is
  // to document it and move on. The problem is the RE-REVEAL. Feed's pin effect
  // keys on [sessionId, tailMode]; if the mask stayed true throughout, neither
  // dep changes when the workspace becomes visible again and an idle pane sits
  // unpinned until its next append — silently not tailing while the palette says
  // it is. Folding visibility into the mask makes un-fullscreening a genuine
  // false→true transition, which re-runs that effect and re-pins. It also fixes
  // the same latent hole for per-session Tail, which had it first.
  //
  // The converse is not true either — a mounted TileLeaf does not always render
  // a Feed to tail. Two known cases: a pane showing a workflow run swaps Feed
  // for WorkflowRunView below, and Reader Mode is a full takeover (MainSurface
  // renders ReaderView *instead of* the workspace shell) so no TileLeaf exists
  // at all there; ReaderView owns an independent stickToBottom. The remote
  // client mounts Feed directly (remote-client/src/ui/SessionView.tsx) and
  // deliberately passes no tail props, so Tail All is desktop-only.
  // In all of these Tail All is inert, not wrong — but the palette still reports
  // "On", which is the honest cost of a workspace-level stance.
  //
  // The mask direction matters too: Tail All never writes `runtime.tailMode`,
  // so the per-session flag is untouched and reappears when Tail All goes off.
  // Note that the *flag* restoring is not the same as the *scroll position*
  // restoring — see the tail-mode guard in Feed's scroll listener for why the
  // pre-tail position has to be protected for that promise to hold.
  const effectiveTailMode = (runtime.tailMode || tailAllMode) && !workspaceHiddenByEditor
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationProvider = useAppStore(state => state.settings.dictationProvider)
  const dictationShortcut = useAppStore(state => state.settings.dictationShortcut)
  const autoSendPromptSuggestion = useAppStore(state => state.settings.autoSendPromptSuggestion)
  const mouseModeEnabled = useAppStore(state => state.settings.mouseModeEnabled)
  // When a prompt-suggestion chip is clicked with autosend on, we prefill the
  // draft (setInputText) and stash the text here; the effect below fires the
  // real submit ONCE the draft has committed to runtime.draftInput, so
  // submitCurrentDraft's own closure sees the suggestion text. This keeps the
  // delicate provider submit/paste path untouched — autosend reuses it exactly
  // as if the user had typed the suggestion and pressed Enter.
  const autoSendPendingRef = useRef<string | null>(null)
  // Destructure the stable useCallback setter so effect deps don't
  // spuriously invalidate on every parent render. workspace itself
  // is a fresh object literal each render, but its methods are
  // memoed via useCallback in workspaceStore — depping on the
  // method gives us "re-run only when the workspace rebuilds the
  // callback", which in practice is never.
  const { acknowledgeSession: acknowledgeWorkspaceSession, setDraftInput } = workspace
  // Draft input lives in the workspace runtime (not local useState)
  // so it survives TileLeaf unmount when the user switches tabs.
  // App.tsx only mounts the active tab's tree — inactive tabs are
  // unmounted, not hidden — so any component-local state dies on
  // tab switch. See SessionRuntime.draftInput for the full reasoning.
  //
  // We keep a local `setInputText` adapter so the rest of this file
  // reads the same way it did before the hoist. The source of truth
  // is runtime.draftInput; this adapter writes THROUGH to the store.
  const input = runtime.draftInput
  const setInputText = (next: string) => {
    setDraftInput(sessionId, next)
  }
  const acknowledgeSession = useCallback(() => {
    acknowledgeWorkspaceSession(sessionId)
  }, [acknowledgeWorkspaceSession, sessionId])
  const setDraftImages = workspace.setDraftImages
  // Agent kinds route through the registry; undefined kind is the
  // pre-kind-persistence back-compat case (#394 phase 2c-4 — the old
  // `=== 'codex' ? codex : claude` ternary silently coerced any
  // future provider to claude).
  const sessionKindForProvider = workspace.state.sessions[sessionId]?.kind
  const provider: AgentProviderKind = isAgentProviderKind(sessionKindForProvider)
    ? sessionKindForProvider
    : DEFAULT_PROVIDER

  // Auto-grow the composer textarea to fit its content — hook lives
  // in ./TileLeaf/useComposerAutoGrow.ts, see there for the
  // "why manual measurement instead of field-sizing:content" story.
  useComposerAutoGrow(inputRef, input)
  // Scroll position for the indicator above the composer. Updated on
  // every scroll tick via onScrollInfo callback from Feed. fraction=0
  // means at bottom, fraction=1 means at top.
  const [scrollFraction, setScrollFraction] = useState(0)
  const [composerHovered, setComposerHovered] = useState(false)
  const scrollFractionRef = useRef(0)
  const onScrollInfo = useCallback((info: ScrollInfo) => {
    if (Math.abs(info.fraction - scrollFractionRef.current) < 0.005) return
    scrollFractionRef.current = info.fraction
    setScrollFraction(info.fraction)
  }, [])

  // Prompt history — state + derivation live in
  // ./TileLeaf/usePromptHistory.ts. Returns the history list, the
  // cycle cursor/anchor, and endHistoryCycle(). See that hook for
  // the transcript-filter rationale (why `permissionMode` is the
  // positive signal and what kinds of noise we had to filter out).
  const sessionKind = workspace.state.sessions[sessionId]?.kind
  const {
    history,
    historyIndex,
    historyAnchor,
    cyclingHistory,
    setHistoryIndex,
    setHistoryAnchor,
    endHistoryCycle,
  } = usePromptHistory({ entries: runtime.entries, sessionKind })

  // When focus flips to this pane, move the DOM caret into its input.
  useEffect(() => {
    if (focused) inputRef.current?.focus()
  }, [focused])

  // Type-to-focus — document-level key listener that routes printable
  // keys into the composer when the pane is focused but DOM focus
  // drifted elsewhere. Hook in ./TileLeaf/useTypeToFocus.ts owns
  // the full filter/injection logic.
  useTypeToFocus({
    focused,
    sessionId,
    inputRef,
    setDraftInput,
    onUserEngagement: acknowledgeSession,
  })

  // Optional `pasteId` correlates this write into the per-paste debug
  // journal in main. Set only by the paste-submit flow in
  // useComposerKeybinds; all other callers (history navigation, slash
  // forwarding, dictation injection) leave it undefined and pay no
  // journaling cost. The pasteId-aware path is the diagnostic for the
  // "first Enter sometimes does nothing" intermittent — see
  // `docs/superpowers/plans/2026-05-11-paste-submit-harness-findings-and-fix.md`.
  const send = async (data: string, pasteId?: string) => {
    acknowledgeSession()
    if (
      !runtime.inputReady ||
      runtime.processStatus !== 'started' ||
      isSessionExited(runtime)
    ) {
      // WHY failed/exited panes use the same wake path as dormant panes:
      // provider attempts are disposable. Keeping the old early throw made a
      // retained recovery failure permanent even though main's stable-id
      // recovery protocol is explicitly retryable. The draft stays intact
      // while ensureSessionLive replaces only the backend generation.
      try {
        await workspace.ensureSessionLive(sessionId, 'tile-leaf.send')
      } catch (err) {
        const message = err instanceof Error && err.message.length > 0
          ? err.message
          : 'Agent is still starting; draft preserved'
        workspace.showPaneToast(sessionId, message)
        throw new Error(message)
      }
    }
    let ok = await feed.sendInput(sessionId, data, pasteId)
    if (!ok) {
      try {
        await workspace.ensureSessionLive(sessionId, 'tile-leaf.send-retry')
        ok = await feed.sendInput(sessionId, data, pasteId)
      } catch (err) {
        workspace.showPaneToast(
          sessionId,
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not wake agent; draft preserved',
        )
        throw err
      }
      if (!ok) {
        // `false` also means main deliberately rejected input while a
        // provider-owned prompt delivery holds the composer reservation. Do
        // not diagnose that healthy safety gate as a dead backend; both cases
        // have the same useful action here—preserve the draft and retry later.
        const message = 'Agent input is temporarily unavailable; draft preserved'
        workspace.showPaneToast(sessionId, message)
        throw new Error(message)
      }
    }
    // Clear any prompt-suggestion chip on submit so a stale offer never
    // lingers past the input it was suggesting. turn_started clears it too,
    // but doing it here makes the chip vanish the instant the user commits.
    if (runtime.promptSuggestion) {
      workspace.updateRuntime(sessionId, { promptSuggestion: null })
    }
  }

  // Condition keystrokes do NOT go through `send`.
  //
  // This is the Codex trust-dialog bug (#596 follow-up). `send` opens with a
  // readiness gate — `!runtime.inputReady || processStatus !== 'started'` →
  // `ensureSessionLive`. That gate is right for the composer and exactly
  // backwards for a condition, because a live provider condition coincides
  // with `inputReady` being false:
  //
  //   Claude — `derivePromptGateState` reports `blocked` for ANY visible
  //     condition, so `publishPromptGate` emits `ready:false` for the whole
  //     time a permission prompt or picker is up.
  //   Codex — different mechanism, same result, and worth being exact about
  //     because the obvious guess is wrong. `blockingCondition()` feeds only
  //     the prompt-delivery poll; it never emits input-readiness. Codex's
  //     readiness LATCHES true at `markComposerReady` and clears only on
  //     exit. The trust dialog is reachable in the broken state because it
  //     paints BEFORE the composer ever appears, so readiness was never true
  //     to begin with. A mid-session approval modal does not clear it.
  //
  // So every click on the trust modal took the wake path instead of writing a
  // keystroke. Before #597 that wake adopted the live backend, waited 30s for
  // a readiness that could not arrive while the unanswered modal held the
  // screen, and then KILLED the process. The user-visible result was exactly
  // the report: accept does nothing, cancel does nothing, and the modal never
  // closes — because the one keystroke that would dismiss it was never
  // written.
  //
  // A visible condition is itself proof the backend is alive and painting, so
  // there is nothing to wake and nothing to wait for. Write the bytes, and
  // surface a refusal instead of swallowing it: `sendInput` returns false when
  // main declines, and that boolean was previously discarded by every
  // condition view.
  //
  // The snapshot check is NOT redundant. `send`'s readiness gate happened to
  // fence one case this path would otherwise open: a QUARANTINED pane
  // (ownership conflict) has its feed channels fenced — including
  // `session:exit`, the sole caller of `clearConditionRuntimeState` — so its
  // last condition snapshot stays frozen on screen while main's entry under
  // that id may belong to someone else. Writing raw keystrokes there is
  // precisely what the quarantine exists to prevent. Requiring a live
  // snapshot mirrors what `RemoteServer.applyPermissionReply` already does
  // before it writes.
  const sendConditionKey = useCallback(async (data: string) => {
    acknowledgeSession()
    if (!runtime.conditions) {
      workspace.showPaneToast(sessionId, 'That prompt is no longer live.')
      return
    }
    const ok = await feed.sendInput(sessionId, data)
    if (!ok) {
      // main returns a bare boolean for two disjoint reasons — a prompt
      // delivery holds the write reservation, or there is no backend at all.
      // Only the first is worth retrying, and we cannot tell them apart from
      // here; the message stays honest about that rather than promising a
      // retry that can never work.
      workspace.showPaneToast(
        sessionId,
        'That keystroke did not reach the agent. If it stays stuck, retry the pane.',
      )
    }
  }, [acknowledgeSession, feed, runtime.conditions, sessionId, workspace.showPaneToast])

  const loadOlderHistory = useCallback(async () => {
    await workspace.loadOlderHistory(sessionId)
  }, [sessionId, workspace.loadOlderHistory])

  const appendRenderDebug = useCallback((entry: Parameters<typeof workspace.appendFeedDebug>[1]) => {
    workspace.appendFeedDebug(sessionId, entry)
  }, [sessionId, workspace.appendFeedDebug])

  // Stage 3 cutover: the ownership-ledger pipeline decides Feed's entire item
  // list — unconditionally now, no flag. Feed just paints what this returns.
  // (The Stage-2 shadow that diffed this against the legacy renderer is gone:
  // its job — proving parity before cutover — is done, and the legacy renderer
  // it diffed against has been deleted.)
  const ledgerFeedPlan = useLedgerFeedItems(runtime, provider, sessionId, {
    toolUseIndex: runtime.toolUseIndex,
    toolResultIndex: runtime.toolResultIndex,
    version: runtime.toolIndexVersion,
  })
  const mergedEntries = useMemo(
    () => selectMergedEntries(runtime, runtime.semantic.currentTurn?.turnId ?? null),
    [
      runtime.entries,
      runtime.ghosts,
      runtime.lastJsonlEntryAt,
      runtime.semantic.currentTurn?.turnId,
      runtime.semantic.history,
    ],
  )
  const normalizedConditions = useMemo(() => {
    const normalize = getRendererProviderCapabilities(provider).normalizeConditions
    return normalize
      ? normalize({
          snapshot: runtime.conditions,
          currentTurn: runtime.semantic.currentTurn,
          entries: runtime.entries,
        })
      : runtime.conditions
  }, [provider, runtime.conditions, runtime.entries, runtime.semantic.currentTurn])

  const workflowCwd = workspace.state.sessions[sessionId]?.cwd ?? null
  const transcriptWorkflowReferences = useMemo(() => collectWorkflowRunReferences({
    toolUseIndex: runtime.toolUseIndex,
    toolResultIndex: runtime.toolResultIndex,
    semanticTurns: [
      ...runtime.semantic.history,
      ...(runtime.semantic.currentTurn ? [runtime.semantic.currentTurn] : []),
    ],
  }), [
    runtime.semantic.currentTurn,
    runtime.semantic.history,
    runtime.toolIndexVersion,
    runtime.toolResultIndex,
    runtime.toolUseIndex,
  ])
  const workflowViews = useSessionWorkflowViews({
    sessionId,
    cwd: workflowCwd,
    transcriptReferences: transcriptWorkflowReferences,
  })
  // This one selected-view object owns JSX selection and the derived visibility
  // evidence. Keeping two equivalent-looking predicates let one drift: the
  // lifecycle effect said Feed painted an optimistic row while WorkflowRunView
  // had replaced Feed.
  const selectedWorkflow = workflowViews.selectedReference && workflowCwd
    ? { reference: workflowViews.selectedReference, cwd: workflowCwd }
    : null
  const feedIsMounted = selectedWorkflow === null
  const visibleSubmitSurfacesRef = useRef(new Map<string, VisibleSubmitSurface>())
  const visibleSubmitSurfaceSessionIdRef = useRef(sessionId)
  const suppressedVisibleSurfaceCountRef = useRef(0)
  const visibleSubmitSurfaceOwner = useVisibleSubmitSurfaceUnmountCleanup(
    visibleSubmitSurfaceSessionIdRef,
    visibleSubmitSurfacesRef,
  )
  useEffect(() => {
    if (visibleSubmitSurfaceSessionIdRef.current !== sessionId) {
      // TileLeaf instances can be reused during layout changes. Clear the
      // component-local capacity ledger before rebuilding it for the new pane;
      // commitVisibleSubmitSurfaceOwner owns the cross-session close/open
      // transition because it still retains this owner's prior global claims.
      visibleSubmitSurfacesRef.current = new Map()
      visibleSubmitSurfaceSessionIdRef.current = sessionId
      suppressedVisibleSurfaceCountRef.current = 0
    }
    if (provider !== 'codex') {
      // A same-pane provider switch removes the Codex feed immediately. The
      // visibility observer must close those captured Codex candidates before
      // dropping its ledger; otherwise a Codex→Claude switch creates an
      // unmarked terminal gap in the named evidence stream.
      commitVisibleSubmitSurfaceOwner(visibleSubmitSurfaceOwner, sessionId, new Map())
      visibleSubmitSurfacesRef.current = new Map()
      suppressedVisibleSurfaceCountRef.current = 0
      return
    }
    const next = new Map<string, VisibleSubmitSurface>()
    let candidateCount = 0
    let suppressed = 0
    const addVisible = (surface: VisibleSubmitSurface): void => {
      candidateCount += 1
      if (next.size >= MAX_TRACKED_VISIBLE_SUBMIT_SURFACES) {
        suppressed += 1
        return
      }
      const key = [
        surface.surface,
        surface.sessionRunId ?? 'missing-run',
        surface.submissionId,
        surface.renderCandidateId,
      ].join(':')
      next.set(key, surface)
    }
    // WHY observe the ledger output in addition to the optimistic mutation:
    // insertion proves a candidate existed, not that the sole ownership
    // pipeline selected it for paint. The original incident had exactly that
    // gap: submit and state logs existed while the user's row did not. This
    // effect records selection from the already-decided item list and never
    // feeds a value back into that decision, so diagnostics cannot become a
    // second renderer. A selected WorkflowRunView replaces Feed entirely;
    // treating a hidden ledger candidate as painted would manufacture the very
    // visibility proof this observation is supposed to test.
    if (feedIsMounted && !workspaceHiddenByEditor) {
      for (const item of ledgerFeedPlan.items) {
        if (item.type !== 'entry') continue
        const submissionId = optimisticEntrySubmissionId(item.entry)
        if (!submissionId) continue
        // FeedRenderItem.key is the React row key (`entry:<uuid>`), while the
        // observation graph names the ownership-ledger candidate that was
        // selected (`optimistic:<uuid>`). Keeping those namespaces distinct is
        // what lets a trace compare mutation and selection without treating a
        // presentation key as a second candidate identity.
        const renderCandidateId = codexOptimisticRenderCandidateId(submissionId)
        addVisible({
          surface: 'render-selected',
          sessionRunId: optimisticEntrySubmissionRunId(item.entry),
          submissionId,
          renderCandidateId,
          entryOrdinal: item.entryOrdinal,
        })
      }
    }

    // QueueStrip is a separate paint plane below Feed and remains mounted while
    // WorkflowRunView owns the central cell. Recording from the exact array
    // handed to QueueStrip closes that observational blind spot without
    // pretending the queue has a provider or rollout identity.
    if (!workspaceHiddenByEditor) {
      for (const message of runtime.queuedMessages) {
        const submissionId = queuedMessageSubmissionId(message)
        if (!submissionId) continue
        const renderCandidateId = `queued:${submissionId}`
        addVisible({
          surface: 'queue-strip',
          sessionRunId: queuedMessageSubmissionRunId(message),
          submissionId,
          renderCandidateId,
        })
      }
    }
    if (
      suppressed > 0 &&
      suppressed !== suppressedVisibleSurfaceCountRef.current
    ) {
      // The first N visible rows remain exactly transition-tracked. Beyond the
      // bound, emit an explicit source gap instead of either growing a TileLeaf
      // forever or silently pretending the visibility chronology is complete.
      reportLifecycle('transcript.surface-gap', sessionId, {
        candidateCount,
        suppressed,
      })
    }
    suppressedVisibleSurfaceCountRef.current = suppressed
    commitVisibleSubmitSurfaceOwner(visibleSubmitSurfaceOwner, sessionId, next)
    visibleSubmitSurfacesRef.current = next
  }, [
    ledgerFeedPlan.items,
    provider,
    runtime.queuedMessages,
    runtime.sessionRunId,
    sessionId,
    feedIsMounted,
    visibleSubmitSurfaceOwner,
    workspaceHiddenByEditor,
  ])

  // Claude image-paste flow — three clipboard ingress paths, media-
  // type gate, 5 MB size cap. Hook in ./TileLeaf/useClaudeImagePaste.ts.
  const { handlePaste, removeDraftImage } = useClaudeImagePaste({
    provider,
    sessionId,
    setDraftImages,
    showToast,
  })

  // Paste-to-focus — document-level paste listener that routes the
  // clipboard into the composer when the pane is focused but DOM
  // focus drifted off the textarea. The paste sibling of
  // useTypeToFocus above; it shares `handlePaste` so pasted images
  // go through the exact same gates as a textarea paste. Hook in
  // ./TileLeaf/usePasteToFocus.ts. Declared here (not next to
  // useTypeToFocus) because it depends on `handlePaste`.
  usePasteToFocus({
    focused,
    sessionId,
    inputRef,
    setDraftInput,
    onUserEngagement: acknowledgeSession,
    handlePaste,
  })

  // Composer keybinds — slash-mode + normal-mode + prompt-history
  // cycling. Hook in ./TileLeaf/useComposerKeybinds.ts; returns
  // the onKeyDown handler plus the slashMode flag that the
  // ComposerInput uses to gate its own onChange logic.
  const { onKeyDown, slashMode, submitCurrentDraft } = useComposerKeybinds({
    sessionId,
    provider,
    runtime,
    workspace,
    input,
    setInputText,
    send,
    sendConditionKey,
    history,
    historyIndex,
    historyAnchor,
    cyclingHistory,
    setHistoryIndex,
    setHistoryAnchor,
    endHistoryCycle,
  })

  const dictation = useComposerDictation({
    enabled: dictationEnabled,
    focused,
    provider: dictationProvider,
    shortcut: dictationShortcut,
    sink: {
      kind: 'composer',
      sessionId,
      input,
      setInputText,
    },
    onMessage: message => workspace.showPaneToast(sessionId, message),
  })

  const onComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (dictation.handleShortcut(event)) return
    onKeyDown(event)
  }, [dictation, onKeyDown])

  useEffect(() => {
    return registerComposerEnterTarget({
      focused,
      hovered: composerHovered,
      hasSubmittableDraft: () => {
        // Slash mode is PTY-owned: Enter commits Claude Code's highlighted
        // slash command, not Agent Code's normal prompt submit. The textarea
        // keydown path already knows how to send that `\r` and clear the local
        // slash-mode state. A document-level Enter cannot safely replay that
        // path without also understanding the picker's current PTY state, so
        // it deliberately does nothing while slash mode is active.
        if (slashMode) return false
        return input.trim().length > 0 || runtime.draftImages.length > 0
      },
      focus: () => inputRef.current?.focus(),
      submit: () => {
        void submitCurrentDraft('global-enter')
      },
    })
  }, [focused, composerHovered, input, runtime.draftImages.length, slashMode, submitCurrentDraft])

  // Auto-send a clicked prompt suggestion. onApplySuggestion prefills the draft
  // and stashes the text in autoSendPendingRef; this effect waits until the
  // draft has actually committed to `input`, then submits via the SAME path a
  // manual Enter uses (submitCurrentDraft clears the draft itself). Gated on
  // the exact pending text so it fires exactly once and never on normal typing.
  useEffect(() => {
    const pending = autoSendPendingRef.current
    if (pending === null || input !== pending) return
    autoSendPendingRef.current = null
    void submitCurrentDraft('global-enter')
  }, [input, submitCurrentDraft])

  const isSessionLive = runtime.sessionStatus === 'running'
  // WHY the text is resolved TWICE:
  //
  // `inputReadinessChangedAt` is non-null for a HEALTHY pane too — the reducer
  // stamps it on the false→true transition as well. Ticking on that alone
  // mounted a permanent 1 Hz interval per pane, re-rendering this component
  // (and its composer/feed subtrees) once a second, forever, while
  // `resolveReadinessText` returned null and nothing was displayed. Fifteen
  // panes meant fifteen idle timers and fifteen renders a second.
  //
  // So: resolve without a clock first. That answers "is a line shown at all"
  // for free, and only then does the timer mount. This is the invariant
  // useElapsedSeconds documents — no timers for status lines that are not
  // being shown — which the first version violated.
  const readinessBaseText = resolveReadinessText(runtime)
  const readinessSince = readinessBaseText === null
    ? null
    : readinessStatusSince(runtime)
  const readinessElapsedSeconds = useElapsedSeconds(readinessSince)
  const readinessText = readinessBaseText === null
    ? null
    : resolveReadinessText(
        runtime,
        readinessSince === null || readinessElapsedSeconds === null
          ? null
          : readinessSince + readinessElapsedSeconds * 1000,
      )
  const canRetryBackend = runtime.processStatus === 'failed' ||
    runtime.processStatus === 'exited'

  useEffect(() => {
    if (!htmlDebugPanelOpen || !focused) return
    const node = paneRef.current
    if (!node) return

    let timer: number | null = null
    const capture = (reason: 'initial' | 'mutation') => {
      recordHtmlTraceSnapshot(sessionId, node.outerHTML, reason)
    }
    const scheduleCapture = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        capture('mutation')
      }, 250)
    }

    capture('initial')
    const observer = new MutationObserver(scheduleCapture)
    observer.observe(node, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    })

    return () => {
      observer.disconnect()
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [focused, htmlDebugPanelOpen, sessionId])

  return (
    // data-pane-id: stable DOM hook so DOM-targeting debug tools
    // (HtmlDebugPanel in particular) can locate this pane's root via
    // document.querySelector(`[data-pane-id="${sessionId}"]`) without
    // needing a ref forwarded out of this component. The existing
    // debug panels are stateless about the DOM and read from runtime
    // props instead, so a data attribute keeps that boundary intact.
    // Session UUIDs are unique across the app, so there's no collision
    // risk with multiple panes mounted simultaneously.
    <div
      ref={paneRef}
      data-pane-id={sessionId}
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      onMouseDown={onFocusRequest}
    >
      <PaneHeader
        sessionId={sessionId}
        paneLabel={paneLabel}
        agentTitle={workspace.state.sessions[sessionId]?.title}
        projectDir={runtime.projectDir}
        statusMode={showStatusMode}
        isSessionLive={isSessionLive}
        relatedAgentTabs={relatedAgentTabs}
        selectedRelatedSessionId={selectedRelatedSessionId ?? sessionId}
        runtimes={workspace.runtimes}
        ownerSessionId={ownerSessionId ?? sessionId}
        onSelectRelatedSession={onSelectRelatedSession}
      />

      {/* Feed — overflow-auto lives inside Feed itself so it can
          own its own scroll listener for the sticky-bottom logic
          (see Feed.tsx FeedImpl). This wrapper just provides the
          flex cell sizing; the scroller is a child. */}
      <div className="flex-1 min-h-0">
        {selectedWorkflow ? (
          <WorkflowRunView
            reference={selectedWorkflow.reference}
            cwd={selectedWorkflow.cwd}
            onReferenceChange={workflowViews.replaceReference}
          />
        ) : (
          <Feed
            renderItemsOverride={ledgerFeedPlan.items}
            committedOperationDecisionOverride={ledgerFeedPlan.resolveOperation}
            sessionId={sessionId}
            provider={provider}
            workspaceRoot={workspace.state.sessions[sessionId]?.cwd ?? null}
          // Committed transcript + (rare) orphan-ghost fallback.
          // The layered predicate in selectMergedEntries renders
          // a ghost only when JSONL has stalled past the proxy
          // AND the ghost is not sidecar-shaped (title-gen /
          // predict-next-prompt fingerprint). SemanticStreamingTurn
          // owns the live current turn and bounded completed
          // semantic history; selectMergedEntries suppresses ghosts
          // for those turn ids so the two surfaces never
          // double-render.
          // See docs/design/ghost-system.md for the canonical
          // explanation of the predicate and the dual-owner
          // model.
          entries={mergedEntries}
          // Live text renders ONLY from the semantic channel. The
          // former `streamingScreen` / `streamingScreenMarkdown` /
          // `streamingBaseline` props are gone — Feed no longer
          // parses the TUI buffer at render time. Screen-derived
          // live text now arrives via the semantic channel tagged
          // `source: 'screen'`, published by the headless packages
          // with a baseline gate that prevents the previous turn's
          // text from leaking into the new turn's first delta.
          // (The dead `activityStatus={runtime.activityStatus}` pass-through was
          // removed here — Feed no longer reads it; feed audit Deletion
          // Candidate 1. runtime.activityStatus stays for DebugPanel.)
          // Adapter-derived stream phase — drives the in-feed
          // WorkIndicator. The renderer never re-derives; it just
          // displays whatever phase the headless package published.
          // See 2026-04-18-thinking-phase-in-headless.md for the
          // derivation contract.
            streamPhase={runtime.streamPhase}
            streamPhasePendingToolName={runtime.streamPhasePendingToolName}
            streamPhasePendingToolUseId={runtime.streamPhasePendingToolUseId}
            turnStartedAt={runtime.turnStartedAt}
          // Live-turn ownership: SemanticStreamingTurn renders the
          // current turn end-to-end off the semantic channel. Ghosts
          // for semantic current/history turn ids are filtered out of
          // the merged feed, so semantic rows and orphan fallback rows
          // cannot both own the same visible turn.
          //
          // Completed semantic history is passed separately because
          // MCP/Codex tool execution can advance through several
          // Responses turns before JSONL commits rows for the earlier
          // turns. Without this bounded bridge, archiving the current
          // semantic turn makes the visible feed shrink until the
          // durable transcript catches up — the exact "conversation
          // clears while the agent is working" failure.
            semanticHistory={runtime.semantic.history}
            semanticTurn={runtime.semantic.currentTurn}
            tailMode={effectiveTailMode}
            pickerSelectedUuid={runtime.assistantPicker?.selectedUuid ?? null}
            codeBlockSelectedId={runtime.codeBlockPicker?.selectedId ?? null}
            onScrollInfo={onScrollInfo}
            onUserEngagement={acknowledgeSession}
            hasOlderHistory={runtime.hasOlderHistory}
            loadingOlderHistory={runtime.loadingOlderHistory}
            onLoadOlderHistory={loadOlderHistory}
          // Bootstrap-replay perf wiring — see workspaceStore +
          // Feed for the WHY. While `bootstrapping` is true Feed
          // suspends per-append auto-scroll and lazy-mount cascades;
          // the indices spare Feed from a useMemo rebuild on every
          // append.
            bootstrapping={runtime.bootstrapping}
            scrollToLatestRequest={runtime.scrollToLatestRequest}
            toolUseIndex={runtime.toolUseIndex}
            toolResultIndex={runtime.toolResultIndex}
            toolIndexVersion={runtime.toolIndexVersion}
            subAgents={runtime.subAgents}
            askUserQuestionState={
              // Kind-keyed lookup (#394 phase 3): globally namespaced
              // kinds make the provider narrow redundant. undefined =
              // "no snapshot yet", null = "snapshot without AUQ" — Feed
              // distinguishes the two.
              runtime.conditions
                ? conditionStateByKind<ClaudeAskUserQuestionState>(
                    runtime.conditions,
                    'claude.ask-user-question',
                  )
                : undefined
            }
          // Keep render-decision logging tied to mounted feeds, not
          // to the debug panel or the transient focus flag. The
          // state/semantic layers already persist aggressively in
          // normal sessions, but `Feed` used to log `visible_rows`
          // only when the panel was mounted. A later focus-gated
          // version still missed MCP/tool-call traces because focus
          // can move while the same pane keeps receiving streamed
          // state. That left the exact haunted class of bugs
          // invisible in the saved trace: optimistic user row added,
          // MCP semantic turn advanced, JSONL reconciled, and then
          // no record of whether the feed actually rendered those
          // rows. `Feed` logs only row/count changes and the debug
          // store is capped, so all-mounted logging is the correct
          // diagnostic boundary.
            onDebugLog={appendRenderDebug}
          />
        )}
      </div>

      <QueueStrip provider={provider} queuedMessages={runtime.queuedMessages} />

      {readinessText && (
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-3 py-1 font-code text-[10px] text-muted">
          <span className="min-w-0 truncate">{readinessText}</span>
          {canRetryBackend && (
            <button
              type="button"
              className="flex-shrink-0 text-accent hover:underline"
              onClick={() => {
                void workspace.ensureSessionLive(sessionId, 'tile-leaf.retry').catch(err => {
                  workspace.showPaneToast(
                    sessionId,
                    err instanceof Error && err.message.length > 0
                      ? err.message
                      : 'Could not restart agent',
                  )
                })
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      <ProviderConditionOutlet
        sessionId={sessionId}
        conditions={normalizedConditions}
        onSend={sendConditionKey}
        onResolveCustom={(action) => feed.resolveCondition(sessionId, action)}
        interactionActive={focused}
      />

      <PaneToast message={runtime.paneToast} />

      <ScrollIndicator
        entryCount={runtime.entries.length}
        totalEntries={runtime.totalEntries}
        scrollFraction={scrollFraction}
        tailMode={effectiveTailMode}
        sessionKind={workspace.state.sessions[sessionId]?.kind}
        workContext={showWorktreeBadges ? runtime.workContext : null}
        workActivity={showWorktreeBadges ? runtime.workActivity : null}
      />

      <ComposerInput
        sessionId={sessionId}
        inputRef={inputRef}
        input={input}
        focused={focused}
        slashMode={slashMode}
        provider={provider}
        draftImages={runtime.draftImages}
        pickerState={runtime.picker}
        historyIndex={historyIndex}
        history={history}
        setInputText={setInputText}
        endHistoryCycle={endHistoryCycle}
        onKeyDown={onComposerKeyDown}
        onPaste={handlePaste}
        onFocusRequest={onFocusRequest}
        onUserEngagement={acknowledgeSession}
        onHoverChange={setComposerHovered}
        removeDraftImage={removeDraftImage}
        dictation={dictation}
        promptSuggestion={runtime.promptSuggestion?.text ?? null}
        onApplySuggestion={text => {
          // Always prefill the draft and clear the chip. Then, if autosend is
          // on (the default), stash the text so the effect above submits it
          // once the draft commits — one click acts. With autosend off we stop
          // at prefill so the user can edit before submitting (#174's original
          // prefill behavior, now opt-in via Settings → Workspace).
          setInputText(text)
          workspace.updateRuntime(sessionId, { promptSuggestion: null })
          if (autoSendPromptSuggestion) autoSendPendingRef.current = text
        }}
        onDismissSuggestion={() =>
          workspace.updateRuntime(sessionId, { promptSuggestion: null })
        }
        promptDelivery={runtime.promptDelivery}
        onResolveUncertainDelivery={() =>
          workspace.updateRuntime(sessionId, { promptDelivery: { kind: 'idle' } })
        }
        providerSwitchMessage={runtime.providerSwitch?.message ?? null}
      />

      {/* Mouse Mode only. Rendered as a sibling BELOW the composer rather than
          inside ComposerInput, because that component is shared with the phone
          client, which already draws its own Send. */}
      {mouseModeEnabled ? (
        <ComposerActions
          input={input}
          hasDraftImages={runtime.draftImages.length > 0}
          sending={runtime.promptDelivery.kind === 'sending'}
          deliveryUncertain={runtime.promptDelivery.kind === 'uncertain'}
          providerSwitching={runtime.providerSwitch !== null}
          slashMode={slashMode}
          // Same predicate the Dispatch list uses for its running count. NOT
          // `streamPhase !== 'idle'` alone: between clicking Send and the first
          // token, streamPhase is still idle while the session is already
          // running, so a stream-only test hid Stop during precisely the
          // interval where "I just sent the wrong thing" is most likely.
          working={
            runtime.sessionStatus === 'running' || runtime.streamPhase !== 'idle'
          }
          dictationStatus={dictation.status}
          onSend={() => void submitCurrentDraft('button')}
          // Same escape byte the keyboard interrupt sends, and the same one the
          // phone's Stop uses. Deliberately raw input rather than a lifecycle
          // action: interrupting is the provider's own protocol, not ours.
          onStop={() => void send('\x1b')}
        />
      ) : null}

      {/* WHY navigation sits after the composer in DOM and visual order: a workflow is another
          view of this same agent session, not a feed row and not a detached panel. Keeping the
          selector below the stable composer makes Main/workflow selection explicit while swapping
          only the feed-sized viewport above it. */}
      <WorkflowViewSelector
        references={workflowViews.references}
        historyReferences={workflowViews.allReferences}
        cwd={workflowCwd}
        selectedRunId={workflowViews.selectedRunId}
        onSelect={workflowViews.selectRun}
      />
    </div>
  )
}

// shortenCwd + providerLabel moved to ./TileLeaf/labels.ts.
