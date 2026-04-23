import { useCallback } from 'react'

import { emptyRuntime, type SessionRuntime } from '../../workspaceState'
import type { SessionId, SessionKind, SessionMeta, TileNode } from '../../types'
import { closeLeaf, collectLeaves } from '../../tile-tree/treeOps'
import type { Tab } from '../../types'
import { sessionSpawnErrorMessage } from '../../spawn/errorMessage'
import {
  ghostsToPersist,
  reconcileUpstream,
} from '../../ghosts'
import { reduceGhostLogSansSuperseded as reduceGhostLog } from 'agent-transcript-parser/ghost'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from '../context'
import type { WorkspaceRefs } from '../refs'

// -----------------------------------------------------------------------------
// Session lifecycle actions.
//
// spawn              — main process call to create a new session. Returns the
//                      new sessionId. Updates state.sessions + runtimes
//                      synchronously. Schedules ghost-log bootstrap via
//                      setTimeout(0) so the fresh runtime lands first.
// killSession        — main process call to kill a session. Cleans up
//                      runtime, state.sessions, and per-session refs.
// replaceSession     — kill current focused session + spawn a new one in
//                      the same tile-tree slot. Used by resume picker and
//                      provider switch.
// reloadAgentSessions — recreate every Claude/Codex session with fresh
//                       dangerous-mode settings. Remaps panes + buried
//                       records onto the new ids.
// -----------------------------------------------------------------------------

export type SessionActions = {
  spawn: (
    cwd: string,
    opts?: {
      resumeSessionId?: string
      kind?: SessionKind
      dangerousMode?: boolean
      recoverTmuxName?: string
    },
  ) => Promise<SessionId>
  killSession: (sessionId: SessionId) => Promise<void>
  replaceSession: (
    cwd: string,
    opts?: { resumeSessionId?: string; kind?: SessionKind },
  ) => Promise<SessionId | undefined>
  reloadAgentSessions: (dangerousMode?: boolean) => Promise<void>
}

