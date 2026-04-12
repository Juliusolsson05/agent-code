import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Entry } from '../../../shared/types/transcript'
import { detectActivity } from '../../../providers/claude/parsers/streamingScreen'
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
  /** Plain-text screen snapshot — source of truth for parsers. */
  screen: string
  /** Same screen with bold/italic reconstructed from cell attributes. */
  screenMarkdown: string
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
  /** Activity status detected from CC's screen buffer. Non-null when
   *  CC is actively working (spinner visible) — carries the verb text
   *  (e.g. "Cogitating…", "Reading file…"). Null when idle. Updated
   *  on every screen snapshot (~60 Hz) via detectActivity(). */
  activityStatus: string | null
}

const emptyRuntime = (): SessionRuntime => ({
  screen: '',
  screenMarkdown: '',
  streamingBaseline: null,
  entries: [],
  awaitingAssistant: false,
  queuedMessages: [],
  exited: null,
  projectDir: null,
  picker: { visible: false, items: [] },
  draftInput: '',
  activityStatus: null,
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

function mapCodexRolloutToFeedEntries(entry: Record<string, unknown>): Entry[] {
  if (entry.type !== 'response_item') return []
  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.type !== 'string') return []

  const uuid =
    `${String(entry.timestamp ?? Date.now())}:${String(payload.id ?? payload.call_id ?? payload.type)}`
  const timestamp =
    typeof entry.timestamp === 'string' ? entry.timestamp : undefined

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
    payload.type === 'function_call' &&
    typeof payload.call_id === 'string' &&
    typeof payload.name === 'string'
  ) {
    let input: unknown = { arguments: payload.arguments }
    if (typeof payload.arguments === 'string') {
      try {
        input = JSON.parse(payload.arguments)
      } catch {
        input = { arguments: payload.arguments }
      }
    }
    return [
      {
        type: 'assistant',
        uuid,
        parentUuid: null,
        timestamp,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: payload.call_id,
              name: payload.name,
              input,
            },
          ],
        },
      },
    ]
  }

  if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
    const output =
      typeof payload.output === 'string'
        ? payload.output
        : JSON.stringify(payload.output ?? '', null, 2)
    return [
      {
        type: 'user',
        uuid,
        parentUuid: null,
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: payload.call_id,
              content: output,
            },
          ],
        },
      },
    ]
  }

  return []
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
}

// ---------------------------------------------------------------------------
// The store hook
// ---------------------------------------------------------------------------

export type Workspace = ReturnType<typeof useWorkspace>

