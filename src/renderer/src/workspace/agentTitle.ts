import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

/**
 * User-authored titles are glance labels, not a second prompt or transcript.
 * Keeping the bound here prevents one modal from enforcing a limit that an
 * alternate command surface can bypass later. Code-point slicing avoids
 * persisting half of a surrogate pair when the final character is an emoji.
 */
export const AGENT_TITLE_MAX_LENGTH = 120

export function limitAgentTitleLength(value: string): string {
  return Array.from(value).slice(0, AGENT_TITLE_MAX_LENGTH).join('')
}

export function normalizeAgentTitle(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  // WHY trim again after slicing: a title can contain internal whitespace, and
  // the length boundary can land exactly on that whitespace. Returning the
  // raw slice would manufacture a trailing space even though the input was
  // trimmed first, breaking the canonical-state contract used by no-op checks.
  return limitAgentTitleLength(trimmed).trimEnd()
}

/**
 * Apply one title edit at the durable workspace boundary.
 *
 * WHY this returns the original object for an invalid/no-op edit: workspace
 * autosave keys off state identity. Opening the prompt and saving an unchanged
 * value should not schedule a disk write, while a missing or terminal session
 * must not acquire agent-only metadata through a stale captured modal.
 *
 * WHY clearing deletes the key instead of persisting an empty string:
 * `SessionMeta.title` predates this UI and is read by Dispatch, orchestration,
 * status, and close-confirmation surfaces. They already agree that an absent
 * title means "derive a useful fallback". Keeping that representation means
 * the new feature composes with every existing reader without teaching each
 * one that `''` is another spelling of absent.
 */
export function setAgentTitleInWorkspace(
  state: WorkspaceState,
  sessionId: SessionId,
  value: string,
): WorkspaceState {
  const meta = state.sessions[sessionId]
  if (!meta || !isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)) return state

  const title = normalizeAgentTitle(value)
  if (title === null && meta.title === undefined) return state
  if (title !== null && meta.title === title) return state

  const nextMeta = title === null
    ? (() => {
        const { title: _removed, ...rest } = meta
        return rest
      })()
    : { ...meta, title }

  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: nextMeta,
    },
  }
}
