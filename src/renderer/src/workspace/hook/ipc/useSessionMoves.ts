import { useCallback, useEffect, useRef } from 'react'

import { isAgentSessionKind } from '@shared/types/providerKind'
import type {
  SessionMoveCancelled,
  SessionMoveCommitted,
  SessionMoveFailed,
  SessionMoveOffer,
} from '@shared/types/sessionMove'
import {
  buildSessionMovePacket,
  collectMoveSubtree,
  parseSessionMovePacket,
  receiveMovedSessions,
  type ReceiveMovedSessionsResult,
} from '@renderer/workspace/sessionMove'
import { workspaceWithoutSessions } from '@renderer/workspace/pool'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { forgetSessionViewState } from '@renderer/workspace/hook/actions/pane'
import { loadIncomingHistory, seedIncomingRuntimes } from '@renderer/workspace/hook/ipc/seedIncomingSessions'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, TabId } from '@renderer/workspace/types'

// Both halves of moving agents between two LIVE windows (#1481), in the
// renderer. Main owns routing and ordering (main/window/sessionMove.ts); the
// pure row logic is workspace/sessionMove.ts. This hook is the glue:
//
//   source: build the packet, ask main, then drop the rows ONLY when main says
//           the target committed (`sessions-moved-out`), never kill;
//   target: merge, seed runtimes, show the agent in the focused lane, and
//           confirm only after a durable save (useAutoSave drains the id).
//
// WHY one hook for both directions: a window is a source and a target at
// different moments, and both directions share the bootstrap gate, the
// "drop rows without killing" step and the toast vocabulary. Splitting them
// would duplicate the gate, which is the part that is easy to get wrong.

export type SendSessionToWindowResult =
  | { ok: true; movedSessionIds: SessionId[]; targetWindowNumber: number }
  | {
      ok: false
      message: string
      /** True when the hook already toasted this failure (it arrived as main's
       *  `session-move-failed` event, which can also be an operator's move).
       *  A UI caller toasts only the rest, so a failure is shown exactly once. */
      reportedByEvent?: boolean
      /** True when this renderer gave up WAITING rather than hearing a verdict
       *  (its own settle timeout, or it unmounted). Main may still have
       *  committed the move, so a caller must observe before retrying. Every
       *  other failure is a refusal or a completed rollback: nothing moved. */
      uncertain?: boolean
    }

/** How long the SENDING side waits for main's verdict before giving up on the
 *  promise. Main's own deadline (SESSION_MOVE_DEADLINE_MS, 20 s) always fires
 *  first and reports a failure; this exists only so a lost message can never
 *  leave a caller (the control capability) awaiting forever. */
const SEND_SETTLE_TIMEOUT_MS = 30_000

type OutgoingMove = {
  sessionIds: SessionId[]
  resolve: (result: SendSessionToWindowResult) => void
  timer: ReturnType<typeof setTimeout>
}

type IncomingMove = {
  sessionIds: SessionId[]
  addedTabIds: TabId[]
}

type QueuedEvent =
  | { kind: 'offer'; event: SessionMoveOffer }
  | { kind: 'moved-out'; event: SessionMoveCommitted }
  | { kind: 'cancelled'; event: SessionMoveCancelled }