export function useWorkspace() {
  const [state, setState] = useState<WorkspaceState>({
    tabs: [],
    activeTabId: '',
    sessions: {},
  })

  // Per-session runtime state. Keyed by sessionId. NOT part of
  // persistent state — runtime rebuilds from IPC events after respawn.
  const [runtimes, setRuntimes] = useState<Record<SessionId, SessionRuntime>>({})

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
      ({ sessionId, plain, markdown, picker }) => {
        // latestScreenRef is the synchronous source of truth for the
        // Enter-baseline capture in TileLeaf — always update it, even
        // when we bail on React state below.
        latestScreenRef.current[sessionId] = plain

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
            pickerEqual(current.picker, picker)
          ) {
            return prev
          }
          return {
            ...prev,
            [sessionId]: {
              ...current,
              screen: plain,
              screenMarkdown: markdown,
              picker,
              activityStatus: detectActivity(plain),
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

        const mapped = mapCodexRolloutToFeedEntries(entry)
        if (mapped.length === 0) return

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
          const lastMapped = mapped[mapped.length - 1]
          const clearsAwaiting =
            lastMapped.type === 'assistant' && current.queuedMessages.length === 0
              ? false
              : current.awaitingAssistant
          return {
            ...prev,
            [sessionId]: {
              ...current,
              entries: nextEntries,
              awaitingAssistant: clearsAwaiting,
            },
          }
        })
        return
      }

      const uuid = (entry as { uuid?: string }).uuid
      const seen = (seenUuidsRef.current[sessionId] ??= new Set())
      if (uuid) {
        if (seen.has(uuid)) return
        seen.add(uuid)
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

      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const nextEntries = [...current.entries, entry as Entry]
        // Only clear awaitingAssistant on an assistant entry AND when
        // the queue is empty — if CC still has queued work to process,
        // the streaming card should stay live so the next turn's
        // "thinking…" is visible. Without this, submitting three
        // messages in a row would flash the streaming card on and off
        // between turns and make the UI feel broken.
        const isAssistant =
          (entry as { type?: string }).type === 'assistant'
        const clearsAwaiting =
          isAssistant && current.queuedMessages.length === 0
            ? false
            : current.awaitingAssistant
        return {
          ...prev,
          [sessionId]: {
            ...current,
            entries: nextEntries,
            awaitingAssistant: clearsAwaiting,
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

    return () => {
      offStarted()
      offScreen()
      offEntry()
      offErr()
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
      opts?: { resumeSessionId?: string; kind?: SessionKind },
    ): Promise<SessionId> => {
      const kind: SessionKind = opts?.kind ?? 'claude'
      const sessionId = await window.api.spawnSession({
        kind,
        cwd,
        resumeSessionId: opts?.resumeSessionId,
      })
      setState(prev => ({
        ...prev,
        sessions: {
          ...prev.sessions,
          [sessionId]: { cwd, kind },
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
  }, [])

  const activateTabByIndex = useCallback((index: number) => {
    setState(prev => {
      const t = prev.tabs[index]
      return t ? { ...prev, activeTabId: t.id } : prev
    })
  }, [])

  const nextTab = useCallback(() => {
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx + 1) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
  }, [])

  const prevTab = useCallback(() => {
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx - 1 + prev.tabs.length) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
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
  const setDraftInput = useCallback(
    (sessionId: SessionId, text: string) => {
      updateRuntime(sessionId, { draftInput: text })
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
    const persisted: PersistedWorkspace = {
      tabs: s.tabs.map(t => ({
        id: t.id,
        title: t.title,
        focusedSessionId: t.focusedSessionId,
        root: t.root,
      })),
      activeTabId: s.activeTabId,
      sessions: s.sessions,
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
  }, [state, flushSave])

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
        const newId = await window.api.spawnSession({
          kind,
          cwd: meta.cwd,
          resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
        })
        idMap.set(oldId, newId)
        // Carry the full meta forward — kind + providerSessionId — so the
        // next save cycle doesn't drop these and cause the session
        // to degrade on the NEXT reload.
        freshSessions[newId] = meta
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
    setRuntimes(() => {
      const out: Record<SessionId, SessionRuntime> = {}
      for (const id of Object.keys(freshSessions)) out[id] = emptyRuntime()
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

      // Respawn the session. For Claude sessions with a ccSessionId,
      // pass --resume so the conversation history replays via JSONL.
      const meta = entry.sessionMeta
      const newSessionId = await spawn(meta.cwd, {
        kind: meta.kind ?? 'claude',
        resumeSessionId: meta.providerSessionId,
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
          const newId = await spawn(meta.cwd, {
            kind,
            resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
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

  return {
    state,
    runtimes,
    activeTab,
    latestScreenRef,
    getRuntime,
    // actions
    newTab,
    closeTab,
    spawn,
    killSession,
    splitFocused,
    closeFocused,
    focusSession,
    navigate,
    activateTab,
    activateTabByIndex,
    nextTab,
    prevTab,
    resizeFocused,
    resizeFocusedDirectional,
    setSplitRatio,
    setStreamingBaseline,
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
    setDraftInput,
    undoClose,
    undoCloseCount,
    normalizeLayout,
    hardNormalizeLayout,
    rotateLayout,
    replaceSession,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
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
