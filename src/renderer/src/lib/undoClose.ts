import { UNDO_CLOSE_RETENTION_MS } from '@shared/undoRetention'

import type {
  SessionId,
  SessionMeta,
  Tab,
} from '@renderer/workspace/types'

// Undo-close stack — captures enough state to bring back a closed session, or
// a whole closed project, where it was in the index.
//
// Entry shapes:
//
//   'session' — one session was closed and its project survived. To undo we
//            respawn it and file it back under that project at its old
//            position (`sessionMeta.joinedAt`).
//
//   'tab'  — a project was removed, because a close took its last session (or
//            the Close Tab command took all of them). To undo we re-create
//            the project at its original index and respawn its sessions.
//
//   'group' — one close OPERATION committed several units (a linked cascade, a
//            Close Tab reaching into other projects, a partial close whose
//            named session stayed open). It holds one entry of the shapes
//            above per unit, in commit order; undo replays them last-first so
//            each restore's new ids re-anchor the older ones.
//
// HISTORY (#992). There were two more shapes while a project owned a tile
// tree: 'pane' (a leaf removed from a split — restored by finding its surviving
// sibling and re-wrapping it at the recorded direction, ratio and side) and
// 'detached' (a Dispatch row, restored by re-filing its detachedSessions
// record, with an optional `replacedRoot` for the case where closing the last
// grid agent had PROMOTED a detached survivor into the tree). All of that was
// placement bookkeeping for a structure that no longer exists. A session's
// whole placement is now two fields it carries itself — `projectId` and
// `joinedAt` — so one shape restores any session, and the ~200 lines of tree
// surgery (`findParentSplitInfo`, `reinsertPane`) went with the tree.
//
// What did NOT change, because it was never about the tree:
//   - an entry must carry the closed session's metadata, because `spawn` can
//     rebuild only cwd/kind/provider ids. This matters most for terminals:
//     closing one stops its attach PTY but leaves the tmux session alive, and
//     if no entry captures `tmuxName` the next launch's tmux reconcile sees a
//     live session with no row in workspace.json, classifies it as an orphan
//     and kills it — the scrollback is then unrecoverable (#671);
//   - `joinedAt` is restored VERBATIM. The user pressed undo to put things
//     back, not to move the row to the bottom of the list;
//   - lineage (below).
//
// The stack is LIFO — the user undoes the most recent close first, which
// matches Cmd+Shift+T muscle memory from every browser ever. Multiple
// undoes pop successively older entries.
//
// Entries auto-expire after UNDO_CLOSE_RETENTION_MS. The policy is
// intentionally longer than a toast lifetime because agent cleanup is
// often batched: users close a pile of panes, keep working, then only
// notice the mistaken close when they need that context again. One
// hour gives that real recovery window without turning Undo Close into
// durable session history. We keep it in-memory on purpose: persisting
// entries across restart would imply we can validate provider resume
// ids, tmux names, tab anchors, and cwd access after the process has
// been torn down, which is a larger recovery contract than this small
// LIFO affordance should promise.
//
// The cap is 10, not the old 20, because the useful product model is
// "recent recovery history", not an unbounded audit log. A smaller cap
// keeps repeated Cmd+Shift+T predictable during cleanup while limiting
// the number of stale pane anchors we carry around for the full hour.
// Expiry is checked lazily on push/pop/peek/length so we avoid a
// background timer whose only job would be making command-palette
// visibility slightly fresher.

// The retention window is defined in shared/ and re-exported here: main derives
// its detached-tmux reap deadline from the same constant, because a closed
// terminal's shell is kept alive for exactly as long as an undo entry can still
// ask for it back. See src/shared/undoRetention.ts.
export { UNDO_CLOSE_RETENTION_MS }
export const UNDO_CLOSE_MAX_ENTRIES = 10

// ---- Entry types ----

/**
 * One closed session whose project survived the close.
 *
 * `sessionMeta` is the row exactly as it stood at close time, membership
 * included: `projectId` is the ANCHOR (the project it returns to) and
 * `joinedAt` is its place there.
 */