export function useSessionActions(
  state: { activeTabId: string; sessions: Record<SessionId, SessionMeta>; tabs: Tab[] },
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
): SessionActions {
  // spawn — wrapped so callers don't have to touch window.api
  // directly. Updates state.sessions synchronously after main
  // responds with an id.
  //
  // `resumeSessionId` (optional) triggers a resume: main spawns
  // claude with `--resume <uuid>` and tails the existing session
  // file, so the renderer receives the full session history as
  // jsonl-entry events immediately after started. Our own sessionId
  // is still fresh — it's a workspace-scoped identifier for routing,
  // distinct from CC's session UUID.
  const spawn = useCallback(
    async (
      cwd: string,
      opts?: {
        resumeSessionId?: string
        kind?: SessionKind
        dangerousMode?: boolean
        recoverTmuxName?: string
      },
    ): Promise<SessionId> => {
      const kind: SessionKind = opts?.kind ?? 'claude'
      const dangerousMode =
        opts?.dangerousMode ??
        (kind !== 'terminal' ? refs.dangerousAgentsRef.current : undefined)
      // Agent providers both accept `useProxy`; terminals ignore it.
      // Claude uses MITM proxy streaming, Codex uses a local Responses
      // proxy via `openai_base_url`.
      const useProxy =
        kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined
      let sessionId: SessionId
      let tmuxName: string | undefined
      try {
        const result = await window.api.spawnSession({
          kind,
          cwd,
          resumeSessionId: opts?.resumeSessionId,
          dangerousMode,
          useProxy,
          recoverTmuxName: opts?.recoverTmuxName,
        })
        sessionId = result.sessionId
        tmuxName = result.tmuxName
      } catch (err) {
        throw new Error(sessionSpawnErrorMessage(kind, err, useProxy === true))
      }
      setState(prev => ({
        ...prev,
        sessions: {
          ...prev.sessions,
          // Persist tmuxName when main returns one — that's the
          // signal that this terminal got tmux backing and is
          // eligible for cross-restart recovery on next launch.
          [sessionId]: {
            cwd,
            kind,
            ...(tmuxName ? { tmuxName } : {}),
            ...(kind !== 'terminal' && opts?.resumeSessionId
              ? { providerSessionId: opts.resumeSessionId }
              : {}),
          },
        },
      }))
      setRuntimes(prev => ({
        ...prev,
        [sessionId]: {
          ...emptyRuntime(),
          hasOlderHistory: kind !== 'terminal' && Boolean(opts?.resumeSessionId),
        },
      }))

      // Ghost log bootstrap — fire-and-forget, no await. If a prior
      // run of cc-shell persisted ghosts for this sessionId, replay
      // them through the atp reducer and merge into the runtime's
      // ghost map. The renderer then sees the same merged feed after
      // reload as it saw before. A missing file is not an error.
      //
      // WHY behind a setTimeout 0: spawnSession above set the fresh
      // runtime via setRuntimes(prev => ...) — that update is queued
      // and will land on the next tick. Reading the ghost log and
      // applying it synchronously would run against the PREVIOUS
      // runtime snapshot and its setRuntimes would clobber the
      // fresh empty runtime. Deferring by one tick lets the empty
      // runtime land first, then the bootstrap merge runs on top.
      setTimeout(() => {
        void window.api
          .ghostRead(sessionId)
          .then(rawEntries => {
            if (!rawEntries || rawEntries.length === 0) return
            const bootstrapped = reduceGhostLog(rawEntries as never[])
            if (bootstrapped.size === 0) return
            setRuntimes(prev => {
              const current = prev[sessionId]
              if (!current) return prev
              // Merge — disk ghosts only fill slots the runtime
              // hasn't already produced in this session. If a ghost
              // for the same uuid exists in-memory (rare; would mean
              // a live event beat the bootstrap read), prefer the
              // in-memory one because it's strictly fresher.
              let merged = new Map(current.ghosts)
              for (const [uuid, ghost] of bootstrapped) {
                if (!merged.has(uuid)) merged.set(uuid, ghost)
              }
              // Reconcile against whatever JSONL entries already
              // landed during the initial bootstrap burst. Without
              // this, ghosts for turns that already have committed
              // entries in `current.entries` would stay
              // un-superseded forever: the live JSONL ingest already
              // ran `reconcileUpstream` against the PREVIOUS (empty)
              // ghost map and found no matches; now that the real
              // ghosts are landing, nothing re-checks the
              // already-ingested entries. This pass fixes the
              // "crashed mid-turn, resumed with an orphan ghost that
              // actually got committed" case. See Task 7 of the
              // 2026-04-20 rendering-fixes plan.
              for (const entry of current.entries) {
                merged = reconcileUpstream(entry, merged)
              }
              // Persist any supersedes we just produced so the next
              // resume reads the ghosts already in their reconciled
              // state. `ghostsToPersist` diffs by updatedAt so it
              // only emits ghosts whose state actually changed in
              // this pass.
              for (const ghost of ghostsToPersist(current.ghosts, merged)) {
                window.api.ghostAppend(sessionId, ghost)
              }
              return {
                ...prev,
                [sessionId]: { ...current, ghosts: merged },
              }
            })
          })
          .catch(err => {
            // Ghost bootstrap failures are non-fatal — the session
            // still works, we just lose crash-recovered provisional
            // state. Log and move on.
            console.warn('[ghost] bootstrap read failed:', err)
          })
      }, 0)

      return sessionId
    },
    [refs.dangerousAgentsRef, refs.useProxyStreamingRef, setRuntimes, setState],
  )

  const killSession = useCallback(
    async (sessionId: SessionId) => {
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
      delete refs.seenUuidsRef.current[sessionId]
      delete refs.latestScreenRef.current[sessionId]
      // If a bootstrap debounce was in flight for this session,
      // cancel it — the session is gone; firing the deferred
      // bootstrapping→false flip later would be a no-op against a
      // missing runtime but it's cleaner to release the timer
      // immediately.
      const timer = refs.bootstrapTimersRef.current.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        refs.bootstrapTimersRef.current.delete(sessionId)
      }
    },
    [refs.bootstrapTimersRef, refs.latestScreenRef, refs.seenUuidsRef, setRuntimes, setState],
  )

  // Kills the current session in the focused leaf and spawns a new
  // one in the same position. Used by the resume flow to swap a
  // session without changing the tile tree structure — the pane
  // stays where it is, only its backing session changes.
  const replaceSession = useCallback(
    async (
      cwd: string,
      opts?: { resumeSessionId?: string; kind?: SessionKind },
    ): Promise<SessionId | undefined> => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const oldId = tab.focusedSessionId
      const nextKind = opts?.kind ?? state.sessions[oldId]?.kind ?? 'claude'
      const oldDraft = refs.latestRuntimesRef.current[oldId]?.draftInput ?? ''
      const newId = await spawn(cwd, opts)
      setRuntimes(prev => ({
        ...prev,
        [newId]: {
          ...(prev[newId] ?? emptyRuntime()),
          draftInput: oldDraft,
        },
      }))

      await window.api.killSession(oldId)
      setRuntimes(prev => {
        const next = { ...prev }
        delete next[oldId]
        return next
      })
      delete refs.seenUuidsRef.current[oldId]
      delete refs.latestScreenRef.current[oldId]

      // Swap the sessionId in the tree. Walk the tile tree and
      // replace every occurrence of oldId with newId (there should
      // be exactly one — the focused leaf).
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
        // Persist the replacement provider metadata immediately
        // instead of waiting for the first transcript line to
        // round-trip back from main. That wait window is usually
        // short, but it is still a real race: a workspace save or
        // pane action that snapshots SessionMeta in that gap would
        // see "new session id, but no providerSessionId yet" and
        // could forget how to resume the pane on the next launch.
        //
        // Keeping the requested resumeSessionId here makes
        // replaceSession the single source of truth for "this pane
        // now points at provider X's persisted transcript Y",
        // whether the trigger was the resume picker or the new
        // switch-provider flow.
        sessions[newId] = {
          ...(sessions[newId] ?? { cwd, kind: nextKind }),
          cwd,
          kind: nextKind,
          ...(opts?.resumeSessionId ? { providerSessionId: opts.resumeSessionId } : {}),
        }
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
      return newId
    },
    [
      refs.latestRuntimesRef,
      refs.latestScreenRef,
      refs.seenUuidsRef,
      setRuntimes,
      setState,
      spawn,
      state.activeTabId,
      state.sessions,
      state.tabs,
    ],
  )

  // Recreates every Claude/Codex session with the requested
  // dangerous mode, then remaps visible panes and buried records
  // onto the fresh session ids. Plain terminal sessions are left
  // untouched.
  const reloadAgentSessions = useCallback(
    async (dangerousMode = refs.dangerousAgentsRef.current) => {
      const current = refs.stateRef.current
      const agentEntries = Object.entries(current.sessions).filter(([, meta]) => {
        const kind = meta.kind ?? 'claude'
        return kind === 'claude' || kind === 'codex'
      })
      if (agentEntries.length === 0) return

      const oldRuntimes = refs.latestRuntimesRef.current
      const idMap = new Map<SessionId, SessionId>()
      const failedIds = new Set<SessionId>()
      const freshSessions: Record<SessionId, SessionMeta> = {}

      for (const [oldId, meta] of agentEntries) {
        try {
          await window.api.killSession(oldId)
        } catch {
          // Kill failures still fall through to respawn — the old
          // process may already be gone.
        }

        delete refs.seenUuidsRef.current[oldId]
        delete refs.latestScreenRef.current[oldId]

        try {
          const kind: SessionKind = meta.kind ?? 'claude'
          const { sessionId: newId } = await window.api.spawnSession({
            kind,
            cwd: meta.cwd,
            resumeSessionId: meta.providerSessionId,
            dangerousMode,
            useProxy: kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined,
          })
          idMap.set(oldId, newId)
          freshSessions[newId] = { ...meta }
        } catch {
          failedIds.add(oldId)
        }
      }

      if (idMap.size === 0 && failedIds.size === 0) return

      const remapNode = (node: TileNode): TileNode => {
        if (node.type === 'leaf') {
          const mapped = idMap.get(node.sessionId)
          return mapped ? { type: 'leaf', sessionId: mapped } : node
        }
        return { ...node, a: remapNode(node.a), b: remapNode(node.b) }
      }

      setRuntimes(prev => {
        const next: Record<SessionId, SessionRuntime> = { ...prev }
        for (const [oldId] of agentEntries) delete next[oldId]
        for (const [oldId, newId] of idMap.entries()) {
          const restored = emptyRuntime()
          restored.draftInput = oldRuntimes[oldId]?.draftInput ?? ''
          restored.hasOlderHistory = Boolean(freshSessions[newId]?.providerSessionId)
          next[newId] = restored
        }
        return next
      })

      setState(prev => {
        const nextSessions = { ...prev.sessions }
        for (const [oldId] of agentEntries) delete nextSessions[oldId]
        for (const [newId, meta] of Object.entries(freshSessions)) {
          nextSessions[newId] = meta
        }

        const nextTabs = prev.tabs
          .map(tab => {
            let root: TileNode | null = remapNode(tab.root)
            for (const failedId of failedIds) {
              root = closeLeaf(root!, failedId)
              if (root === null) break
            }
            if (root === null) return null
            const leaves = collectLeaves(root)
            if (leaves.length === 0) return null
            const focusedSessionId = idMap.get(tab.focusedSessionId)
              ?? (failedIds.has(tab.focusedSessionId) ? leaves[0] : tab.focusedSessionId)
            return {
              ...tab,
              root,
              focusedSessionId,
            } satisfies Tab
          })
          .filter((tab): tab is Tab => tab !== null)

        const activeTabId = nextTabs.some(tab => tab.id === prev.activeTabId)
          ? prev.activeTabId
          : (nextTabs[0]?.id ?? '')

        const nextBuried = prev.buried
          .filter(entry => !failedIds.has(entry.sessionId))
          .map(entry => ({
            ...entry,
            id: idMap.get(entry.id) ?? entry.id,
            sessionId: idMap.get(entry.sessionId) ?? entry.sessionId,
            siblingLeafId: entry.siblingLeafId
              ? (idMap.get(entry.siblingLeafId) ?? entry.siblingLeafId)
              : undefined,
          }))

        return {
          ...prev,
          tabs: nextTabs,
          activeTabId,
          sessions: nextSessions,
          buried: nextBuried,
        }
      })
    },
    [
      refs.dangerousAgentsRef,
      refs.latestRuntimesRef,
      refs.latestScreenRef,
      refs.seenUuidsRef,
      refs.stateRef,
      refs.useProxyStreamingRef,
      setRuntimes,
      setState,
    ],
  )

  return { spawn, killSession, replaceSession, reloadAgentSessions }
}
