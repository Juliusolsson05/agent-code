import { useAppStore } from '@renderer/app-state/hooks'
import {
  agentNameForSession,
  agentNameRowIsReserved,
} from '@renderer/workspace/agentNames/selectors'
import type { SessionId } from '@renderer/workspace/types'

/**
 * WHY components subscribe here instead of receiving a prop: the two header
 * call sites and the Dispatch row all already re-render on unrelated causes,
 * and threading a name through TileLeaf/TileTree would widen prop surfaces on
 * the hot pane-render path for a string that changes roughly never. The
 * selector returns a primitive, so Zustand's default Object.is comparison is
 * exactly right and a name change is the ONLY thing that re-renders through
 * this subscription — token-stream updates never touch it.
 */
export function useAgentName(sessionId: SessionId): string | null {
  return useAppStore(state => agentNameForSession(state, sessionId))
}

/**
 * Companion subscription to `useAgentName`, returning whether this pane must
 * hold space for a name row that has not arrived yet. See
 * `agentNameRowIsReserved` for why the header cannot wait for the name.
 *
 * Also a primitive, so it re-renders on exactly one transition: the Agent
 * names setting being toggled.
 */
export function useAgentNameRowReserved(sessionId: SessionId): boolean {
  return useAppStore(state => agentNameRowIsReserved(state, sessionId))
}
