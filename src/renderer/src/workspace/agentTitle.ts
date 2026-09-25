import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

/**
 * User-authored titles are glance labels, not a second prompt or transcript.
 * Keeping the bound here prevents one modal from enforcing a limit that an
 * alternate command surface can bypass later. Code-point slicing avoids
 * persisting half of a surrogate pair when the final character is an emoji.
 */
export const AGENT_TITLE_MAX_LENGTH = 120
export const AUTO_AGENT_TITLE_MAX_LENGTH = 60

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
 * value should not schedule a disk write, and a session that closed while its
 * prompt was open must not be recreated through a stale captured modal.
 *
 * WHY every session kind is accepted (#865): titles used to be agent-only
 * (#660). A title is session metadata the user writes for scanning, and every
 * reader of `SessionMeta.title` (Dispatch, observe, close confirmation)
 * already handles terminals. The kind check was the only thing in the way.
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
  if (!meta) return state

  const title = normalizeAgentTitle(value)
  const titleMode: NonNullable<SessionMeta['titleMode']> = title === null ? 'paused' : 'manual'
  if (title === null && meta.title === undefined && meta.titleMode === titleMode) return state
  if (title !== null && meta.title === title && (meta.titleMode === titleMode || meta.titleMode === undefined)) return state

  const nextMeta = title === null
    ? (() => {
        const { title: _removed, ...rest } = meta
        return { ...rest, titleMode }
      })()
    : { ...meta, title, titleMode }

  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: nextMeta,
    },
  }
}

/** Agent titles have a deliberately tighter shape than manually entered
 * titles. A tool should return an error for a long or empty suggestion instead
 * of silently clipping it into a misleading label. One line also prevents a
 * transcript fragment from making the glance row look like a status report. */
export function normalizeAutoAgentTitle(value: string): string | null {
  const title = value.replace(/\s+/gu, ' ').trim()
  if (!title || [...title].length > AUTO_AGENT_TITLE_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) return null
  return title
}

export function setAutoAgentTitleInWorkspace(
  state: WorkspaceState,
  sessionId: SessionId,
  value: string,
): WorkspaceState {
  const meta = state.sessions[sessionId]
  const title = normalizeAutoAgentTitle(value)
  // WHY a legacy nonempty title is locked even with no titleMode: before this
  // feature all titles were user/creator-owned. Treating absence as auto would
  // make the first agent call erase those existing labels on upgrade.
  if (!meta || meta.kind === 'terminal' || !meta.builtInMcpDomains?.includes('auto_title')
    || !title || (meta.titleMode !== 'auto' && (meta.titleMode || meta.title))) return state
  if (meta.title === title && meta.titleMode === 'auto') return state
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...meta, title, titleMode: 'auto' } },
  }
}

export function resumeAutoAgentTitleInWorkspace(state: WorkspaceState, sessionId: SessionId): WorkspaceState {
  const meta = state.sessions[sessionId]
  if (!meta || meta.kind === 'terminal' || !meta.builtInMcpDomains?.includes('auto_title')) return state
  if (meta.titleMode === undefined && meta.title === undefined) return state
  // Releasing a manual lock must also remove its old title; otherwise the
  // next agent call cannot tell that the legacy/manual text was surrendered.
  const { title: _title, titleMode: _mode, ...rest } = meta
  return { ...state, sessions: { ...state.sessions, [sessionId]: rest } }
}
