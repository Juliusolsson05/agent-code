import { carriedRelationships } from '@renderer/workspace/idRemap'
import { sessionMcpOverrides } from '@renderer/workspace/mcpDomains'
import { DEFAULT_PROVIDER, isAgentSessionKind } from '@shared/types/providerKind'
import { useCallback, useState } from 'react'

import type {
  SessionId,
  SessionKind,
  SessionMeta,
  Tab,
} from '@renderer/workspace/types'
import { remapTiledLanes } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import {
  remapMetaLineage,
  remapSingleEntryLineage,
} from '@renderer/lib/undoClose'
import type {
  ClosedEntry,
  ClosedGroup,
  ClosedSession,
  ClosedTab,
  SingleClosedEntry,
  UndoLineage,
} from '@renderer/lib/undoClose'

import type { WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'

type RestoreResult = 'restored' | 'stale' | 'retryable-failure'

/** Where a successful restore sends its old -> new ids. A top-level entry
 *  publishes to the stack; a group member publishes to the stack AND to the
 *  group's members that have not been replayed yet (restoreGroupEntry). */
type PublishLineage = (lineage: UndoLineage) => void

/**
 * The durable metadata a respawn cannot rebuild, carried onto the new session ID.
 *
 * WHY every restore path must share one answer: `sessionActions.spawn`
 * builds SessionMeta from {cwd, kind, providerRuntime, tmuxName,
 * providerSessionId, builtInMcpDomains} only (session.ts:339-345). Everything
 * else a session owned — its user-authored
 * title, its linked/orchestration parentage, its view-mode override, its
 * bootstrap-delivered flag and its `agentNameId` — exists nowhere but the meta
 * captured on the undo entry. Each path used to answer this differently:
 * `restoreDetachedEntry` had a hand-written allowlist, `restoreTabEntry` built
 * a `freshSessions` map that was populated and then never read (dead from the
 * day it was written), and `restorePaneEntry` patched no session metadata at
 * all. Three answers meant a field could survive one kind of undo and be lost
 * by another, which is not a difference any user could predict.
 *
 * WHY that is more than cosmetic for `agentNameId`: every one of these paths
 * RESUMES the same provider conversation, so the agent the user gets back is
 * the same agent. Dropping the identity makes the reconciler claim a fresh one
 * and the registry allocate a second name, so Cmd-Shift-T renames a live agent
 * and the old name is spent forever — allocation is monotonic and never
 * recycles. That is exactly the silent re-addressing #816 forbids.
 *
 * WHY each field is spread conditionally on top of the spawn's own meta rather
 * than the closed meta being copied wholesale: the respawn's values are the
 * current truth for the volatile fields. `providerSessionId`, `tmuxName` and
 * the freshly minted credentials all belong to the NEW backend, and copying
 * the closed meta over them would reinstate a dead provider session ID and a
 * stale tmux name on top of the live ones the respawn just established.
 *
 * The `spawned` fallback covers the case where the respawn's own registration
 * has not landed in this snapshot; production `spawn` writes SessionMeta into
 * workspace state itself, so in the app it is normally present.
 */
export function carryDurableMeta(spawned: SessionMeta | undefined, closed: SessionMeta): SessionMeta {
  // Extension panes skip spawn entirely: all of their metadata is durable UI
  // identity, including the view ID. The process-specific allowlist below is
  // for real backends whose new connection identity must win after respawn.
  if (closed.kind === 'extension-view') return { ...closed }
  return {
    ...(spawned ?? { cwd: closed.cwd, kind: closed.kind ?? DEFAULT_PROVIDER }),
    ...(closed.title ? { title: closed.title } : {}),
    // A cleared title has no `title` to carry. Its pause still must survive an
    // undo, or the first resumed agent turn would undo the person's clear.
    ...(closed.titleMode ? { titleMode: closed.titleMode } : {}),
    // The spoken address. Conditional like every other field here so an
    // unnamed agent (the setting off, or a name never allocated) is restored
    // without an empty identity that the reconciler would then have to heal.
    ...(closed.agentNameId ? { agentNameId: closed.agentNameId } : {}),
    // The relationship fields, from the ONE list that decides what a
    // relationship is (#1090 review). This function's own header complains
    // that "three answers meant a field could survive one kind of undo and be
    // lost by another" — and it had become the second answer itself: it
    // listed six of the nine fields, so an undone orchestration child came
    // back without `inheritedParentContext` and its parent then read its own
    // pre-handoff commentary as the child's latest answer. Sharing the list
    // is also what makes the type-level guard in
    // successorRelationships.renderer.test.tsx mean what it claims: a new
    // relationship field is now classified once, for every restore path.
    //
    // `carriedRelationships` omits absent fields rather than writing
    // `undefined`, which is the same conditional-spread discipline as every
    // other line here.
    ...carriedRelationships(closed),
    ...(closed.agentViewModeOverride ? { agentViewModeOverride: closed.agentViewModeOverride } : {}),
    // Same pocketId ⇒ same cookie partition: an undone agent comes back logged in.
    ...(closed.browserPocket ? { browserPocket: closed.browserPocket } : {}),
    // Pool membership (#992). `spawn` writes an UN-FILED row — no project, no
    // position — so without these the restored session would be unowned
    // metadata that no index lists and the next autosave drops. `joinedAt` is
    // carried verbatim for the reason the v2 entries carried `detachedAt`: it
    // alone orders rows inside a project, and undo puts things BACK.
    ...(closed.projectId !== undefined ? { projectId: closed.projectId } : {}),
    ...(closed.joinedAt !== undefined ? { joinedAt: closed.joinedAt } : {}),
    // A terminal's last use (#1178). Undo re-attaches the SAME still-alive
    // tmux session, so its history of use is the closed one's; dropping it
    // would hand the restored shell a fresh floor and make it look unused
    // since the moment it came back (review of #1179).
    ...(closed.lastUsedAt !== undefined ? { lastUsedAt: closed.lastUsedAt } : {}),
  }
}

// Undo-close action. Pops the most recent entry from the undo stack
// and restores it.
//
// For a session: respawns it (with --resume for an agent so the conversation
// comes back, `recoverTmuxName` for a terminal so its still-alive tmux session
// is re-attached) and files it back under its project at its old position.
// The only anchor that has to still exist is the project.
//
// For a project: re-creates it at its original index (clamped to bounds) under
// a NEW id, and respawns the sessions that closed with it.
//
// (Until #992 there were three paths — a split pane re-inserted beside its
// surviving sibling, a Dispatch row re-filed from its record, and a tab whose
// tree was remapped leaf by leaf. See lib/undoClose.ts.)

export function useUndoCloseAction(
  _state: { tabs: Tab[] },
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
  sessionActions: SessionActions,
): {
  undoClose: () => Promise<void>
  undoCloseCount: number
} {
  const [, bumpUndoCloseVersion] = useState(0)

  // Respawn one closed session, or mint an id for a process-less one.
  //
  // ── A PROCESS-LESS SESSION IS RESTORED, NOT SPAWNED ──
  // Undo once called spawn() for every kind. Main rejects an extension-view
  // spawn outright, the caller turned that into 'retryable-failure', and
  // undoClose PUSHES A FAILED ENTRY BACK — so the stack head became permanently
  // poisoned: every later Cmd+Shift+T popped the same entry, failed, re-pushed,
  // and returned, and all older undo history was unreachable for the rest of
  // the session. Minting the id mirrors openExtensionViewInPane; there is
  // nothing to recover because there was never a process.
  //
  // Returns null on a spawn failure. `spawned` says whether a backend now
  // exists that a bail-out must kill.
  const respawn = useCallback(
    async (meta: SessionMeta): Promise<{ sessionId: SessionId; spawned: boolean } | null> => {
      const kind: SessionKind = meta.kind ?? DEFAULT_PROVIDER
      if (kind === 'extension-view') {
        return { sessionId: crypto.randomUUID() as SessionId, spawned: false }
      }
      try {
        const sessionId = await sessionActions.spawn(meta.cwd, {
          kind,
          ...(meta.providerRuntime ? { providerRuntime: meta.providerRuntime } : {}),
          //   - an agent with a durable transcript resumes it;
          //   - a terminal with tmuxName re-attaches the same tmux session,
          //     preserving scrollback and any running process. Without this,
          //     "undo close" on a terminal would respawn an empty shell —
          //     defeating the point of having a tmux backing.
          resumeSessionId: isAgentSessionKind(kind) ? resumableProviderSessionId(meta) : undefined,
          recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
          // WHY capability intent is restored but credentials are not: closing
          // a session revokes its token. Undo must ask main to mint a fresh one
          // from the session's durable choices; dropping them makes an
          // undo-restored transcript silently lose tools. The effective list is
          // deliberately not restored — the restored session is a NEW provider
          // process, so it resolves those choices against current Settings.
          tldrIdentity: meta.tldrIdentity,
          builtInMcpOverrides: sessionMcpOverrides(meta),
        })
        return { sessionId, spawned: true }
      } catch {
        return null
      }
    },
    [sessionActions],
  )

  const restoreSessionEntry = useCallback(
    async (entry: ClosedSession, publish: PublishLineage): Promise<RestoreResult> => {
      // The project is a session's only anchor: the index files each row under
      // its `projectId`, so a row whose project is gone renders nowhere —
      // restoring it would spawn a live backend the user can never see or
      // close. Treat that as stale.
      //
      // We deliberately do NOT re-home the session into some surviving
      // project: a close that REMOVED the project recorded a 'tab' entry, so a
      // missing project here means the user closed or merged the project
      // itself afterwards, and undoing THAT is the correct recovery.
      const meta = entry.sessionMeta
      const projectId = meta.projectId
      if (projectId === undefined) return 'stale'
      if (!refs.stateRef.current.tabs.some(tab => tab.id === projectId)) return 'stale'

      const respawned = await respawn(meta)
      if (!respawned) return 'retryable-failure'
      const newSessionId = respawned.sessionId

      // Set inside the updater and read after. Sound because setState is the
      // zustand store setter, which applies updaters synchronously — NOT a
      // React useState setter, whose updater would still be pending here.
      let refiled = false
      setState(prev => {
        // Re-check inside the updater: the project can be closed between the
        // awaited spawn and here. Returning `prev` unchanged would strand the
        // session, so fall through to the kill below instead.
        if (!prev.tabs.some(tab => tab.id === projectId)) return prev
        refiled = true
        return {
          ...prev,
          // The project the row came back into becomes the active one: that is
          // where the user's attention now is, and it is what every path that
          // files a session has always done.
          activeTabId: projectId,
          sessions: {
            ...prev.sessions,
            // carryDurableMeta restores membership too — `projectId` and,
            // critically, `joinedAt`, so the row returns to its old position
            // in the index rather than jumping to the bottom.
            [newSessionId]: carryDurableMeta(prev.sessions[newSessionId], meta),
          },
          // The stage is deliberately NOT written. The close emptied the lane
          // that showed this session, so the visible result of an undo is the
          // row reappearing at its old position in the index — back in the
          // pool, one keystroke from any lane — not a lane takeover.
          // Restoring the lane would need the lane index captured at close
          // time; deliberately not done, because a lane the user has since
          // re-aimed should not be yanked back by an undo (U2).
        }
      })

      if (!refiled) {
        // No backend or renderer metadata was created for an unfiled view.
        if (!respawned.spawned) return 'stale'
        // The spawn already registered a live backend, so a filing that did
        // not happen must not leave it running with no row pointing at it.
        //
        // Kill with the kind/cwd resolved above rather than leaving it to
        // killSession's ownership proof, which re-reads them from
        // `refs.stateRef`. History: that ref used to be a render-body mirror,
        // so immediately after an awaited spawn it did not contain the new
        // session, the proof failed, and the kill silently no-opped —
        // stranding exactly the backend this bail exists to reclaim. #886 made
        // stateRef a synchronous store subscription; the explicit owner stays
        // as defense in depth.
        await window.api
          .killOwnedSession({
            sessionId: newSessionId,
            kind: meta.kind ?? DEFAULT_PROVIDER,
            cwd: meta.cwd,
            caller: 'undo-close.rollback',
          })
          .catch(() => undefined)
        // `.catch`: killSession reaches an IPC invoke that can reject, and this
        // bail runs with the entry already POPPED — a throw here would lose the
        // entry, skip bumpUndoCloseVersion so the palette's count stays stale,
        // and escape into the keybinding handler.
        await sessionActions.killSession(newSessionId, 'undo-close.rollback').catch(() => undefined)
        return 'stale'
      }
      // The closed session is back under a new id. An older entry may point at
      // it — a linked child closed earlier names it as `linkedParentId` — so
      // publish old -> new; see UndoLineage.
      publish({ sessions: new Map([[entry.sessionId, newSessionId]]) })
      return 'restored'
    },
    [refs.stateRef, respawn, sessionActions, setState],
  )

  const restoreTabEntry = useCallback(
    async (entry: ClosedTab, publish: PublishLineage): Promise<RestoreResult> => {
      if (entry.sessions.length === 0) return 'stale'
      const restoredTab: Tab = { id: crypto.randomUUID(), title: entry.tab.title }

      // Old -> new for EVERY session this restore brings back. It does two
      // jobs: (1) a linked child restored beside its parent must point at the
      // parent's NEW id — carryDurableMeta copies the closed `linkedParentId`
      // verbatim, which used to leave restored children un-nested and no
      // longer cascading; (2) it is published to the stack so older entries
      // anchored on this project or its sessions still resolve.
      const idMap = new Map<SessionId, SessionId>()
      // New session id -> the meta the closed session actually had; applied
      // through carryDurableMeta in the commit at the end.
      const carried = new Map<SessionId, SessionMeta>()

      // Restore what we can. A project is just a group of sessions, so one
      // that fails to respawn (a provider hiccup on one agent out of nine)
      // must not cost the user the other eight.
      //
      // Until #992 the tab's tile-tree leaves were ALL-OR-NOTHING here (a tree
      // cannot contain a missing leaf, so one failed spawn killed every
      // sibling it had just started and pushed the entry back) while its
      // detached rows were best-effort. With no tree there is nothing a
      // missing session could corrupt, so the gentler rule covers everyone.
      for (const member of entry.sessions) {
        const respawned = await respawn(member.meta)
        if (!respawned) continue
        idMap.set(member.sessionId, respawned.sessionId)
        carried.set(respawned.sessionId, member.meta)
      }
      // Nothing came back: the entry is still good, the provider is not.
      if (idMap.size === 0) return 'retryable-failure'

      setState(prev => {
        const insertIdx = Math.min(entry.tabIndex, prev.tabs.length)
        const tabs = [...prev.tabs]
        tabs.splice(insertIdx, 0, restoredTab)
        const sessions = { ...prev.sessions }
        for (const [newId, closed] of carried) {
          sessions[newId] = {
            // Relationship pointers follow the restore: a linked child
            // restored with this project points at its parent's NEW id.
            ...remapMetaLineage(carryDurableMeta(sessions[newId], closed), idMap),
            // The old project id is dead; membership moves to the new one.
            // `joinedAt` rides through carryDurableMeta, so the restored
            // project lists its sessions in the order it used to.
            projectId: restoredTab.id,
          }
        }
        return {
          ...prev,
          tabs,
          sessions,
          activeTabId: restoredTab.id,
          // Restored sessions get fresh ids; remap any lane that still named
          // one of the closed ids so the lane follows the restored agent
          // instead of dangling. (The close normally emptied those lanes, so
          // this is a no-op unless something re-aimed a lane at a dead id.)
          stage: remapTiledLanes(prev.stage, idMap),
        }
      })
      // The project is back under a NEW id with NEW session ids. An older
      // entry anchored on it — a session closed from this project before the
      // project itself went — must now name the restored ids, or the next undo
      // judges it stale and that session is lost (#886 finding 4).
      publish({
        sessions: idMap,
        tabs: new Map([[entry.tab.id, restoredTab.id]]),
      })
      return 'restored'
    },
    [respawn, setState],
  )

  const restoreSingleEntry = useCallback(
    (entry: SingleClosedEntry, publish: PublishLineage): Promise<RestoreResult> =>
      entry.type === 'session'
        ? restoreSessionEntry(entry, publish)
        : restoreTabEntry(entry, publish),
    [restoreSessionEntry, restoreTabEntry],
  )

  // Replay one close OPERATION's units last-first (see ClosedGroup).
  //
  // WHY last-first with lineage threaded through the members not yet replayed:
  // the last commit is the outermost change — the parent, the tab removal — and
  // older units anchor on what it restores: a child's linkedParentId, a
  // session's projectId. Every restore mints new ids and
  // publishes them, so each older member is re-anchored before it runs, and the
  // rest of the stack is re-anchored as for any other restore.
  //
  // Failure policy mirrors the single-entry loop, per member. A stale member is
  // skipped: the rest of the operation may still be restorable. A retryable
  // failure stops the replay: if nothing had come back yet the whole group is
  // reported retryable and undoClose pushes it back untouched; if some members
  // already came back, the members left (already re-anchored) go back on the
  // stack as a smaller group so the next ⌘⇧T continues where this one stopped
  // instead of respawning the ones that are already live.
  const restoreGroupEntry = useCallback(
    async (entry: ClosedGroup): Promise<RestoreResult> => {
      let remaining: SingleClosedEntry[] = [...entry.entries]
      let restoredAny = false
      while (remaining.length > 0) {
        const member = remaining[remaining.length - 1]
        remaining = remaining.slice(0, -1)
        const result = await restoreSingleEntry(member, lineage => {
          remaining = remaining.map(older => remapSingleEntryLineage(older, lineage))
          refs.undoStackRef.current.remapLineage(lineage)
        })
        if (result === 'restored') {
          restoredAny = true
        } else if (result === 'retryable-failure') {
          if (!restoredAny) return 'retryable-failure'
          const rest = [...remaining, member]
          const leftover: ClosedEntry = rest.length === 1 ? rest[0] : { ...entry, entries: rest }
          refs.undoStackRef.current.push(leftover)
          return 'restored'
        }
      }
      return restoredAny ? 'restored' : 'stale'
    },
    [refs.undoStackRef, restoreSingleEntry],
  )

  const undoClose = useCallback(async () => {
    // Undo Close is a small LIFO recovery history, not a one-shot
    // toast action. A session entry can go stale during normal cleanup
    // because its only anchor is its project; if that project was closed
    // or merged away since, the entry is no longer restorable in place.
    // We deliberately skip such entries and keep
    // walking backward so one stale close does not block an older valid
    // restore. We still pop stale entries because retaining
    // an entry we already know cannot restore would trap the user on
    // the same failure every time they press Cmd+Shift+T. Transient spawn
    // failures are different: those keep the entry by pushing it back so a
    // provider hiccup does not permanently consume the user's recovery slot.
    let staleEntryConsumed = false
    while (true) {
      const entry = refs.undoStackRef.current.pop()
      if (!entry) {
        if (staleEntryConsumed) {
          bumpUndoCloseVersion(version => version + 1)
        }
        return
      }
      const result = entry.type === 'group'
        ? await restoreGroupEntry(entry)
        : await restoreSingleEntry(entry, lineage => refs.undoStackRef.current.remapLineage(lineage))
      if (result === 'restored') return
      if (result === 'retryable-failure') {
        refs.undoStackRef.current.push(entry)
        if (staleEntryConsumed) {
          bumpUndoCloseVersion(version => version + 1)
        }
        return
      }
      staleEntryConsumed = true
    }
  }, [bumpUndoCloseVersion, refs.undoStackRef, restoreGroupEntry, restoreSingleEntry])

  // Peek at the undo stack length — used by the command palette to
  // show/hide the "Undo Close" command.
  const undoCloseCount = refs.undoStackRef.current.length

  return { undoClose, undoCloseCount }
}