export type ClosedSession = {
  type: 'session'
  closedAt: number
  /**
   * The closed session's own launch-local id. Undo mints a NEW id for it, and
   * older entries still on the stack may name the old one (a linked child's
   * `linkedParentId`). Restore publishes old -> new through
   * `UndoCloseStack.remapLineage` so those pointers keep resolving.
   */
  sessionId: SessionId
  sessionMeta: SessionMeta
}

/**
 * A removed project and the sessions that went with it, in index order.
 *
 * `sessions` holds only what the operation actually CLOSED. A project is
 * removed because it emptied, so that is normally everything it had — but the
 * entry records commits, not intentions, which is what makes a partial
 * operation's undo honest.
 */
export type ClosedTab = {
  type: 'tab'
  closedAt: number
  tab: Tab
  /** Index the project was at before removal — used to re-insert at the same
   *  position (clamped to bounds if other projects were also closed since). */
  tabIndex: number
  sessions: Array<{ sessionId: SessionId; meta: SessionMeta }>
}

/** The shapes that restore ONE unit; a group is built from these. */
export type SingleClosedEntry = ClosedSession | ClosedTab

/**
 * Everything one close OPERATION committed, as a single undo unit.
 *
 * WHY a group rather than one entry per session or one entry for the named
 * session only (#886 review round 2): an operation can end several sessions in
 * different projects, and it can be PARTIAL: the parent kept because a child
 * changed, while the children that already closed are really gone. Recording
 * only the named session lost those children entirely (they had no entry and
 * the toast never mentioned them); recording each separately flooded the
 * 10-entry stack with one decision and made ⌘⇧T restore half an operation at
 * a time.
 *
 * `entries` is in COMMIT order. Undo replays it from the END: the last commit
 * is the outermost state change (a parent, a project removal), and each
 * restore publishes lineage (new ids) that the older members still anchor on —
 * a child's `linkedParentId`, a session's `projectId`.
 */
export type ClosedGroup = {
  type: 'group'
  closedAt: number
  entries: SingleClosedEntry[]
}

export type ClosedEntry = SingleClosedEntry | ClosedGroup

/**
 * Old -> new ids published by one successful restore.
 *
 * WHY undo needs lineage at all: every restore respawns under a fresh
 * launch-local SessionId, and a restored tab gets a fresh TabId. Entries still
 * on the stack were captured against the OLD ids. Without rewriting them, the
 * natural sequence "close A, close B (the project's last session, so the
 * project goes too), undo, undo" loses A: its entry names project T, but the
 * first undo recreated T as T′, so the second undo judged A stale and consumed
 * it. The same goes for a linked child whose restored parent has a new id.
 *
 * WHY this is not "recreate any missing tab": a tab can also disappear because
 * the user MERGED it into another project (#913/#914). Merge has no undo entry
 * and never publishes lineage, so an entry anchored on a merged-away tab still
 * resolves to nothing and is correctly treated as stale — restoring it would
 * resurrect a project the user deliberately folded away. Lineage only flows
 * from restores, which is exactly the set of disappearances undo may reverse.
 */
export type UndoLineage = {
  sessions?: ReadonlyMap<SessionId, SessionId>
  tabs?: ReadonlyMap<string, string>
}

/** Rewrite a meta's cross-session pointers through a lineage map. Unlike
 *  `remapSessionMetaRelationships`, ids absent from the map are KEPT: lineage
 *  describes one restore, not the full set of surviving sessions, so an
 *  unmapped parent is simply one this restore did not touch. */
export function remapMetaLineage(
  meta: SessionMeta,
  sessions: ReadonlyMap<SessionId, SessionId> | undefined,
): SessionMeta {
  if (!sessions || sessions.size === 0) return meta
  const mapped = (id: SessionId | undefined) => (id ? sessions.get(id) ?? id : id)
  const linkedParentId = mapped(meta.linkedParentId)
  const orchestrationParentId = mapped(meta.orchestrationParentId)
  const orchestrationRootId = mapped(meta.orchestrationRootId)
  if (
    linkedParentId === meta.linkedParentId &&
    orchestrationParentId === meta.orchestrationParentId &&
    orchestrationRootId === meta.orchestrationRootId
  ) return meta
  return {
    ...meta,
    ...(linkedParentId ? { linkedParentId } : {}),
    ...(orchestrationParentId ? { orchestrationParentId } : {}),
    ...(orchestrationRootId ? { orchestrationRootId } : {}),
  }
}

