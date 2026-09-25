import { useEffect, useMemo, useState } from 'react'

import type { TldrRecord, TldrUpdate } from '@shared/types/tldr'
import { useGoalLoops } from '@renderer/features/goal-loop/useGoalLoops'
import { tldrIdentityForSession } from '@renderer/features/tldr/identity'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'

import type { FleetNotes } from './activityRow'

// ---------------------------------------------------------------------------
// The fleet note reader (#1170, decomposition Stage 2b).
//
// TLDR, Goal and Goal Loop have NO renderer store: each is read over IPC on
// demand, and the peeks subscribe only while they are on screen, so that
// "thousands of detached agents impose no listeners, polling or model calls
// while the user is doing normal work" (TldrOverlay). Agent Activity is the
// first surface that needs the notes of the WHOLE fleet at once.
//
// WHY one batched read per kind, not a hook per row: the change events are
// payload-free pings for loops, and a row-per-hook design would re-read every
// agent on every ping — dozens of IPC round trips for one TLDR update. All
// three read functions take arrays, so three calls cover any fleet size.
//
// WHY `enabled`: the view stays MOUNTED while closed (its Dialog hides content,
// not hooks — decomposition correction 10). Closed means no ids, which means
// no subscription and no read, so a closed Agent Activity costs nothing.
// ---------------------------------------------------------------------------

type NoteKind = 'tldrs' | 'goals'

const SOURCES: Record<NoteKind, {
  read: (identities: string[]) => Promise<Record<string, TldrRecord>>
  subscribe: (listener: (update: TldrUpdate) => void) => () => void
  /** Tests stub window.api partially; a view that crashes over a missing IPC
   *  method is far worse than one whose rows keep their folder names. */
  available: () => boolean
}> = {
  tldrs: {
    read: identities => window.api.readTldrs(identities),
    subscribe: listener => window.api.onTldrChanged(listener),
    available: () => typeof window.api?.readTldrs === 'function' && typeof window.api?.onTldrChanged === 'function',
  },
  goals: {
    read: identities => window.api.readGoals(identities),
    subscribe: listener => window.api.onGoalChanged(listener),
    available: () => typeof window.api?.readGoals === 'function' && typeof window.api?.onGoalChanged === 'function',
  },
}

/** Same rule as TldrOverlay: a slower disk read must never overwrite a newer
 *  record that arrived as an event while the read was in flight. */
function newer(previous: TldrRecord | undefined, next: TldrRecord | undefined): TldrRecord | undefined {
  if (!next) return previous
  return !previous || next.revision > previous.revision ? next : previous
}

function useNoteRecords(kind: NoteKind, identities: readonly string[]): Record<string, TldrRecord> {
  const [records, setRecords] = useState<Record<string, TldrRecord>>({})
  // Keyed on the joined string for the reason useGoalLoops gives: the id array
  // is rebuilt every render, and depending on its identity would re-subscribe
  // on every runtime update.
  const key = identities.join('\u0000')

  useEffect(() => {
    const source = SOURCES[kind]
    const ids = key.length === 0 ? [] : key.split('\u0000')
    if (ids.length === 0 || !source.available()) {
      setRecords({})
      return
    }
    const wanted = new Set(ids)
    let current = true
    // Subscribe BEFORE reading, so an update landing during the read is not
    // lost; `newer` keeps whichever of the two is the later revision.
    const unsubscribe = source.subscribe(update => {
      if (!current || !wanted.has(update.identity)) return
      setRecords(previous => ({ ...previous, [update.identity]: newer(previous[update.identity], update.record)! }))
    })
    void source.read(ids).then(result => {
      if (!current) return
      setRecords(previous => {
        const merged: Record<string, TldrRecord> = {}
        for (const id of ids) {
          const record = newer(previous[id], result[id])
          if (record) merged[id] = record
        }
        return merged
      })
    }).catch(() => {
      // Advisory data: a failed read leaves rows on their folder names, which
      // is what they showed before this surface read notes at all.
    })
    return () => { current = false; unsubscribe() }
  }, [key, kind])

  return records
}

/**
 * Every listed session's TLDR, Goal and Goal Loop, while `enabled`.
 *
 * A session with no tldrIdentity carries neither the `tldr` nor the `goal`
 * domain and can never have a note, so it is never asked about (decomposition,
 * correction 3). Loops are keyed by sessionId and asked for every agent,
 * because a loop does not depend on the TLDR domains.
 */
export function useFleetNotes(
  enabled: boolean,
  sessions: Record<SessionId, SessionMeta>,
  sessionIds: readonly SessionId[],
): FleetNotes {
  const { identities, loopIds } = useMemo(() => {
    if (!enabled) return { identities: [] as string[], loopIds: [] as string[] }
    const seen = new Set<string>()
    const loopIds: string[] = []
    for (const id of sessionIds) {
      const meta = sessions[id]
      if (!meta || meta.kind === 'terminal') continue
      loopIds.push(id)
      const identity = tldrIdentityForSession(id, meta)
      if (identity) seen.add(identity)
    }
    // Sorted so the joined key only changes when the SET changes, not when a
    // row moves between sections.
    return { identities: [...seen].sort(), loopIds: loopIds.sort() }
  }, [enabled, sessions, sessionIds])

  const tldrs = useNoteRecords('tldrs', identities)
  const goals = useNoteRecords('goals', identities)
  const loops = useGoalLoops(loopIds)
  return useMemo(() => ({ tldrs, goals, loops }), [tldrs, goals, loops])
}
