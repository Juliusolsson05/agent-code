import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  isCompactSummaryEntry,
  type ConversationEntry,
  type Entry,
} from '../../../shared/types/transcript'
// Direct file imports — parser files are pure TypeScript, safe for
// the renderer. Package entry points pull in Node deps (pty, fs).
import { detectCodexApproval } from '../../../shared/parsers/codexScreen'
import { extractAssistantInProgress } from '../../../shared/parsers/extractAssistant'
import {
  RATIO_DEFAULT,
  type SessionId,
  type SessionKind,
  type SessionMeta,
  type SplitDirection,
  type Tab,
  type TabId,
  type TileNode,
  type WorkspaceState,
} from './types'
import {
  adjustNearestSplitRatio,
  closeLeaf,
  collectLeaves,
  equalizeRatios,
  findNeighbor,
  normalizeTree,
  resizeInDirection,
  rotateTree,
  splitLeaf,
} from './treeOps'
import {
  UndoCloseStack,
  findParentSplitInfo,
  reinsertPane,
  type ClosedEntry,
} from '../lib/undoClose'
import { useGlobalToast } from '../GlobalToast'

// Workspace store — single React hook that owns:
//   - The workspace state (tabs + tile trees + session metadata)
//   - Live per-session runtime state (screen, entries, awaitingAssistant, …)
//   - IPC subscriptions that dispatch events to the right session
//   - All the mutation actions the keybind system calls
//
// We deliberately keep everything in ONE hook instead of splitting into
// multiple stores because:
//   - The mutations cross-cut multiple slices (splitting creates a new
//     session AND adds to tree AND updates sessions map).
//   - The dispatch-by-sessionId event routing needs a stable reference
//     to the live state refs — one hook means one set of refs.
//   - Persistence is a single serialized blob; one store = one save.
//
// If this grows past ~500 lines we split, but for now it's manageable.

// ---------------------------------------------------------------------------
// Per-session runtime state (live; NOT persisted to disk)
// ---------------------------------------------------------------------------

export type PickerItem = {
  id: string
  label: string
  description: string
  selected: boolean
}

export type SlashPickerState = {
  visible: boolean
  items: PickerItem[]
}

/**
 * A message currently in CC's internal message queue.
 *
 * When the user types while CC is still generating, CC's
 * messageQueueManager (see claude-code-src/coordinator/messageQueueManager.ts)
 * buffers the prompt in process memory until the active query ends,
 * then dequeues it and starts a new query. The queued message does
 * NOT appear as a `user` transcript entry during this window — it
 * only materializes when CC starts processing it — so without
 * special handling our feed shows nothing for the in-limbo prompt.
 *
 * CC DOES emit structured `type: 'queue-operation'` JSONL entries for
 * every enqueue / dequeue, carrying the full content for enqueues.
 * We consume those and mirror them into this runtime array so the
 * UI can show a live "N pending" strip above the composer. The array
 * is a FIFO — enqueue appends, dequeue shifts the head — so order
 * follows CC's internal ordering without any extra bookkeeping.
 */
export type QueuedMessage = {
  /** The prompt text the user typed. */
  content: string
  /** CC's timestamp from the queue-operation entry; used as a stable
   *  React key and for sort-debug if we ever need it. */
  timestamp: string
}

export type SessionRuntime = {
  /** Visible viewport — source of truth for current-state parsers
   *  (trust dialog, slash picker, activity indicator). */
  screen: string
  /** Viewport with bold/italic reconstructed from cell attributes. */
  screenMarkdown: string
  /** Wider window (last ~200 rows including scrollback) used by the
   *  streaming card's extractAssistantInProgress. CC's responses
   *  often grow taller than the 40-row viewport, scrolling the
   *  opening `⏺` marker out of view; without this wider snapshot
   *  the streaming card stayed blank for long replies until the
   *  JSONL entry landed. */
  recentScreen: string
  /** Markdown counterpart of `recentScreen`. */
  recentScreenMarkdown: string
  /** Streaming-card baseline captured at submit time. */
  streamingBaseline: string | null
  /** Parsed JSONL entries for this session's feed. */
  entries: Entry[]
  /** True between "user pressed Enter" and "assistant entry lands in JSONL".
   *  IMPORTANT: we also hold this flag true while `queuedMessages.length > 0`,
   *  because an assistant entry landing for turn N doesn't mean CC is idle —
   *  it might already be dequeueing turn N+1. See the jsonl-entry handler
   *  in useWorkspace for the exact logic. */
  awaitingAssistant: boolean
  /** Messages currently sitting in CC's message queue, in FIFO order.
   *  Populated from `type: 'queue-operation'` JSONL entries, NOT by
   *  peeking at the composer input. See QueuedMessage above. */
  queuedMessages: QueuedMessage[]
  /** PTY exit code, null if still running. */
  exited: number | null
  /** CC's JSONL project dir (for tooltip / debug). */
  projectDir: string | null
  /** Slash command picker state parsed in main from the terminal buffer.
   *  Updated on every screen snapshot. The TileLeaf reacts to
   *  picker.visible flipping to decide whether to render the picker
   *  component and whether to route keys through the PTY. */
  picker: SlashPickerState
  /** Draft input text for this session's composer. Lives in runtime
   *  (not component-local useState) so it survives TileLeaf unmount.
   *
   *  Why it has to be here and not inside TileLeaf:
   *    App.tsx only renders the active tab's TileTree — inactive tabs
   *    are UNMOUNTED, not hidden. When the user switches away from a
   *    tab mid-draft, the old TileLeaf unmounts and its local state is
   *    destroyed; switching back remounts a fresh instance with an
   *    empty input. The user sees their typing vanish.
   *
   *  Keying drafts by sessionId also means split panes each get their
   *  own draft (they have distinct sessionIds), which matches the
   *  "each pane is its own conversation" mental model. And when a
   *  session is killed, its runtime is deleted along with everything
   *  else in it — no draft leaks past session teardown. */
  draftInput: string
  /** Activity status forwarded by the provider (Claude's spinner verb
   *  like "Cogitating…", Codex's bottom-row text like "working… 12s").
   *  Non-null when the agent is actively working; null when idle.
   *  Source of truth lives in each provider's headless package and
   *  arrives via the process-state IPC handler — the renderer no
   *  longer parses the screen for this. */
  activityStatus: string | null
  /** Transient toast message shown above the composer. Single-slot:
   *  a new toast replaces any in-flight one. Null when nothing to show.
   *  Auto-cleared by a timeout in showPaneToast — components just read
   *  it and render when non-null. */
  paneToast: string | null
  /** Pending Codex exec approval request, if the model asked to run a
   *  command that requires user approval. */
  pendingApproval: {
    callId: string | null
    command: string[]
    workdir: string | null
    reason?: string | null
    options?: string[]
    selectedIndex?: number
  } | null
  /** Pending Claude trust dialog, sourced from headless parser events. */
  pendingTrustDialog: {
    workspace?: string
  } | null
  /** Pending Claude resume-choice prompt parsed from the live screen. */
  pendingResumePrompt: {
    sessionAgeText?: string
    tokenCountText?: string
    options?: string[]
    selectedIndex?: number
  } | null
  /** Pending Claude compaction status sourced from headless parser events. */
  pendingCompaction: {
    phase: 'running' | 'error' | 'done'
    statusText?: string
    errorText?: string
  } | null
}

const emptyRuntime = (): SessionRuntime => ({
  screen: '',
  screenMarkdown: '',
  recentScreen: '',
  recentScreenMarkdown: '',
  streamingBaseline: null,
  entries: [],
  awaitingAssistant: false,
  queuedMessages: [],
  exited: null,
  projectDir: null,
  picker: { visible: false, items: [] },
  draftInput: '',
  activityStatus: null,
  paneToast: null,
  pendingApproval: null,
  pendingTrustDialog: null,
  pendingResumePrompt: null,
  pendingCompaction: null,
})

function isCodexRolloutEntry(entry: Record<string, unknown>): boolean {
  const type = entry.type
  return (
    type === 'session_meta' ||
    type === 'response_item' ||
    type === 'event_msg' ||
    type === 'turn_context' ||
    type === 'compacted'
  )
}

function extractCodexProviderSessionId(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'session_meta') return null
  const payload = entry.payload as Record<string, unknown> | undefined
  return typeof payload?.id === 'string' ? payload.id : null
}

function entryTextContent(entry: Entry): string | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  const content = (entry as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null
  const texts = content
    .map(block => {
      const item = block as Record<string, unknown>
      return item.type === 'text' && typeof item.text === 'string' ? item.text : null
    })
    .filter((text): text is string => text !== null)
  return texts.length > 0 ? texts.join('\n') : null
}

function isOptimisticCodexUserEntry(entry: Entry | undefined): boolean {
  if (!entry || entry.type !== 'user') return false
  return typeof entry.uuid === 'string' && entry.uuid.startsWith('optimistic-codex-user:')
}

function parseCodexJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map(item => {
        if (typeof item === 'string') return item
        const rec = item as Record<string, unknown>
        return typeof rec.text === 'string' ? rec.text : JSON.stringify(item, null, 2)
      })
      .join('\n')
  }
  return JSON.stringify(output ?? '', null, 2)
}

function stripCodexExecWrapper(output: string): string {
  const marker = '\nOutput:\n'
  const idx = output.indexOf(marker)
  if (!output.startsWith('Chunk ID:') || idx === -1) return output
  return output.slice(idx + marker.length)
}