/**
 * Apply one restore's lineage to an entry still waiting on the stack.
 *
 * Only ANCHORS are rewritten — the project a session entry returns to, and the
 * relationship pointers its respawned session will carry. An entry's OWN
 * closed ids are never remapped: those sessions are dead and the entry is the
 * only thing that will ever revive them.
 */
export function remapClosedEntryLineage(entry: ClosedEntry, lineage: UndoLineage): ClosedEntry {
  if (entry.type === 'group') {
    return { ...entry, entries: entry.entries.map(member => remapSingleEntryLineage(member, lineage)) }
  }
  return remapSingleEntryLineage(entry, lineage)
}

/** remapClosedEntryLineage for one unit; group restore uses it to re-anchor
 *  the members it has not replayed yet. */
export function remapSingleEntryLineage(entry: SingleClosedEntry, lineage: UndoLineage): SingleClosedEntry {
  if (entry.type === 'session') {
    const meta = remapMetaLineage(entry.sessionMeta, lineage.sessions)
    const projectId = meta.projectId !== undefined
      ? lineage.tabs?.get(meta.projectId) ?? meta.projectId
      : undefined
    return {
      ...entry,
      sessionMeta: projectId === meta.projectId ? meta : { ...meta, projectId },
    }
  }
  return {
    ...entry,
    sessions: entry.sessions.map(member => ({
      ...member,
      meta: remapMetaLineage(member.meta, lineage.sessions),
    })),
  }
}

/** Every session id an entry could restore (session, project and group members). */
function entrySessionIds(entry: ClosedEntry, into: Set<SessionId> = new Set()): Set<SessionId> {
  if (entry.type === 'group') {
    for (const member of entry.entries) entrySessionIds(member, into)
  } else if (entry.type === 'session') {
    into.add(entry.sessionId)
  } else {
    for (const member of entry.sessions) into.add(member.sessionId)
  }
  return into
}

/**
 * Drop relationship pointers that name one of `gone` while that id is not a
 * live session (#1387 review a). Replace and Reload Agents now KEEP a pointer
 * to a closed parent while undo can still restore it (#1379). When the entry
 * then leaves the stack WITHOUT being restored (expired, evicted, or consumed
 * as stale/failed), nothing else would ever clear that pointer: the child kept
 * naming a dead id until restart, still counted as an orchestration worker,
 * and was invisible to every parent. Only pointers to exactly these ids are
 * touched, so unrelated or cross-window pointers are left alone. Untouched rows
 * keep their identity.
 */
export function dropPointersTo(
  sessions: Record<SessionId, SessionMeta>,
  gone: ReadonlySet<SessionId>,
): Record<SessionId, SessionMeta> {
  let changed = false
  const out: Record<SessionId, SessionMeta> = {}
  const dead = (id: SessionId | undefined): boolean => id !== undefined && gone.has(id) && !(id in sessions)
  for (const [id, meta] of Object.entries(sessions) as Array<[SessionId, SessionMeta]>) {
    if (!dead(meta.linkedParentId) && !dead(meta.orchestrationParentId) && !dead(meta.orchestrationRootId)) {
      out[id] = meta
      continue
    }
    const next = { ...meta }
    if (dead(meta.linkedParentId)) delete next.linkedParentId
    if (dead(meta.orchestrationParentId)) delete next.orchestrationParentId
    if (dead(meta.orchestrationRootId)) delete next.orchestrationRootId
    out[id] = next
    changed = true
  }
  return changed ? out : sessions
}

/**
 * The same rule as dropPointersTo, applied to a waiting entry's OWN metadata
 * (#1387 review a, round 3). A group member pushed back for a retry must not
 * carry pointers to a member the same group already consumed: that parent can
 * never return, and the later restore would bring the dead pointer back.
 */