export function useSessionMoves(params: {
  refs: WorkspaceRefs
  setState: WorkspaceSetState
  setRuntimes: WorkspaceSetRuntimes
  bootstrapComplete: boolean
  selectTiledLaneSession: (laneIndex: number, sessionId: SessionId) => Promise<void>
  showToast: (message: string, durationMs?: number) => void
}): { sendSessionToWindow: (sessionId: SessionId, targetWindowId: string) => Promise<SendSessionToWindowResult> } {
  const { refs, setState, setRuntimes, bootstrapComplete, selectTiledLaneSession, showToast } = params
  // WHY there is no "verdict arrived before the invoke reply" buffer: main
  // returns the start result synchronously from its handler, and Electron
  // delivers that reply and every later message to this renderer over one
  // ordered channel. A verdict needs the TARGET's confirmation (or main's 20 s
  // deadline) first, so it cannot overtake the reply. A verdict for an unknown
  // move therefore means this renderer reloaded mid-move, and it settles
  // nothing.
  const outgoingRef = useRef(new Map<string, OutgoingMove>())
  const incomingRef = useRef(new Map<string, IncomingMove>())
  /** Moves main cancelled while this window was still preparing the merge
   *  (awaiting backend snapshots). The cancel finds nothing in `incomingRef`
   *  yet, so it is remembered here and the merge stops before publishing a
   *  row, rather than painting panes routing has already left. */
  const cancelledBeforeMergeRef = useRef(new Set<string>())
  /**
   * Events that arrived before this window finished restoring itself.
   *
   * WHY they wait, exactly as adoption offers do (useWorkspaceAdoption): the
   * rehydrate publish REPLACES tabs and sessions wholesale, so a merge applied
   * before it is erased, and autosave is off until bootstrap completes, so it
   * could never become durable either. A moved-out applied early is erased the
   * same way, and the restored rows would then come back in this window.
   */
  const queuedRef = useRef<QueuedEvent[]>([])
  const bootstrapCompleteRef = useRef(bootstrapComplete)
  bootstrapCompleteRef.current = bootstrapComplete

  const dropRows = useCallback((sessionIds: readonly SessionId[], alsoIfEmpty: readonly TabId[] = []) => {
    // `workspaceWithoutSessions` is the one row-removal helper close and merge
    // already use: it drops the rows, their pins, projects left empty (and
    // `alsoIfEmpty` only if empty), clears every lane that showed one of them
    // (cleared, not removed: owner ruling 4, the same as Clear Lane) and
    // scrubs row metadata. It removes ROWS; killing is a caller's job, and
    // this caller never kills.
    setState(prev => workspaceWithoutSessions(prev, sessionIds, alsoIfEmpty))
    // Runtimes go too: the backend is alive but owned by the other window, so
    // nothing here may keep painting or feeding it. No kill: that is the whole
    // difference between this and closeSession.
    setRuntimes(prev => {
      if (!sessionIds.some(id => prev[id])) return prev
      const next = { ...prev }
      for (const id of sessionIds) delete next[id]
      return next
    })
    for (const id of sessionIds) forgetSessionViewState(refs, id)
  }, [refs, setRuntimes, setState])

  const settleOutgoing = useCallback((moveId: string, result: SendSessionToWindowResult) => {
    const outgoing = outgoingRef.current.get(moveId)
    if (!outgoing) return
    outgoingRef.current.delete(moveId)
    clearTimeout(outgoing.timer)
    outgoing.resolve(result)
  }, [])

  const receiveOffer = async (offer: SessionMoveOffer) => {
    const refuse = (message: string) => {
      console.warn('[workspace] refused a session move:', message)
      return window.api.refuseSessionMove(offer.moveId, message)
    }
    const packet = parseSessionMovePacket(offer.packet)
    // The packet must carry exactly the sessions main moved routing for.
    // Merging a row main did not route here would show a pane that never
    // receives an event; missing one would strand a routed session.
    const routed = new Set(offer.sessionIds)
    if (!packet || Object.keys(packet.sessions).length !== routed.size || Object.keys(packet.sessions).some(id => !routed.has(id))) {
      await refuse('The moved agent could not be read.')
      return
    }
    const now = Date.now()
    const newTabId = () => crypto.randomUUID()
    // A dry run first, so a collision is refused before any runtime is
    // seeded. The real merge below re-runs against the state as it is after
    // the snapshot await, which may have changed.
    const dryRun = receiveMovedSessions(refs.latestStateRef.current, packet, { now, newTabId })
    if (!dryRun.ok) {
      await refuse(dryRun.reason)
      return
    }
    const snapshots = await seedIncomingRuntimes({
      sessionIds: dryRun.movedSessionIds,
      metas: packet.sessions,
      drafts: packet.drafts,
      setRuntimes,
    })
    const discardSeeded = () => setRuntimes(prev => {
      const next = { ...prev }
      for (const id of dryRun.movedSessionIds) delete next[id]
      return next
    })
    if (cancelledBeforeMergeRef.current.delete(offer.moveId)) {
      // Main gave up on this move during the await and has already routed the
      // sessions back to the source. Nothing was published, so nothing to give
      // back except the runtimes just seeded; no refusal either, since the
      // move is already settled.
      discardSeeded()
      return
    }
    // Holder object: TypeScript keeps a `let` narrowed across the updater.
    // Sound only because setState is the synchronous zustand setter.
    const merged: { value: ReceiveMovedSessionsResult | null } = { value: null }
    setState(prev => {
      const result = receiveMovedSessions(prev, packet, { now, newTabId })
      merged.value = result
      return result.ok ? result.state : prev
    })
    const result = merged.value
    if (!result?.ok) {
      // Something claimed one of these ids during the snapshot await. The
      // seeded runtimes belong to rows that will not exist here.
      discardSeeded()
      await refuse(result?.reason ?? 'The move could not be applied.')
      return
    }
    incomingRef.current.set(offer.moveId, { sessionIds: result.movedSessionIds, addedTabIds: result.addedTabIds })
    // Confirmed from the autosave success path, never from here: see
    // `pendingSessionMoveIdsRef`.
    refs.pendingSessionMoveIdsRef.current = [...refs.pendingSessionMoveIdsRef.current, offer.moveId]
    loadIncomingHistory({ sessionIds: result.movedSessionIds, snapshots, metas: packet.sessions, refs, setRuntimes })
    // Owner default: the moved agent takes this window's FOCUSED lane. Through
    // the ordinary lane-select action, so a parked agent is woken the usual
    // way and an out-of-range lane is handled by its own bounds checks. The
    // window itself is not raised; the sender keeps working where they are.
    void selectTiledLaneSession(refs.latestStateRef.current.stage.focusedLane, packet.rootSessionId)
  }

  // The appliers live in a ref so the IPC subscriptions stay mounted for the
  // window's life (re-subscribing could drop an in-flight event) while always
  // calling the latest closures.
  const applyRef = useRef<(queued: QueuedEvent) => Promise<void>>()
  applyRef.current = async queued => {
    if (queued.kind === 'moved-out') {
      const { event } = queued
      const state = refs.latestStateRef.current
      const root = event.sessionIds.find(id => state.sessions[id])
      const title = root ? sessionDisplayTitle(state.sessions[root]!) : 'Agent'
      // Applied even when this renderer never registered the move (it reloaded
      // mid-move): main only sends this to the source after verifying the
      // target's confirmation, so it is authoritative on its own.
      dropRows(event.sessionIds)
      settleOutgoing(event.moveId, { ok: true, movedSessionIds: event.sessionIds, targetWindowNumber: event.targetWindowNumber })
      const extra = event.sessionIds.length - 1
      showToast(`Moved ${title}${extra > 0 ? ` and ${extra} related agent${extra === 1 ? '' : 's'}` : ''} to Window ${event.targetWindowNumber}`)
      return
    }
    if (queued.kind === 'cancelled') {
      const { event } = queued
      refs.pendingSessionMoveIdsRef.current = refs.pendingSessionMoveIdsRef.current.filter(id => id !== event.moveId)
      const incoming = incomingRef.current.get(event.moveId)
      incomingRef.current.delete(event.moveId)
      if (!incoming) {
        // Still preparing (or never received): stop that merge before it
        // publishes. See cancelledBeforeMergeRef.
        cancelledBeforeMergeRef.current.add(event.moveId)
        return
      }
      // Rows only. Routing already went back to the source, which never
      // stopped showing them. Projects this move created go only if empty.
      dropRows(incoming.sessionIds, incoming.addedTabIds)
      showToast('A move from another window timed out and was undone')
      return
    }
    await receiveOffer(queued.event)
  }

  useEffect(() => {
    const dispatch = (queued: QueuedEvent) => {
      if (!bootstrapCompleteRef.current) {
        queuedRef.current = [...queuedRef.current, queued]
        return
      }
      void applyRef.current?.(queued).catch(err => {
        console.warn('[workspace] session move event failed:', err)
      })
    }
    // Optional-chained: renderer tests mount the workspace hook against a
    // partial `window.api`, and a missing bridge must mean "no moves", not a
    // crash of every test that renders a workspace.
    const offs = [
      window.api.onSessionMoveOffer?.(event => dispatch({ kind: 'offer', event })),
      window.api.onSessionsMovedOut?.(event => dispatch({ kind: 'moved-out', event })),
      window.api.onSessionMoveCancelled?.(event => dispatch({ kind: 'cancelled', event })),
      // A failure changes no rows, so it never needs the bootstrap gate.
      window.api.onSessionMoveFailed?.((event: SessionMoveFailed) => {
        settleOutgoing(event.moveId, { ok: false, message: event.message, reportedByEvent: true })
        showToast(event.message)
      }),
    ]
    return () => {
      for (const off of offs) off?.()
    }
  }, [settleOutgoing, showToast])

  useEffect(() => {
    if (!bootstrapComplete || queuedRef.current.length === 0) return
    const queued = queuedRef.current
    queuedRef.current = []
    void (async () => {
      // In arrival order: a moved-out must not overtake the offer it answers
      // in some other move involving the same rows.
      for (const event of queued) {
        await applyRef.current?.(event).catch(err => {
          console.warn('[workspace] queued session move event failed:', err)
        })
      }
    })()
  }, [bootstrapComplete])

  useEffect(() => () => {
    // An unmounting workspace settles its callers rather than leaving a
    // control capability awaiting a renderer that no longer exists.
    for (const [, outgoing] of outgoingRef.current) {
      clearTimeout(outgoing.timer)
      outgoing.resolve({ ok: false, message: 'The window reloaded before the move finished.', uncertain: true })
    }
    outgoingRef.current.clear()
  }, [])

  const sendSessionToWindow = useCallback(async (
    sessionId: SessionId,
    targetWindowId: string,
  ): Promise<SendSessionToWindowResult> => {
    const state = refs.latestStateRef.current
    const subtree = collectMoveSubtree(state.sessions, sessionId)
    const inFlight = new Set([...outgoingRef.current.values()].flatMap(move => move.sessionIds))
    if (subtree.some(id => inFlight.has(id))) return { ok: false, message: 'That agent is already being moved.' }
    const drafts: Record<SessionId, string> = {}
    for (const id of subtree) {
      const draft = refs.latestRuntimesRef.current[id]?.draftInput
      // Same rule as autosave: only agent panes own a composer, so a draft on
      // anything else (an extension view) is not carried, the way it is not
      // persisted.
      if (draft && isAgentSessionKind(state.sessions[id]?.kind)) drafts[id] = draft
    }
    const built = buildSessionMovePacket(state, drafts, sessionId)
    if (!built.ok) return { ok: false, message: built.message }
    const started = await window.api.sendSessionsToWindow({
      targetWindowId,
      sessionIds: built.sessionIds,
      packet: JSON.stringify(built.packet),
    })
    if (!started.ok) return { ok: false, message: started.message }
    return await new Promise<SendSessionToWindowResult>(resolve => {
      const timer = setTimeout(() => {
        outgoingRef.current.delete(started.moveId)
        resolve({ ok: false, message: `No answer from Window ${started.targetWindowNumber}.`, uncertain: true })
      }, SEND_SETTLE_TIMEOUT_MS)
      outgoingRef.current.set(started.moveId, { sessionIds: built.sessionIds, resolve, timer })
    })
  }, [refs])

  return { sendSessionToWindow }
}