function isCodexExecWrapperOutput(output: string): boolean {
  return output.startsWith('Chunk ID:') && output.includes('\nProcess exited with code ')
}

function codexToolUseEntry(
  uuid: string,
  timestamp: string | undefined,
  id: string,
  name: string,
  input: unknown,
): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name,
          input,
        },
      ],
    },
  }
}

function codexAssistantTextEntry(
  uuid: string,
  timestamp: string | undefined,
  text: string,
): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

function codexToolResultEntry(
  uuid: string,
  timestamp: string | undefined,
  toolUseId: string,
  content: string,
  isError = false,
  codex?: Record<string, unknown>,
): Entry {
  const resultBlock = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    codex,
  }

  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'user',
      content: [resultBlock],
    },
  }
}

function mapCodexRolloutToFeedEntries(entry: Record<string, unknown>): Entry[] {
  const uuid =
    `${String(entry.timestamp ?? Date.now())}:${String((entry.payload as Record<string, unknown> | undefined)?.id ?? (entry.payload as Record<string, unknown> | undefined)?.call_id ?? (entry.payload as Record<string, unknown> | undefined)?.type ?? entry.type)}`
  const timestamp =
    typeof entry.timestamp === 'string' ? entry.timestamp : undefined

  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.type !== 'string') return []

  if (entry.type === 'event_msg') {
    if (payload.type === 'exec_approval_request') {
      const command = Array.isArray(payload.command)
        ? payload.command.filter((part): part is string => typeof part === 'string')
        : []
      const workdir = typeof payload.workdir === 'string' ? payload.workdir : null
      const summary = [
        'Permission required before Codex can run a command.',
        command.length > 0 ? `Command: ${command.join(' ')}` : null,
        workdir ? `Directory: ${workdir}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
      return summary ? [codexAssistantTextEntry(uuid, timestamp, summary)] : []
    }

    if (
      payload.type === 'exec_command_end' &&
      typeof payload.call_id === 'string'
    ) {
      const output = String(
        payload.aggregated_output ??
        payload.formatted_output ??
        payload.stdout ??
        payload.stderr ??
        '',
      )
      const exitCode =
        typeof payload.exit_code === 'number' ? payload.exit_code : 0
      if (!output.trim() && exitCode === 0) return []
      return [
        codexToolResultEntry(
          uuid,
          timestamp,
          payload.call_id,
          output,
          exitCode !== 0 || payload.status === 'failed',
          {
            kind: 'exec_command_end',
            parsedCmd: Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : [],
            command: Array.isArray(payload.command) ? payload.command : [],
            cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
            exitCode,
          },
        ),
      ]
    }

    if (
      payload.type === 'patch_apply_end' &&
      typeof payload.call_id === 'string'
    ) {
      const stdout = typeof payload.stdout === 'string' ? payload.stdout : ''
      const stderr = typeof payload.stderr === 'string' ? payload.stderr : ''
      const content = stdout || stderr
      return [
        codexToolResultEntry(
          uuid,
          timestamp,
          payload.call_id,
          content,
          payload.success !== true,
          {
            kind: 'patch_apply_end',
            success: payload.success === true,
            changes: payload.changes && typeof payload.changes === 'object'
              ? payload.changes as Record<string, unknown>
              : {},
          },
        ),
      ]
    }

    return []
  }

  if (entry.type !== 'response_item') return []

  if (
    payload.type === 'message' &&
    (payload.role === 'user' || payload.role === 'assistant')
  ) {
    const role = payload.role
    const content = Array.isArray(payload.content)
      ? payload.content
          .map(block => {
            const item = block as Record<string, unknown>
            const text = typeof item.text === 'string' ? item.text : null
            if (!text) return null
            if (item.type === 'input_text' || item.type === 'output_text') {
              return { type: 'text' as const, text }
            }
            return null
          })
          .filter((block): block is { type: 'text'; text: string } => block !== null)
      : []

    if (content.length === 0) return []
    return [
      {
        type: role,
        uuid,
        parentUuid: null,
        timestamp,
        message: { role, content },
      },
    ]
  }

  if (
    payload.type === 'custom_tool_call' &&
    typeof payload.call_id === 'string' &&
    typeof payload.name === 'string'
  ) {
    const input =
      typeof payload.input === 'string'
        ? parseCodexJson(payload.input) ?? { raw: payload.input }
        : { raw: '' }
    return [codexToolUseEntry(uuid, timestamp, payload.call_id, payload.name, input)]
  }

  if (
    payload.type === 'function_call' &&
    typeof payload.call_id === 'string' &&
    typeof payload.name === 'string'
  ) {
    const input =
      typeof payload.arguments === 'string'
        ? parseCodexJson(payload.arguments) ?? { arguments: payload.arguments }
        : { arguments: payload.arguments }
    return [codexToolUseEntry(uuid, timestamp, payload.call_id, payload.name, input)]
  }

  if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
    const output = stripCodexExecWrapper(codexOutputText(payload.output))
    if (!output.trim() || isCodexExecWrapperOutput(codexOutputText(payload.output))) {
      return []
    }
    return [codexToolResultEntry(uuid, timestamp, payload.call_id, output)]
  }

  if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string') {
    const output = codexOutputText(payload.output)
    const parsed = parseCodexJson(output)
    const normalized =
      typeof parsed?.output === 'string' ? parsed.output : output
    const metadata = parsed?.metadata
    const exitCode =
      metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>).exit_code === 'number'
        ? (metadata as Record<string, unknown>).exit_code as number
        : 0
    if (
      typeof normalized === 'string' &&
      normalized.startsWith('Success. Updated the following files:')
    ) {
      return []
    }
    return [
      codexToolResultEntry(
        uuid,
        timestamp,
        payload.call_id,
        normalized,
        exitCode !== 0,
        { kind: 'custom_tool_call_output' },
      ),
    ]
  }

  return []
}

function extractEmbeddedClaudeProgressEntry(
  entry: Record<string, unknown>,
): ConversationEntry | null {
  if (entry.type !== 'progress') return null
  const data = entry.data as Record<string, unknown> | undefined
  const embedded = data?.message as Record<string, unknown> | undefined
  if (!embedded) return null

  const type = embedded.type
  if (type !== 'assistant' && type !== 'user') return null
  if (!embedded.message || typeof embedded.message !== 'object') return null

  return {
    type,
    uuid:
      typeof embedded.uuid === 'string'
        ? embedded.uuid
        : `${String(entry.timestamp ?? Date.now())}:progress:${type}`,
    parentUuid:
      typeof embedded.parentUuid === 'string' ? embedded.parentUuid : null,
    timestamp:
      typeof embedded.timestamp === 'string'
        ? embedded.timestamp
        : typeof entry.timestamp === 'string'
          ? entry.timestamp
          : undefined,
    sessionId:
      typeof embedded.sessionId === 'string'
        ? embedded.sessionId
        : typeof entry.sessionId === 'string'
          ? entry.sessionId
          : undefined,
    gitBranch:
      typeof embedded.gitBranch === 'string'
        ? embedded.gitBranch
        : typeof entry.gitBranch === 'string'
          ? entry.gitBranch
          : undefined,
    cwd:
      typeof embedded.cwd === 'string'
        ? embedded.cwd
        : typeof entry.cwd === 'string'
          ? entry.cwd
          : undefined,
    isSidechain: embedded.isSidechain === true,
    message: embedded.message as ConversationEntry['message'],
  }
}

// ---------------------------------------------------------------------------
// Persisted state shape (serialized to ~/.config/cc-shell/workspace.json)
// ---------------------------------------------------------------------------

/**
 * Persisted workspace shape. Live runtime state is NOT here — we
 * respawn sessions on load and their state rebuilds naturally from
 * fresh IPC events.
 */
type PersistedWorkspace = {
  // Tab tree with sessionIds that refer to the CURRENT launch's
  // sessions. On load we re-spawn and remap ids, so persisted ids are
  // just placeholders that get replaced.
  tabs: Array<{
    id: TabId
    title: string
    focusedSessionId: SessionId
    root: TileNode
  }>
  activeTabId: TabId
  sessions: Record<SessionId, SessionMeta>
  /** Draft input text per session, keyed by sessionId. Persisted so
   *  in-progress prompts survive app crashes and restarts. Only
   *  non-empty drafts are saved to keep the file small. */
  drafts?: Record<SessionId, string>
}

// ---------------------------------------------------------------------------
// The store hook
// ---------------------------------------------------------------------------

export type Workspace = ReturnType<typeof useWorkspace>

type SpotlightState = {
  tabId: TabId
  focusedSessionId: SessionId
}

type TileTabsState = {
  tabIds: TabId[]
  focusedTabId: TabId
  direction: SplitDirection
  ratios: number[]
}

export function useWorkspace() {
  // GlobalToast lives one level up in the provider tree (mounted in
  // main.tsx). Reading it here lets close actions surface a brief
  // "Closed — ⌘⇧T to undo" hint without each caller having to know
  // about the toast system. The hook returns a stable callback so
  // re-renders don't churn close handlers.
  const { showToast } = useGlobalToast()

  const [state, setState] = useState<WorkspaceState>({
    tabs: [],
    activeTabId: '',
    sessions: {},
  })

  // Ref mirror of state so IPC callbacks (which close over stale state)
  // can read the current session metadata (e.g. kind) without causing
  // re-subscriptions on every state change.
  const stateRef = useRef(state)
  stateRef.current = state

  // Per-session runtime state. Keyed by sessionId. NOT part of
  // persistent state — runtime rebuilds from IPC events after respawn.
  const [runtimes, setRuntimes] = useState<Record<SessionId, SessionRuntime>>({})
  const [spotlight, setSpotlight] = useState<SpotlightState | null>(null)
  const [tileTabs, setTileTabs] = useState<TileTabsState | null>(null)

  // Ref mirror of runtimes so the debounced save callback can read
  // current drafts without re-creating the callback on every render.
  const latestRuntimesRef = useRef(runtimes)
  latestRuntimesRef.current = runtimes

  // Seen uuids per session, for JSONL dedup. Refs because we never
  // render against them — they're bookkeeping.
  const seenUuidsRef = useRef<Record<SessionId, Set<string>>>({})

  // Latest screen per session — mirrored from state into a ref so the
  // Enter handler in TileLeaf can capture a baseline synchronously.
  const latestScreenRef = useRef<Record<SessionId, string>>({})

  // Undo-close stack — mutable ref because the stack is imperative
  // (push/pop) and we don't want React re-renders on every close.
  // The undoClose action reads it and the command palette peeks at
  // .length to show/hide the command.
  const undoStackRef = useRef(new UndoCloseStack())

  // ---- Helpers ----

  const updateRuntime = useCallback(
    (sessionId: SessionId, patch: Partial<SessionRuntime>) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        return { ...prev, [sessionId]: { ...current, ...patch } }
      })
    },
    [],
  )

  const getRuntime = useCallback(
    (sessionId: SessionId): SessionRuntime => {
      return runtimes[sessionId] ?? emptyRuntime()
    },
    [runtimes],
  )

  // ---- IPC subscription: dispatch all session events to the right runtime ----
  //
  // One listener per event type. The callback looks up the session by
  // sessionId from the payload and patches the corresponding runtime.
  useEffect(() => {
    const offStarted = window.api.onSessionStarted(({ sessionId, projectDir }) => {
      updateRuntime(sessionId, { projectDir })
    })

    const offScreen = window.api.onSessionScreen(
      ({ sessionId, plain, markdown, recent, recentMarkdown, picker }) => {
        // latestScreenRef is the synchronous source of truth for the
        // Enter-baseline capture in TileLeaf — always update it, even
        // when we bail on React state below.
        // Use `recent` (wider window) so the baseline includes any
        // assistant text that may have already scrolled out of the
        // viewport. The baseline comparison is the basis for "is the
        // streaming card stale?", which depends on seeing the same
        // marker the streaming extractor will see.
        latestScreenRef.current[sessionId] = recent

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          // Screen snapshots fire continuously (CC redraws its TUI at
          // ~60Hz) but the actual text is usually identical between
          // frames — CC is redrawing chrome, cursor, or a spinner that
          // our parser already strips. Without a bail-out, every idle
          // frame triggers a new `runtimes` state → useWorkspace
          // re-render → TileTree/TileLeaf reconcile → Feed.memo check
          // (which does then skip, but reconciliation to that point
          // isn't free). Comparing strings by reference first, then by
          // value, and bailing before setState entirely saves that
          // whole pass on every no-op frame. This is the difference
          // between "scheduled work on every frame" and "scheduled work
          // only when the screen actually changed".
          if (
            current.screen === plain &&
            current.screenMarkdown === markdown &&
            current.recentScreen === recent &&
            current.recentScreenMarkdown === recentMarkdown &&
            pickerEqual(current.picker, picker)
          ) {
            return prev
          }
          // Detect Codex approval overlay from the screen. Only runs
          // for codex sessions — Claude has its own trust dialog path.
          //
          // Two sources feed `pendingApproval`:
          //   1. JSONL `exec_approval_request` — authoritative for
          //      `callId` / `command` / `workdir`. The callId is what
          //      we match against `exec_command_end` to dismiss.
          //   2. Screen scrape — authoritative for the dynamic UI bits
          //      the user actually sees (`reason`, `options`,
          //      `selectedIndex`) since arrow-key nav only updates the
          //      TUI, never the JSONL.
          //
          // Originally this handler clobbered the JSONL fields with
          // `callId: null`, which broke dismissal: when
          // `exec_command_end` arrived later, the comparison
          // `current.pendingApproval?.callId === resolvedCallId` saw
          // `null === "real-id"` and the modal stuck forever. Now we
          // MERGE — JSONL fields survive screen frames; screen fields
          // overwrite their counterparts on every frame.
          //
          // When the screen shows no overlay we PRESERVE a JSONL-sourced
          // approval (callId !== null) — the rule is "JSONL opens it,
          // JSONL closes it". A screen-only approval (callId === null)
          // can be cleared by a stale frame because there's no JSONL
          // dismissal event coming.
          const sessionKind = stateRef.current.sessions[sessionId]?.kind
          const screenApproval = sessionKind === 'codex'
            ? detectCodexApproval(plain)
            : null
          const nextApproval = screenApproval
            ? current.pendingApproval?.callId
              ? {
                  ...current.pendingApproval,
                  reason: screenApproval.reason,
                  options: screenApproval.options,
                  selectedIndex: screenApproval.selectedIndex,
                }
              : {
                  callId: null,
                  command: screenApproval.command
                    ? screenApproval.command.split(/\s+/)
                    : [],
                  workdir: null,
                  reason: screenApproval.reason,
                  options: screenApproval.options,
                  selectedIndex: screenApproval.selectedIndex,
                }
            : current.pendingApproval?.callId
              ? current.pendingApproval
              : null

          return {
            ...prev,
            [sessionId]: {
              ...current,
              screen: plain,
              screenMarkdown: markdown,
              recentScreen: recent,
              recentScreenMarkdown: recentMarkdown,
              picker,
              // activityStatus is owned by the process-state IPC handler
              // below — it carries the provider-correct verb (Claude's
              // spinner verb, Codex's bottom-row text). Recomputing it
              // here from `detectActivity(plain)` was Claude-specific
              // and would overwrite Codex's status with null on every
              // frame, racing the process-state writer.
              pendingApproval: nextApproval,
            },
          }
        })
      },
    )

    const offEntry = window.api.onSessionJsonlEntry(({ sessionId, entry }) => {
      if (isCodexRolloutEntry(entry)) {
        const codexId = extractCodexProviderSessionId(entry)
        if (codexId) {
          setState(prev => {
            const meta = prev.sessions[sessionId]
            if (!meta) return prev
            if (meta.providerSessionId === codexId) return prev
            if (meta.providerSessionId) return prev
            return {
              ...prev,
              sessions: {
                ...prev.sessions,
                [sessionId]: { ...meta, providerSessionId: codexId },
              },
            }
          })
        }

        const payload = entry.payload as Record<string, unknown> | undefined
        const mapped = mapCodexRolloutToFeedEntries(entry)
        const approvalRequest =
          entry.type === 'event_msg' && payload?.type === 'exec_approval_request'
            ? {
                callId: typeof payload.call_id === 'string' ? payload.call_id : null,
                command: Array.isArray(payload.command)
                  ? payload.command.filter(
                      (part): part is string => typeof part === 'string',
                    )
                  : [],
                workdir: typeof payload.workdir === 'string' ? payload.workdir : null,
              }
            : null
        const approvalResolvedCallId =
          entry.type === 'event_msg' &&
          payload?.type === 'exec_command_end' &&
          typeof payload.call_id === 'string'
            ? payload.call_id
            : null
        if (mapped.length === 0 && !approvalRequest && !approvalResolvedCallId) return

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          let baseEntries = current.entries
          const firstMapped = mapped[0]
          const lastExisting = current.entries[current.entries.length - 1]
          // Codex can sit on the raw-terminal path for a while before the
          // rollout file attaches. We inject an optimistic local user row at
          // submit time so the pane doesn't look dead, then drop it once the
          // real rollout user message lands. Match on adjacent text only —
          // conservative reconciliation is better than deleting real history.
          if (
            firstMapped?.type === 'user' &&
            isOptimisticCodexUserEntry(lastExisting) &&
            entryTextContent(lastExisting) === entryTextContent(firstMapped)
          ) {
            baseEntries = current.entries.slice(0, -1)
          }
          const nextEntries = [...baseEntries, ...mapped]
          // lastMapped can be undefined when mapped is empty — this
          // happens when only an approvalRequest or approvalResolvedCallId
          // triggered the handler (mapped.length === 0 passes through
          // the guard above). Guard with ?. to avoid crashing on
          // undefined.type.
          // Awaiting state is owned exclusively by the headless's
          // spinner-based process-state event. We used to flip it to
          // false here when an assistant entry arrived, but CC writes
          // assistant chunks MID-TURN (between tool cycles in a
          // multi-tool reply) while the spinner is still on screen —
          // and that flip caused the indicator to flash idle for the
          // ~500ms gap before the next spinner snapshot reasserted
          // active. The user reported this as "marks idle for a half
          // second between messages." Trust the headless signal.
          return {
            ...prev,
            [sessionId]: {
              ...current,
              entries: nextEntries,
              awaitingAssistant: current.awaitingAssistant,
              // Merge JSONL request with any screen-sourced fields
              // already in flight (reason / options / selectedIndex).
              // See the screen handler above for the dual-source rule.
              pendingApproval: approvalRequest
                ? {
                    ...approvalRequest,
                    reason: current.pendingApproval?.reason,
                    options: current.pendingApproval?.options,
                    selectedIndex: current.pendingApproval?.selectedIndex,
                  }
                : approvalResolvedCallId &&
                    current.pendingApproval?.callId === approvalResolvedCallId
                  ? null
                  : current.pendingApproval,
            },
          }
        })
        return
      }

      // ---------------------------------------------------------------
      // queue-operation entries are CC's internal message-queue
      // bookkeeping. See claude-code-src/utils/messageQueueManager.ts
      // for the emit sites. The operation field takes one of THREE
      // values, which I learned the hard way after the first pass of
      // this handler only knew about two:
      //
      //   'enqueue'  — append to the queue. Carries `content: string`.
      //   'dequeue'  — pop for processing. No content field.
      //   'remove'   — explicit removal by reference (via the remove()
      //                function in messageQueueManager). No content.
      //                Used for cancellations and bulk drains.
      //
      // Previously we only handled enqueue + dequeue. Any `remove` op
      // was silently dropped, so the queued list grew unbounded — on
      // session resume we'd replay every historical enqueue, never
      // balance them against the matching removes, and the pending-
      // queue strip would show phantom backlog from hours ago. The
      // user noticed this when they resumed a session and saw seven
      // of their own past prompts rendered as "queued".
      //
      // Both 'dequeue' and 'remove' just mean "the queue got smaller";
      // we don't care WHICH slot shrank since the rendering only
      // shows a FIFO preview. So we collapse them into a single
      // "shrink from head" op. This gives us a correct net queue
      // depth after full JSONL replay, which is what we show.
      //
      // We DON'T push these entries into `entries` — they'd render as
      // noise in the feed — and we DO keep `awaitingAssistant` true
      // whenever the queue is non-empty.
      // ---------------------------------------------------------------
      const entryType = (entry as { type?: string }).type
      if (entryType === 'queue-operation') {
        const op = entry as {
          operation?: 'enqueue' | 'dequeue' | 'remove'
          content?: string
          timestamp?: string
        }
        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          let nextQueue = current.queuedMessages
          if (op.operation === 'enqueue' && typeof op.content === 'string') {
            const ts = op.timestamp ?? String(Date.now())
            // Dedup by (timestamp + content) so a re-tail of the same
            // JSONL doesn't double-add. In the normal live case
            // timestamps are monotonically unique so this is a no-op;
            // in the re-subscribe case (reload, hot-reload during dev)
            // it's what keeps the backlog from duplicating.
            const already = current.queuedMessages.some(
              q => q.timestamp === ts && q.content === op.content,
            )
            if (!already) {
              nextQueue = [
                ...current.queuedMessages,
                { content: op.content, timestamp: ts },
              ]
            }
          } else if (
            op.operation === 'dequeue' ||
            op.operation === 'remove'
          ) {
            // Collapse both shrink ops into "drop head". This is
            // FIFO-correct for dequeue (which always pops highest
            // priority → on a simple one-priority queue that's the
            // head) and approximately-correct for remove (which can
            // target an arbitrary slot but we don't have the identity
            // info to do better). The visible list might show a
            // slightly-wrong preview for a frame or two when CC
            // cancels a mid-queue item, but the total depth stays
            // right, which is what the rendering actually needs.
            nextQueue = current.queuedMessages.slice(1)
          }
          return {
            ...prev,
            [sessionId]: {
              ...current,
              queuedMessages: nextQueue,
              // Force the streaming flag on whenever the queue has
              // items so the streaming card doesn't disappear between
              // turns while CC is draining queued work.
              awaitingAssistant:
                nextQueue.length > 0 ? true : current.awaitingAssistant,
            },
          }
        })
        return
      }

      // Capture CC's own session UUID from the first entry that
      // carries one, and persist it into SessionMeta.providerSessionId so
      // the next app launch can pass --resume <uuid> to spawnSession
      // and get the same conversation back. Without this, every
      // reload is a fresh blank session — the tile tree survives
      // but the Claude context dies.
      //
      // Every JSONL entry CC writes includes its own `sessionId`
      // field (see src/core/types/transcript.ts and the CC source
      // at claude-code-src/utils/sessionStorage.ts). We take the
      // FIRST one we see per cc-shell session and never overwrite,
      // because (a) it's stable for the lifetime of the CC process
      // and (b) updating it on every entry would produce a
      // persistence storm.
      //
      // The check is a second setState call on `state` (not a
      // merge into the `setRuntimes` call below) because sessions
      // live in the persisted workspace state, not the live
      // runtime. The debounced save effect (useEffect on [state])
      // picks it up automatically and flushes to workspace.json.
      const ccId = (entry as { sessionId?: string }).sessionId
      if (typeof ccId === 'string' && ccId.length > 0) {
        setState(prev => {
          const meta = prev.sessions[sessionId]
          if (!meta) return prev
          if (meta.providerSessionId === ccId) return prev
          // Guard: once captured, never overwrite. A resumed session
          // that receives fresh entries tagged with the same
          // providerSessionId is a no-op (first branch catches it); a
          // resumed session that somehow receives entries with a
          // DIFFERENT sessionId would indicate a bug upstream, and
          // we'd rather keep the original value than track the
          // mutation.
          if (meta.providerSessionId) return prev
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [sessionId]: { ...meta, providerSessionId: ccId },
            },
          }
        })
      }

      const feedEntry =
        extractEmbeddedClaudeProgressEntry(entry as Record<string, unknown>) ??
        (entry as Entry)
      const uuid = (feedEntry as { uuid?: string }).uuid
      const seen = (seenUuidsRef.current[sessionId] ??= new Set())
      if (uuid) {
        if (seen.has(uuid)) return
        seen.add(uuid)
      }

      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const nextEntries = [...current.entries, feedEntry]
        // Awaiting state is owned by the headless's spinner-based
        // process-state event — see the matching comment in the
        // codex-rollout handler above for why we no longer flip it on
        // assistant JSONL entries.
        return {
          ...prev,
          [sessionId]: {
            ...current,
            entries: nextEntries,
            awaitingAssistant: current.awaitingAssistant,
            // The compact-summary feed entry IS the completion signal —
            // it's only written after CC finishes the summarization turn.
            // We previously gated this on `phase === 'done'` but nothing
            // ever wrote that phase, so the banner stuck until a manual
            // dismiss. Clearing unconditionally on the summary entry is
            // the intended behavior.
            pendingCompaction: isCompactSummaryEntry(feedEntry)
              ? null
              : current.pendingCompaction,
          },
        }
      })
    })

    const offErr = window.api.onSessionJsonlError(({ sessionId, message }) => {
      // eslint-disable-next-line no-console
      console.warn(`[jsonl ${sessionId.slice(0, 8)}]`, message)
    })

    const offExit = window.api.onSessionExit(({ sessionId, exitCode }) => {
      updateRuntime(sessionId, { exited: exitCode })
    })

    // Provider-emitted activity state. Both providers now derive this
    // from their own screen spinner detector — Claude's rotating-glyph
    // line, Codex's bottom "Working (...)" row — and forward the
    // verb/status string alongside the boolean. When status arrives
    // we adopt it directly; the renderer used to redundantly run
    // Claude's detectActivity on every screen frame to derive the
    // verb, which was both wasteful and wrong for Codex (the parser
    // is Claude-specific). On idle transitions, status is undefined
    // and we clear activityStatus too.
    const offProcessState = window.api.onSessionProcessState(({ sessionId, active, status }) => {
      updateRuntime(sessionId, {
        awaitingAssistant: active,
        activityStatus: active ? (status ?? null) : null,
      })
    })

    const offTrustDialog = window.api.onSessionTrustDialog(({ sessionId, visible, workspace }) => {
      updateRuntime(sessionId, {
        pendingTrustDialog: visible ? { workspace } : null,
      })
    })

    const offResumePrompt = window.api.onSessionResumePrompt(({
      sessionId,
      visible,
      sessionAgeText,
      tokenCountText,
      options,
      selectedIndex,
    }) => {
      updateRuntime(sessionId, {
        pendingResumePrompt: visible
          ? { sessionAgeText, tokenCountText, options, selectedIndex }
          : null,
      })
    })

    const offCompactionState = window.api.onSessionCompactionState(({
      sessionId,
      visible,
      phase,
      statusText,
      errorText,
    }) => {
      updateRuntime(sessionId, {
        pendingCompaction: visible && phase
          ? { phase, statusText, errorText }
          : null,
      })
    })

    return () => {
      offStarted()
      offScreen()
      offEntry()
      offErr()
      offProcessState()
      offTrustDialog()
      offResumePrompt()
      offCompactionState()
      offExit()
    }
  }, [updateRuntime])

  // ---- Action: spawn a new session (main process call) ----
  //
  // Wrapped so callers don't have to touch window.api directly. Updates
  // state.sessions synchronously after main responds with an id.
  //
  // `resumeSessionId` (optional) triggers a resume: main spawns claude
  // with `--resume <uuid>` and tails the existing session file, so the
  // renderer receives the full session history as jsonl-entry events
  // immediately after started. Our own sessionId is still fresh — it's
  // a workspace-scoped identifier for routing, distinct from CC's
  // session UUID.
  const spawn = useCallback(
    async (
      cwd: string,
      opts?: {
        resumeSessionId?: string
        kind?: SessionKind
        /** Forwarded to the spawn IPC. Used by undo-close to attach
         *  to the same tmux session that backed the closed terminal,
         *  preserving scrollback and any running process. */
        recoverTmuxName?: string
      },
    ): Promise<SessionId> => {
      const kind: SessionKind = opts?.kind ?? 'claude'
      const { sessionId, tmuxName } = await window.api.spawnSession({
        kind,
        cwd,
        resumeSessionId: opts?.resumeSessionId,
        recoverTmuxName: opts?.recoverTmuxName,
      })
      setState(prev => ({
        ...prev,
        sessions: {
          ...prev.sessions,
          // Persist tmuxName when main returns one — that's the
          // signal that this terminal got tmux backing and is eligible
          // for cross-restart recovery on next launch.
          [sessionId]: { cwd, kind, ...(tmuxName ? { tmuxName } : {}) },
        },
      }))
      setRuntimes(prev => ({ ...prev, [sessionId]: emptyRuntime() }))
      return sessionId
    },
    [],
  )

  // ---- Action: kill a session (main process call) ----
  const killSession = useCallback(async (sessionId: SessionId) => {
    await window.api.killSession(sessionId)
    setRuntimes(prev => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    setState(prev => {
      const nextSessions = { ...prev.sessions }
      delete nextSessions[sessionId]
      return { ...prev, sessions: nextSessions }
    })
    delete seenUuidsRef.current[sessionId]
    delete latestScreenRef.current[sessionId]
  }, [])

  // ---- Action: replace the focused session in-place ----
  //
  // Kills the current session in the focused leaf and spawns a new one
  // in the same position. Used by the resume flow to swap a session
  // without changing the tile tree structure — the pane stays where it
  // is, only its backing session changes.
  const replaceSession = useCallback(
    async (
      cwd: string,
      opts?: { resumeSessionId?: string; kind?: SessionKind },
    ) => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const oldId = tab.focusedSessionId

      // Kill the old session.
      await window.api.killSession(oldId)
      setRuntimes(prev => {
        const next = { ...prev }
        delete next[oldId]
        return next
      })
      delete seenUuidsRef.current[oldId]
      delete latestScreenRef.current[oldId]

      // Spawn the replacement.
      const newId = await spawn(cwd, opts)

      // Swap the sessionId in the tree. Walk the tile tree and replace
      // every occurrence of oldId with newId (there should be exactly
      // one — the focused leaf).
      const remapNode = (n: TileNode): TileNode => {
        if (n.type === 'leaf') {
          return n.sessionId === oldId
            ? { type: 'leaf', sessionId: newId }
            : n
        }
        return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
      }

      setState(prev => {
        const sessions = { ...prev.sessions }
        delete sessions[oldId]
        return {
          ...prev,
          tabs: prev.tabs.map(t => {
            if (t.id !== prev.activeTabId) return t
            return {
              ...t,
              root: remapNode(t.root),
              focusedSessionId:
                t.focusedSessionId === oldId ? newId : t.focusedSessionId,
            }
          }),
          sessions,
        }
      })
    },
    [spawn, state.activeTabId, state.tabs],
  )

  // ---- Action: new tab ----
  //
  // Spawns a new session in the given cwd, creates a tab with one leaf,
  // and makes it active. Pass `resumeSessionId` to resume an existing
  // CC session rather than starting a fresh one.
  const newTab = useCallback(
    async (cwd: string, resumeSessionId?: string, kind?: SessionKind) => {
      const sessionId = await spawn(cwd, { resumeSessionId, kind })
      const tabId = crypto.randomUUID()
      const title = titleFromCwd(cwd)
      setState(prev => {
        const newTab: Tab = {
          id: tabId,
          title,
          root: { type: 'leaf', sessionId },
          focusedSessionId: sessionId,
        }
        return {
          ...prev,
          tabs: [...prev.tabs, newTab],
          activeTabId: tabId,
        }
      })
      return { tabId, sessionId }
    },
    [spawn],
  )

  // ---- Action: close tab ----
  const closeTab = useCallback(
    async (tabId: TabId) => {
      const tab = state.tabs.find(t => t.id === tabId)
      if (!tab) return

      // Capture undo info before killing anything.
      const tabIdx = state.tabs.findIndex(t => t.id === tabId)
      const ids = collectLeaves(tab.root)
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const id of ids) {
        if (state.sessions[id]) allMetas[id] = state.sessions[id]
      }
      undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...tab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
      })
      // Surface a brief undo hint. The label uses the tab title so
      // the user can confirm at a glance which thing they killed.
      showToast(`Closed “${tab.title}” — ⌘⇧T to undo`)

      // Kill every session in this tab.
      await Promise.all(ids.map(id => window.api.killSession(id)))
      setRuntimes(prev => {
        const next = { ...prev }
        for (const id of ids) delete next[id]
        return next
      })
      for (const id of ids) {
        delete seenUuidsRef.current[id]
        delete latestScreenRef.current[id]
      }
      setState(prev => {
        const tabs = prev.tabs.filter(t => t.id !== tabId)
        const sessions = { ...prev.sessions }
        for (const id of ids) delete sessions[id]
        const activeTabId =
          prev.activeTabId === tabId
            ? (tabs[0]?.id ?? '')
            : prev.activeTabId
        return { ...prev, tabs, activeTabId, sessions }
      })
      setSpotlight(prev => (prev?.tabId === tabId ? null : prev))
    },
    [state.tabs, state.sessions],
  )

  // ---- Action: split the focused pane ----
  //
  // Spawns a new session in the parent pane's cwd, inserts a new leaf
  // under a fresh split node, makes the new pane focused.
  const splitFocused = useCallback(
    async (direction: SplitDirection, kind: SessionKind = 'claude') => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const parentSessionId = tab.focusedSessionId
      const parentCwd = state.sessions[parentSessionId]?.cwd
      if (!parentCwd) return

      const newSessionId = await spawn(parentCwd, { kind })

      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: splitLeaf(t.root, parentSessionId, direction, newSessionId),
            focusedSessionId: newSessionId,
          }
        }),
      }))
    },
    [spawn, state.activeTabId, state.sessions, state.tabs],
  )

  // ---- Action: close the focused pane ----
  //
  // Removes the leaf from the tree and kills its session. If the tree
  // collapses to nothing, closes the whole tab. If that was the last
  // tab, leaves the workspace in an empty state — the UI shows a
  // welcome screen prompting for a new tab.
  //
  // Before destroying anything, we capture undo info and push it onto
  // the undo-close stack so the user can restore the pane (or tab)
  // with a single command within the next 2 minutes.
  const closeFocused = useCallback(async () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    const targetId = tab.focusedSessionId
    const sessionMeta = state.sessions[targetId]

    // Capture undo info BEFORE mutating the tree. Two cases:
    //   1. Pane inside a split → record the parent split's geometry
    //      and the surviving sibling's anchor leaf so we can re-split.
    //   2. Last pane in a tab → record the whole tab so we can
    //      re-insert it at the same index.
    const parentInfo = findParentSplitInfo(tab.root, targetId)
    if (parentInfo && sessionMeta) {
      undoStackRef.current.push({
        type: 'pane',
        closedAt: Date.now(),
        tabId: tab.id,
        sessionMeta,
        direction: parentInfo.direction,
        ratio: parentInfo.ratio,
        side: parentInfo.side,
        siblingLeafId: parentInfo.siblingLeafId,
      })
      // Pane-level close — show the kind+cwd basename so the user
      // can recognize which pane they killed when several look alike.
      const kindLabel = sessionMeta.kind ?? 'claude'
      const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
      showToast(`Closed ${kindLabel} pane (${cwdBase}) — ⌘⇧T to undo`)
    } else if (!parentInfo && sessionMeta) {
      // This pane IS the root — closing it kills the tab. Capture
      // the tab-level undo entry.
      const tabIdx = state.tabs.findIndex(t => t.id === tab.id)
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const leafId of collectLeaves(tab.root)) {
        if (state.sessions[leafId]) allMetas[leafId] = state.sessions[leafId]
      }
      undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...tab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
      })
      // Tab-level close — same shape as closeTab's toast for
      // consistency, since the user closed an entire tab here too.
      showToast(`Closed “${tab.title}” — ⌘⇧T to undo`)
    }

    await window.api.killSession(targetId)

    setRuntimes(prev => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    delete seenUuidsRef.current[targetId]
    delete latestScreenRef.current[targetId]

    setState(prev => {
      const tabs = [...prev.tabs]
      const tabIdx = tabs.findIndex(t => t.id === prev.activeTabId)
      if (tabIdx === -1) return prev
      const currentTab = tabs[tabIdx]
      const nextRoot = closeLeaf(currentTab.root, targetId)

      if (nextRoot === null) {
        // Tab is now empty — close it and activate another tab.
        const remaining = tabs.filter((_, i) => i !== tabIdx)
        const sessions = { ...prev.sessions }
        delete sessions[targetId]
        return {
          ...prev,
          tabs: remaining,
          activeTabId: remaining[Math.max(0, tabIdx - 1)]?.id ?? '',
          sessions,
        }
      }

      // Pick a new focused session — prefer the first leaf in the tree.
      const nextFocused = collectLeaves(nextRoot)[0]
      tabs[tabIdx] = {
        ...currentTab,
        root: nextRoot,
        focusedSessionId: nextFocused,
      }
      const sessions = { ...prev.sessions }
      delete sessions[targetId]
      return { ...prev, tabs, sessions }
    })
  }, [state.activeTabId, state.tabs, state.sessions])

  // ---- Action: focus a specific session in the active tab ----
  const focusSession = useCallback((sessionId: SessionId) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
      ),
    }))
    setSpotlight(prev => (
      prev && prev.tabId === stateRef.current.activeTabId
        ? { ...prev, focusedSessionId: sessionId }
        : prev
    ))
  }, [])

  const focusSessionInTab = useCallback((tabId: TabId, sessionId: SessionId) => {
    setState(prev => ({
      ...prev,
      activeTabId: tabId,
      tabs: prev.tabs.map(t =>
        t.id === tabId ? { ...t, focusedSessionId: sessionId } : t,
      ),
    }))
    setSpotlight(prev => (
      prev && prev.tabId === tabId
        ? { ...prev, focusedSessionId: sessionId }
        : prev
    ))
    setTileTabs(prev => (
      prev && prev.tabIds.includes(tabId)
        ? { ...prev, focusedTabId: tabId }
        : prev
    ))
  }, [])

  // ---- Action: navigate focus geometrically (alt-hjkl) ----
  const navigate = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const next = findNeighbor(tab.root, tab.focusedSessionId, direction)
      if (next) focusSession(next)
    },
    [focusSession, state.activeTabId, state.tabs],
  )

  // ---- Action: activate a tab by id or index ----
  const activateTab = useCallback((tabId: TabId) => {
    setState(prev => ({ ...prev, activeTabId: tabId }))
    setSpotlight(null)
    setTileTabs(prev => (prev && prev.tabIds.includes(tabId)
      ? { ...prev, focusedTabId: tabId }
      : null))
  }, [])

  const activateTabByIndex = useCallback((index: number) => {
    setState(prev => {
      const t = prev.tabs[index]
      return t ? { ...prev, activeTabId: t.id } : prev
    })
    setSpotlight(null)
    setTileTabs(prev => {
      const target = stateRef.current.tabs[index]
      if (!target) return prev
      return prev && prev.tabIds.includes(target.id)
        ? { ...prev, focusedTabId: target.id }
        : null
    })
  }, [])

  const nextTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId = tiled.tabIds[(idx + 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx + 1) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [tileTabs])

  const prevTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId =
        tiled.tabIds[(idx - 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx - 1 + prev.tabs.length) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [tileTabs])

  const toggleSpotlight = useCallback(() => {
    const current = stateRef.current
    const activeTab = current.tabs.find(t => t.id === current.activeTabId)
    if (!activeTab) return
    setTileTabs(null)
    setSpotlight(prev => {
      if (prev?.tabId === activeTab.id) return null
      return {
        tabId: activeTab.id,
        focusedSessionId: activeTab.focusedSessionId,
      }
    })
  }, [])

  const setSpotlightSession = useCallback((sessionId: SessionId) => {
    setSpotlight(prev => (prev ? { ...prev, focusedSessionId: sessionId } : prev))
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
      ),
    }))
  }, [])

  const openTileTabs = useCallback(
    (tabIds: TabId[], direction: SplitDirection = 'vertical') => {
      const current = stateRef.current
      const valid = tabIds.filter(id => current.tabs.some(t => t.id === id))
      if (valid.length < 2) return
      const focusedTabId = valid.includes(current.activeTabId)
        ? current.activeTabId
        : valid[0]
      setSpotlight(null)
      setTileTabs({
        tabIds: valid,
        focusedTabId,
        direction,
        ratios: equalRatios(valid.length),
      })
      setState(prev => ({ ...prev, activeTabId: focusedTabId }))
    },
    [],
  )

  const closeTileTabs = useCallback(() => {
    setTileTabs(null)
  }, [])

  const focusTiledTab = useCallback((tabId: TabId) => {
    setTileTabs(prev => (
      prev && prev.tabIds.includes(tabId)
        ? { ...prev, focusedTabId: tabId }
        : prev
    ))
    setState(prev => ({ ...prev, activeTabId: tabId }))
  }, [])

  const focusTiledTabByIndex = useCallback((index: number) => {
    setTileTabs(prev => {
      if (!prev) return prev
      const tabId = prev.tabIds[index]
      if (!tabId) return prev
      setState(statePrev => ({ ...statePrev, activeTabId: tabId }))
      return { ...prev, focusedTabId: tabId }
    })
  }, [])

  const resizeFocusedTiledTab = useCallback((delta: number) => {
    setTileTabs(prev => {
      if (!prev || prev.tabIds.length < 2) return prev
      const idx = prev.tabIds.indexOf(prev.focusedTabId)
      if (idx === -1) return prev

      const leftIndex = idx === prev.tabIds.length - 1 ? idx - 1 : idx
      const rightIndex = idx === prev.tabIds.length - 1 ? idx : idx + 1
      if (leftIndex < 0 || rightIndex >= prev.ratios.length) return prev

      const nextRatios = [...prev.ratios]
      const signedDelta = idx === prev.tabIds.length - 1 ? -delta : delta
      const nextLeft = nextRatios[leftIndex] + signedDelta
      const nextRight = nextRatios[rightIndex] - signedDelta
      const minRatio = 0.12
      if (nextLeft < minRatio || nextRight < minRatio) return prev

      nextRatios[leftIndex] = nextLeft
      nextRatios[rightIndex] = nextRight
      return {
        ...prev,
        ratios: normalizeRatios(nextRatios),
      }
    })
  }, [])

  const resizeTiledTabByIndex = useCallback((index: number, delta: number) => {
    setTileTabs(prev => {
      if (!prev || prev.tabIds.length < 2) return prev
      if (index < 0 || index >= prev.tabIds.length) return prev

      const leftIndex = index === prev.tabIds.length - 1 ? index - 1 : index
      const rightIndex = index === prev.tabIds.length - 1 ? index : index + 1
      if (leftIndex < 0 || rightIndex >= prev.ratios.length) return prev

      const nextRatios = [...prev.ratios]
      const signedDelta = index === prev.tabIds.length - 1 ? -delta : delta
      const nextLeft = nextRatios[leftIndex] + signedDelta
      const nextRight = nextRatios[rightIndex] - signedDelta
      const minRatio = 0.12
      if (nextLeft < minRatio || nextRight < minRatio) return prev

      nextRatios[leftIndex] = nextLeft
      nextRatios[rightIndex] = nextRight
      return {
        ...prev,
        ratios: normalizeRatios(nextRatios),
      }
    })
  }, [])

  // ---- Action: adjust the ratio of the split containing the focused pane ----
  const resizeFocused = useCallback((delta: number) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t => {
        if (t.id !== prev.activeTabId) return t
        return {
          ...t,
          root: adjustNearestSplitRatio(t.root, t.focusedSessionId, delta),
        }
      }),
    }))
  }, [])

  // ---- Action: directional resize (⌥⇧← → ↑ ↓) ----
  //
  // Grows the focused pane toward the given direction by `delta`. See
  // resizeInDirection in treeOps.ts for the full tmux-style semantics.
  const resizeFocusedDirectional = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down', delta: number) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: resizeInDirection(t.root, t.focusedSessionId, direction, delta),
          }
        }),
      }))
    },
    [],
  )

  // ---- Action: set the ratio of a specific split (for drag resize) ----
  // Walks the tree and finds the split whose `a` side contains fromId
  // and whose `b` side contains toId, then sets its ratio directly.
  const setSplitRatio = useCallback(
    (fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return { ...t, root: setRatioBetween(t.root, fromSessionId, toSessionId, ratio) }
        }),
      }))
    },
    [],
  )

  const setSplitRatioInTab = useCallback(
    (tabId: TabId, fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => {
      setState(prev => ({
        ...prev,
        activeTabId: tabId,
        tabs: prev.tabs.map(t => {
          if (t.id !== tabId) return t
          return { ...t, root: setRatioBetween(t.root, fromSessionId, toSessionId, ratio) }
        }),
      }))
      setTileTabs(prev => (
        prev && prev.tabIds.includes(tabId)
          ? { ...prev, focusedTabId: tabId }
          : prev
      ))
    },
    [],
  )

  // ---- Update streaming baseline for a session (called from TileLeaf on submit) ----
  const setStreamingBaseline = useCallback(
    (sessionId: SessionId, baseline: string | null) => {
      updateRuntime(sessionId, { streamingBaseline: baseline, awaitingAssistant: true })
    },
    [updateRuntime],
  )

  // Codex live rendering is TUI-first, with rollout JSON as a later source
  // of truth. That means a broken/missing rollout attach should NOT leave the
  // feed blank after submit. We add a local user row immediately and reconcile
  // it away when the real rollout user message shows up.
  const addOptimisticCodexUserEntry = useCallback((sessionId: SessionId, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      const last = current.entries[current.entries.length - 1]
      if (isOptimisticCodexUserEntry(last) && entryTextContent(last) === trimmed) {
        return prev
      }
      const optimistic: Entry = {
        type: 'user',
        uuid: `optimistic-codex-user:${Date.now()}`,
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: trimmed }],
        },
      }
      return {
        ...prev,
        [sessionId]: {
          ...current,
          entries: [...current.entries, optimistic],
        },
      }
    })
  }, [])

  const removeOptimisticCodexUserEntry = useCallback((sessionId: SessionId, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current || current.entries.length === 0) return prev
      const last = current.entries[current.entries.length - 1]
      if (!isOptimisticCodexUserEntry(last) || entryTextContent(last) !== trimmed) {
        return prev
      }
      return {
        ...prev,
        [sessionId]: {
          ...current,
          entries: current.entries.slice(0, -1),
        },
      }
    })
  }, [])

  // ---- Update the per-session draft input (composer text) ----
  //
  // Called from TileLeaf on every onChange/onKeyDown that mutates the
  // composer text. Lives in runtime so it survives TileLeaf unmount
  // when the user switches tabs. See SessionRuntime.draftInput for
  // the reasoning.
  // Draft version counter — bumped on every draft change so the save
  // effect picks it up without watching the full runtimes object.
  const [draftVersion, setDraftVersion] = useState(0)

  const setDraftInput = useCallback(
    (sessionId: SessionId, text: string) => {
      updateRuntime(sessionId, { draftInput: text })
      setDraftVersion(v => v + 1)
    },
    [updateRuntime],
  )

  // ---- Pane toast: transient feedback above the composer ----
  //
  // Single-slot, auto-dismiss. Calling showPaneToast while a previous
  // toast is still visible replaces it and resets the timer. The
  // timeout ref lives outside React state so we can clear it without
  // causing a re-render.
  const paneToastTimers = useRef<Record<SessionId, ReturnType<typeof setTimeout>>>({})

  const showPaneToast = useCallback(
    (sessionId: SessionId, message: string, durationMs = 2000) => {
      // Clear any in-flight timer for this pane.
      const prev = paneToastTimers.current[sessionId]
      if (prev) clearTimeout(prev)

      updateRuntime(sessionId, { paneToast: message })

      paneToastTimers.current[sessionId] = setTimeout(() => {
        updateRuntime(sessionId, { paneToast: null })
        delete paneToastTimers.current[sessionId]
      }, durationMs)
    },
    [updateRuntime],
  )

  // ---- Persist to disk on every mutation (debounced) ----
  //
  // The save is extracted into a stable helper so it can be called both
  // from the debounce timer AND from the beforeunload flush below. We
  // keep a ref to the latest state so the beforeunload handler (which
  // can't close over React state) always serializes the freshest version.
  const latestStateRef = useRef(state)
  latestStateRef.current = state

  const flushSave = useCallback(() => {
    const s = latestStateRef.current
    // Collect non-empty drafts so in-progress prompts survive crashes.
    const drafts: Record<SessionId, string> = {}
    for (const [id, rt] of Object.entries(latestRuntimesRef.current)) {
      if (rt.draftInput) drafts[id] = rt.draftInput
    }
    const persisted: PersistedWorkspace = {
      tabs: s.tabs.map(t => ({
        id: t.id,
        title: t.title,
        focusedSessionId: t.focusedSessionId,
        root: t.root,
      })),
      activeTabId: s.activeTabId,
      sessions: s.sessions,
      drafts: Object.keys(drafts).length > 0 ? drafts : undefined,
    }
    const json = JSON.stringify({ workspace: persisted }, null, 2)
    void window.api.saveWorkspace(json).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[workspace] save failed:', err)
    })
  }, [])

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushSave, 400)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state, draftVersion, flushSave])

  // ---- Flush on window close ----
  //
  // The debounced save has a 400ms window where a mutation hasn't been
  // written yet. If the user quits the app during that window, the
  // latest state is lost — tabs vanish, sessions can't resume.
  //
  // Fix: listen for `beforeunload` (fires synchronously before the
  // renderer is torn down) and flush immediately. The IPC invoke is
  // async but Electron's main process receives the message before the
  // window actually closes — the write lands. This is the same pattern
  // VS Code uses for its workspace state.
  useEffect(() => {
    const onBeforeUnload = () => {
      // Cancel the debounced timer so we don't double-save.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      flushSave()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushSave])

  // ---- Load on first mount ----
  //
  // If there's persisted state, respawn every session in its saved
  // cwd (minting fresh sessionIds because main process ids are
  // ephemeral) and remap the tree to use the new ids. If there's no
  // saved state, spawn one default session in the default cwd.
  const bootRef = useRef(false)
  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    void (async () => {
      const json = await window.api.loadWorkspace()
      if (!json) {
        // Fresh install — create one default tab.
        const cwd = await window.api.defaultCwd()
        await newTab(cwd)
        return
      }
      try {
        // Single-user dev app — no schema versioning. If the load
        // fails for any reason (corrupt JSON, unexpected shape,
        // spawn error during rehydrate) we fall through to the
        // catch below and start fresh. No migrations, no version
        // gates.
        const parsed = JSON.parse(json) as { workspace: PersistedWorkspace }
        await rehydrate(parsed.workspace)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[workspace] load failed, starting fresh:', err)
        const cwd = await window.api.defaultCwd()
        await newTab(cwd)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Remap a persisted tree by replacing every sessionId with a freshly
   * spawned one (spawn happens as we walk). Returns the remapped tree
   * plus the old→new id mapping.
   *
   * Resume semantics: if the persisted SessionMeta carries a
   * `providerSessionId`, we pass it to the spawn call as `resumeSessionId`
   * so claude boots with `--resume <uuid>` and the full conversation
   * history — tool calls, transcript, queue state, the lot — comes
   * back. The cc-shell SessionId we mint here is a fresh routing
   * key; CC's own session UUID is the thing we care about preserving.
   *
   * The providerSessionId is ALSO threaded into freshSessions[newId] so
   * the runtime meta after rehydrate matches pre-reload state and
   * the next save cycle writes it straight back. Without this, the
   * first save after a resume would drop providerSessionId and the NEXT
   * reload would lose context again.
   *
   * Failure modes:
   *   - File missing / corrupted → CC will exit with a non-zero code
   *     shortly after spawn. Surfaces via the exit event as "exited"
   *     in the pane status strip. Not retried automatically — the
   *     user can close the pane and open a fresh one.
   *   - File locked by another process (rare) → same as above.
   *   - Spawn itself throws (IPC failure) → caught below and logged;
   *     the pane is simply missing from the rehydrated tree.
   */
  const rehydrate = useCallback(async (persisted: PersistedWorkspace) => {
    const idMap = new Map<SessionId, SessionId>()
    const freshSessions: Record<SessionId, SessionMeta> = {}

    // Spawn sessions in the order they appear in persisted.sessions.
    //
    // Each session carries its own `kind` (absent = 'claude' for
    // backwards compatibility with pre-terminal workspace.json
    // blobs). Terminal sessions don't have a transcript so the
    // resumeSessionId is silently ignored for them on the main
    // side — respawning just starts a fresh shell in the same cwd.
    for (const [oldId, meta] of Object.entries(persisted.sessions)) {
      try {
        const kind: SessionKind = meta.kind ?? 'claude'
        // For terminal sessions with a persisted tmuxName, pass it as
        // recoverTmuxName so main re-attaches the alive tmux session
        // (or falls back to fresh spawn if it died). Agents ignore
        // recoverTmuxName at the main side; safe to omit for them.
        const { sessionId: newId, tmuxName: nextTmuxName } = await window.api.spawnSession({
          kind,
          cwd: meta.cwd,
          resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
          recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
        })
        idMap.set(oldId, newId)
        // Carry the full meta forward — kind + providerSessionId +
        // tmuxName — so the next save cycle doesn't drop these and
        // cause the session to degrade on the NEXT reload. tmuxName
        // is replaced with whatever main reported (recovered name
        // when alive, fresh name when respawned).
        freshSessions[newId] = {
          ...meta,
          ...(nextTmuxName ? { tmuxName: nextTmuxName } : {}),
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[workspace] failed to respawn ${meta.cwd}:`, err)
      }
    }

    const remapNode = (n: TileNode): TileNode => {
      if (n.type === 'leaf') {
        const mapped = idMap.get(n.sessionId)
        return mapped
          ? { type: 'leaf', sessionId: mapped }
          : n // shouldn't happen, but fall through rather than crash
      }
      return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
    }

    const newTabs: Tab[] = persisted.tabs
      .map(t => {
        const remappedRoot = remapNode(t.root)
        const leaves = collectLeaves(remappedRoot)
        if (leaves.length === 0) return null
        const focused = idMap.get(t.focusedSessionId) ?? leaves[0]
        return {
          id: t.id,
          title: t.title,
          root: remappedRoot,
          focusedSessionId: focused,
        } satisfies Tab
      })
      .filter((t): t is Tab => t !== null)

    if (newTabs.length === 0) {
      const cwd = await window.api.defaultCwd()
      await newTab(cwd)
      return
    }

    const activeTabId =
      newTabs.find(t => t.id === persisted.activeTabId)?.id ?? newTabs[0].id

    setState({
      tabs: newTabs,
      activeTabId,
      sessions: freshSessions,
    })
    // Initialize empty runtimes for every session so TileLeaf renders
    // "thinking…" instead of undefined while the first frame of screen
    // data arrives.
    // Initialize runtimes, restoring persisted drafts so in-progress
    // prompts survive crashes and restarts.
    setRuntimes(() => {
      const out: Record<SessionId, SessionRuntime> = {}
      for (const [oldId, newId] of idMap.entries()) {
        const rt = emptyRuntime()
        // Restore draft from the persisted workspace if it exists.
        const draft = persisted.drafts?.[oldId]
        if (draft) rt.draftInput = draft
        out[newId] = rt
      }
      // Fill any sessions that weren't in the id map (shouldn't happen
      // but defensive).
      for (const id of Object.keys(freshSessions)) {
        if (!out[id]) out[id] = emptyRuntime()
      }
      return out
    })
  }, [newTab])

  // ---- Action: undo close ----
  //
  // Pops the most recent entry from the undo stack and restores it.
  // For panes: finds the surviving sibling in the current tree by its
  // anchor leaf, re-wraps it in a split with the restored session on
  // the correct side, and respawns the session (with --resume for
  // Claude sessions so the conversation comes back).
  //
  // For tabs: respawns every session in the tab, remaps the session
  // ids in the tree (since the new spawn produces new ids), and
  // re-inserts the tab at its original index (clamped to bounds).
  const undoClose = useCallback(async () => {
    const entry = undoStackRef.current.pop()
    if (!entry) return

    if (entry.type === 'pane') {
      // Find which tab the sibling leaf is in now.
      const targetTab = state.tabs.find(t =>
        collectLeaves(t.root).includes(entry.siblingLeafId),
      )
      if (!targetTab) return // sibling was also closed — stale undo

      // Respawn the session.
      //   - Claude/Codex with providerSessionId → pass --resume so
      //     the conversation history replays via JSONL.
      //   - Terminal with tmuxName → pass recoverTmuxName so the
      //     same tmux session is re-attached, preserving scrollback
      //     and any running process. Without this, "undo close" on
      //     a terminal would respawn an empty shell — defeating the
      //     point of having a tmux backing.
      const meta = entry.sessionMeta
      const newSessionId = await spawn(meta.cwd, {
        kind: meta.kind ?? 'claude',
        resumeSessionId: meta.providerSessionId,
        recoverTmuxName: meta.kind === 'terminal' ? meta.tmuxName : undefined,
      })

      setState(prev => {
        const tabs = prev.tabs.map(t => {
          if (t.id !== targetTab.id) return t
          const newRoot = reinsertPane(
            t.root,
            entry.siblingLeafId,
            newSessionId,
            entry.direction,
            entry.ratio,
            entry.side,
          )
          if (!newRoot) return t // anchor not found — bail
          return {
            ...t,
            root: newRoot,
            focusedSessionId: newSessionId,
          }
        })
        return { ...prev, tabs }
      })
    } else {
      // Tab undo: respawn every session and remap the tree.
      const idMap = new Map<SessionId, SessionId>()
      const freshSessions: Record<SessionId, SessionMeta> = {}

      for (const [oldId, meta] of Object.entries(entry.sessionMetas)) {
        try {
          const kind: SessionKind = meta.kind ?? 'claude'
          // Same per-kind recover hint as the pane-undo branch above:
          // tmuxName for terminals, providerSessionId for agents.
          const newId = await spawn(meta.cwd, {
            kind,
            resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
          })
          idMap.set(oldId, newId)
          freshSessions[newId] = meta
        } catch {
          // If one session fails to spawn, skip it — restore what we can.
        }
      }

      if (idMap.size === 0) return // nothing survived

      const remapNode = (n: TileNode): TileNode => {
        if (n.type === 'leaf') {
          const mapped = idMap.get(n.sessionId)
          return mapped ? { type: 'leaf', sessionId: mapped } : n
        }
        return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
      }

      const restoredRoot = remapNode(entry.tab.root)
      const leaves = collectLeaves(restoredRoot)
      if (leaves.length === 0) return

      const restoredFocused =
        idMap.get(entry.tab.focusedSessionId) ?? leaves[0]
      const restoredTab: Tab = {
        id: crypto.randomUUID(),
        title: entry.tab.title,
        root: restoredRoot,
        focusedSessionId: restoredFocused,
      }

      setState(prev => {
        const insertIdx = Math.min(entry.tabIndex, prev.tabs.length)
        const tabs = [...prev.tabs]
        tabs.splice(insertIdx, 0, restoredTab)
        return {
          ...prev,
          tabs,
          activeTabId: restoredTab.id,
        }
      })
    }
  }, [spawn, state.tabs])

  // ---- Action: normalize layout (soft) ----
  //
  // Keep the existing tree structure but set every split ratio to 0.5.
  // Equalizes spacing without rearranging panes — if you have three
  // vertical panes on the left and one on the right, they stay that
  // way but all dividers move to the midpoint.
  const normalizeLayout = useCallback(() => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId
          ? { ...t, root: equalizeRatios(t.root) }
          : t,
      ),
    }))
  }, [])

  // ---- Action: hard normalize layout ----
  //
  // Flatten the tree and rebuild as a balanced grid where every pane
  // gets equal space. Changes the arrangement — all panes end up in
  // a rows × cols grid. No sessions are spawned or killed.
  const hardNormalizeLayout = useCallback(() => {
    setState(prev => {
      const tab = prev.tabs.find(t => t.id === prev.activeTabId)
      if (!tab) return prev
      const leaves = collectLeaves(tab.root)
      if (leaves.length <= 1) return prev
      const newRoot = normalizeTree(leaves)
      return {
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === prev.activeTabId ? { ...t, root: newRoot } : t,
        ),
      }
    })
  }, [])

  // ---- Action: rotate layout ----
  //
  // Flip every split direction in the active tab's tree: vertical
  // becomes horizontal and vice versa. Turns rows into columns.
  const rotateLayout = useCallback(() => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId
          ? { ...t, root: rotateTree(t.root) }
          : t,
      ),
    }))
  }, [])

  /** Peek at the undo stack length — used by the command palette to
   *  show/hide the "Undo Close" command. */
  const undoCloseCount = undoStackRef.current.length

  const activeTab = useMemo(
    () => state.tabs.find(t => t.id === state.activeTabId) ?? null,
    [state.activeTabId, state.tabs],
  )

  useEffect(() => {
    if (!spotlight) return
    const tab = state.tabs.find(t => t.id === spotlight.tabId)
    if (!tab) {
      setSpotlight(null)
      return
    }
    const leaves = collectLeaves(tab.root)
    if (leaves.length === 0) {
      setSpotlight(null)
      return
    }
    if (!leaves.includes(spotlight.focusedSessionId)) {
      setSpotlight(prev => (prev ? { ...prev, focusedSessionId: leaves[0] } : prev))
    }
  }, [spotlight, state.tabs])

  useEffect(() => {
    if (!tileTabs) return
    const validTabIds = tileTabs.tabIds.filter(id => state.tabs.some(t => t.id === id))
    if (validTabIds.length < 2) {
      setTileTabs(null)
      return
    }
    const focusedTabId = validTabIds.includes(tileTabs.focusedTabId)
      ? tileTabs.focusedTabId
      : validTabIds[0]
    if (
      validTabIds.length !== tileTabs.tabIds.length ||
      focusedTabId !== tileTabs.focusedTabId
    ) {
      setTileTabs({
        ...tileTabs,
        tabIds: validTabIds,
        focusedTabId,
        ratios:
          tileTabs.ratios.length === validTabIds.length
            ? normalizeRatios(tileTabs.ratios)
            : equalRatios(validTabIds.length),
      })
      return
    }
    const normalizedRatios =
      tileTabs.ratios.length === validTabIds.length
        ? normalizeRatios(tileTabs.ratios)
        : equalRatios(validTabIds.length)
    if (!ratiosEqual(normalizedRatios, tileTabs.ratios)) {
      setTileTabs({
        ...tileTabs,
        ratios: normalizedRatios,
      })
    }
  }, [tileTabs, state.tabs])

  // ---- Status mode: color-coded pane headers ----
  const [statusMode, setStatusMode] = useState(false)
  const toggleStatusMode = useCallback(() => {
    setStatusMode(prev => !prev)
  }, [])

  return {
    state,
    runtimes,
    activeTab,
    spotlight,
    tileTabs,
    latestScreenRef,
    getRuntime,
    statusMode,
    toggleStatusMode,
    // actions
    newTab,
    closeTab,
    spawn,
    killSession,
    splitFocused,
    closeFocused,
    focusSession,
    focusSessionInTab,
    navigate,
    activateTab,
    activateTabByIndex,
    nextTab,
    prevTab,
    resizeFocused,
    resizeFocusedDirectional,
    setSplitRatio,
    setSplitRatioInTab,
    setStreamingBaseline,
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
    setDraftInput,
    showPaneToast,
    undoClose,
    undoCloseCount,
    normalizeLayout,
    hardNormalizeLayout,
    rotateLayout,
    replaceSession,
    toggleSpotlight,
    setSpotlightSession,
    openTileTabs,
    closeTileTabs,
    focusTiledTab,
    focusTiledTabByIndex,
    resizeFocusedTiledTab,
    resizeTiledTabByIndex,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

function equalRatios(count: number): number[] {
  if (count <= 0) return []
  return Array.from({ length: count }, () => 1 / count)
}

function normalizeRatios(ratios: number[]): number[] {
  if (ratios.length === 0) return []
  const total = ratios.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return equalRatios(ratios.length)
  return ratios.map(value => value / total)
}

function ratiosEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 0.0001) return false
  }
  return true
}

