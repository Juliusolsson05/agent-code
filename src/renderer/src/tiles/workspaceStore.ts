import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Entry } from '../../../core/types/transcript'
import { extractAssistantInProgress } from '../../../core/parsers/streamingScreen'
import {
  RATIO_DEFAULT,
  type SessionId,
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
  findNeighbor,
  resizeInDirection,
  splitLeaf,
} from './treeOps'

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

export type SessionRuntime = {
  /** Plain-text screen snapshot — source of truth for parsers. */
  screen: string
  /** Same screen with bold/italic reconstructed from cell attributes. */
  screenMarkdown: string
  /** Streaming-card baseline captured at submit time. */
  streamingBaseline: string | null
  /** Parsed JSONL entries for this session's feed. */
  entries: Entry[]
  /** True between "user pressed Enter" and "assistant entry lands in JSONL". */
  awaitingAssistant: boolean
  /** PTY exit code, null if still running. */
  exited: number | null
  /** CC's JSONL project dir (for tooltip / debug). */
  projectDir: string | null
  /** Slash command picker state parsed in main from the terminal buffer.
   *  Updated on every screen snapshot. The TileLeaf reacts to
   *  picker.visible flipping to decide whether to render the picker
   *  component and whether to route keys through the PTY. */
  picker: SlashPickerState
}

const emptyRuntime = (): SessionRuntime => ({
  screen: '',
  screenMarkdown: '',
  streamingBaseline: null,
  entries: [],
  awaitingAssistant: false,
  exited: null,
  projectDir: null,
  picker: { visible: false, items: [] },
})

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

const STORAGE_VERSION = 1

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
        latestScreenRef.current[sessionId] = plain
        updateRuntime(sessionId, {
          screen: plain,
          screenMarkdown: markdown,
          picker,
        })
      },
    )

    const offEntry = window.api.onSessionJsonlEntry(({ sessionId, entry }) => {
      const uuid = (entry as { uuid?: string }).uuid
      const seen = (seenUuidsRef.current[sessionId] ??= new Set())
      if (uuid) {
        if (seen.has(uuid)) return
        seen.add(uuid)
      }
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const nextEntries = [...current.entries, entry as Entry]
        const clearsAwaiting =
          (entry as { type?: string }).type === 'assistant'
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
    async (cwd: string, resumeSessionId?: string): Promise<SessionId> => {
      const sessionId = await window.api.spawnSession({ cwd, resumeSessionId })
      setState(prev => ({
        ...prev,
        sessions: { ...prev.sessions, [sessionId]: { cwd } },
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

  // ---- Action: new tab ----
  //
  // Spawns a new session in the given cwd, creates a tab with one leaf,
  // and makes it active. Pass `resumeSessionId` to resume an existing
  // CC session rather than starting a fresh one.
  const newTab = useCallback(
    async (cwd: string, resumeSessionId?: string) => {
      const sessionId = await spawn(cwd, resumeSessionId)
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
      // Kill every session in this tab.
      const ids = collectLeaves(tab.root)
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
    [state.tabs],
  )

  // ---- Action: split the focused pane ----
  //
  // Spawns a new session in the parent pane's cwd, inserts a new leaf
  // under a fresh split node, makes the new pane focused.
  const splitFocused = useCallback(
    async (direction: SplitDirection) => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const parentSessionId = tab.focusedSessionId
      const parentCwd = state.sessions[parentSessionId]?.cwd
      if (!parentCwd) return

      const newSessionId = await spawn(parentCwd)

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
  const closeFocused = useCallback(async () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    const targetId = tab.focusedSessionId

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
  }, [state.activeTabId, state.tabs])

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

  // ---- Persist to disk on every mutation (debounced) ----
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const persisted: PersistedWorkspace = {
        tabs: state.tabs.map(t => ({
          id: t.id,
          title: t.title,
          focusedSessionId: t.focusedSessionId,
          root: t.root,
        })),
        activeTabId: state.activeTabId,
        sessions: state.sessions,
      }
      const json = JSON.stringify(
        { version: STORAGE_VERSION, workspace: persisted },
        null,
        2,
      )
      void window.api.saveWorkspace(json).catch(err => {
        // eslint-disable-next-line no-console
        console.warn('[workspace] save failed:', err)
      })
    }, 400)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state])

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
        const parsed = JSON.parse(json) as {
          version: number
          workspace: PersistedWorkspace
        }
        if (parsed.version !== STORAGE_VERSION) throw new Error('version mismatch')
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
   */
  const rehydrate = useCallback(async (persisted: PersistedWorkspace) => {
    const idMap = new Map<SessionId, SessionId>()
    const freshSessions: Record<SessionId, SessionMeta> = {}

    // Spawn sessions in the order they appear in persisted.sessions.
    for (const [oldId, meta] of Object.entries(persisted.sessions)) {
      try {
        const newId = await window.api.spawnSession({ cwd: meta.cwd })
        idMap.set(oldId, newId)
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
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
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