export function dropEntryPointersTo(entry: ClosedEntry, gone: ReadonlySet<SessionId>): ClosedEntry {
  if (gone.size === 0) return entry
  const clean = (meta: SessionMeta): SessionMeta => {
    if (!(meta.linkedParentId && gone.has(meta.linkedParentId)) &&
        !(meta.orchestrationParentId && gone.has(meta.orchestrationParentId)) &&
        !(meta.orchestrationRootId && gone.has(meta.orchestrationRootId))) return meta
    const next = { ...meta }
    if (next.linkedParentId && gone.has(next.linkedParentId)) delete next.linkedParentId
    if (next.orchestrationParentId && gone.has(next.orchestrationParentId)) delete next.orchestrationParentId
    if (next.orchestrationRootId && gone.has(next.orchestrationRootId)) delete next.orchestrationRootId
    return next
  }
  if (entry.type === 'group') return { ...entry, entries: entry.entries.map(member => dropEntryPointersTo(member, gone) as SingleClosedEntry) }
  if (entry.type === 'session') return { ...entry, sessionMeta: clean(entry.sessionMeta) }
  return { ...entry, sessions: entry.sessions.map(member => ({ ...member, meta: clean(member.meta) })) }
}

// ---- Stack ----

export class UndoCloseStack {
  private entries: ClosedEntry[] = []
  private droppedListener: ((ids: Set<SessionId>) => void) | null = null

  /**
   * Told the session ids of entries that left the stack WITHOUT a restore
   * (expired or evicted), so the workspace can drop pointers to them (see
   * dropPointersTo). Delivered on a microtask, never synchronously: prune runs
   * inside restorableSessionIds, which is called from within a setState
   * updater, and a listener that set state there would nest updates.
   */
  setDroppedListener(listener: ((ids: Set<SessionId>) => void) | null): void {
    this.droppedListener = listener
  }

  private notifyDropped(entries: ClosedEntry[]): void {
    const listener = this.droppedListener
    if (!listener || entries.length === 0) return
    const ids = new Set<SessionId>()
    for (const entry of entries) entrySessionIds(entry, ids)
    queueMicrotask(() => listener(ids))
  }

  constructor(private readonly now: () => number = Date.now) {}

  /** Push a new entry onto the stack. Prunes expired + over-cap. */
  push(entry: ClosedEntry): void {
    this.prune()
    this.entries.push(entry)
    if (this.entries.length > UNDO_CLOSE_MAX_ENTRIES) {
      this.notifyDropped(this.entries.slice(0, this.entries.length - UNDO_CLOSE_MAX_ENTRIES))
      this.entries = this.entries.slice(-UNDO_CLOSE_MAX_ENTRIES)
    }
  }

  /** Pop the most recent non-expired entry. Returns null if empty. */
  pop(): ClosedEntry | null {
    this.prune()
    return this.entries.pop() ?? null
  }

  /** Peek at the most recent entry without removing it. */
  peek(): ClosedEntry | null {
    this.prune()
    return this.entries.at(-1) ?? null
  }

  /** Number of restorable entries. */
  get length(): number {
    this.prune()
    return this.entries.length
  }

  /**
   * Every session id a waiting entry could bring back (#1379). Pruned first,
   * exactly as `pop()` would be, so an expired entry never counts.
   *
   * WHY the stack answers this: replace and Reload Agents drop any
   * relationship pointer whose target is neither live nor in their idMap. A
   * parent that is closed but still restorable is neither, so reloading its
   * live child erased the child's link, and undoing the parent later had
   * nothing to relink. The swap passes these ids as "still known".
   */
  restorableSessionIds(): Set<SessionId> {
    this.prune()
    const ids = new Set<SessionId>()
    for (const entry of this.entries) entrySessionIds(entry, ids)
    return ids
  }

  /** Rewrite every waiting entry's anchors after a successful restore. See
   *  `UndoLineage` for why this runs on restore and never on merge. */
  remapLineage(lineage: UndoLineage): void {
    if (!lineage.sessions?.size && !lineage.tabs?.size) return
    this.entries = this.entries.map(entry => remapClosedEntryLineage(entry, lineage))
  }

  private prune(): void {
    const cutoff = this.now() - UNDO_CLOSE_RETENTION_MS
    const expired = this.entries.filter(e => e.closedAt <= cutoff)
    if (expired.length === 0) return
    this.entries = this.entries.filter(e => e.closedAt > cutoff)
    this.notifyDropped(expired)
  }
}