/**
 * Cheap structural comparison for SlashPickerState. The picker object
 * itself is always fresh (parsed anew from each terminal snapshot in
 * main), so reference equality never holds — we have to look at the
 * visible flag, the item count, and the per-item id + selected bit.
 * IDs are short strings, items cap at ~15, so this runs in microseconds
 * and is still vastly cheaper than letting a no-op screen frame
 * propagate into a React render.
 */
function pickerEqual(
  a: SlashPickerState,
  b: SlashPickerState,
): boolean {
  if (a.visible !== b.visible) return false
  if (a.items.length !== b.items.length) return false
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i]
    const y = b.items[i]
    if (x.id !== y.id || x.selected !== y.selected) return false
  }
  return true
}

function setRatioBetween(
  node: TileNode,
  aSession: SessionId,
  bSession: SessionId,
  ratio: number,
): TileNode {
  if (node.type === 'leaf') return node
  const leavesA = collectLeaves(node.a)
  const leavesB = collectLeaves(node.b)
  if (leavesA.includes(aSession) && leavesB.includes(bSession)) {
    return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) }
  }
  return {
    ...node,
    a: setRatioBetween(node.a, aSession, bSession, ratio),
    b: setRatioBetween(node.b, aSession, bSession, ratio),
  }
}

// Silence unused-var warning for RATIO_DEFAULT re-export path — used in treeOps.
void RATIO_DEFAULT
// Silence for useCallback imports we want explicit.
export { collectLeaves }
