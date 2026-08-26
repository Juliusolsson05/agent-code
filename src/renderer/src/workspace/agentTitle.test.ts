import { describe, expect, it } from 'vitest'

import {
  AGENT_TITLE_MAX_LENGTH,
  limitAgentTitleLength,
  normalizeAgentTitle,
  setAgentTitleInWorkspace,
} from '@renderer/workspace/agentTitle'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { WorkspaceState } from '@renderer/workspace/types'

function stateWithSessions(
  sessions: WorkspaceState['sessions'],
): WorkspaceState {
  const sessionId = Object.keys(sessions)[0] ?? ''
  return {
    tabs: sessionId
      ? [{ id: 'tab', title: 'project', root: { type: 'leaf', sessionId }, focusedSessionId: sessionId }]
      : [],
    activeTabId: sessionId ? 'tab' : '',
    gridRelatedSelections: {},
    dispatchMode: null,
    sessions,
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('agent title workspace metadata', () => {
  it('trims and bounds titles without splitting a final Unicode character', () => {
    const input = `  ${'a'.repeat(AGENT_TITLE_MAX_LENGTH - 1)}🙂extra  `

    expect(normalizeAgentTitle(input)).toBe(
      `${'a'.repeat(AGENT_TITLE_MAX_LENGTH - 1)}🙂`,
    )
    expect(Array.from(normalizeAgentTitle(input) ?? '')).toHaveLength(AGENT_TITLE_MAX_LENGTH)
  })

  it('keeps the input limit Unicode-safe and removes whitespace exposed by truncation', () => {
    const emojiInput = `${'🙂'.repeat(AGENT_TITLE_MAX_LENGTH)}extra`
    expect(limitAgentTitleLength(emojiInput)).toBe('🙂'.repeat(AGENT_TITLE_MAX_LENGTH))

    const boundaryWhitespace = `${'a'.repeat(AGENT_TITLE_MAX_LENGTH - 1)} b`
    expect(normalizeAgentTitle(boundaryWhitespace)).toBe(
      'a'.repeat(AGENT_TITLE_MAX_LENGTH - 1),
    )
  })

  it('sets and clears one agent title through the durable SessionMeta record', () => {
    const original = stateWithSessions({ agent: { cwd: '/work/project', kind: 'claude' } })
    const titled = setAgentTitleInWorkspace(original, 'agent', '  Queue ownership  ')

    expect(titled).not.toBe(original)
    expect(titled.sessions.agent?.title).toBe('Queue ownership')
    expect(buildVisibleDispatchRows(titled)[0]).toMatchObject({
      agentTitle: 'Queue ownership',
      title: 'Queue ownership',
    })

    const cleared = setAgentTitleInWorkspace(titled, 'agent', '   ')
    expect(cleared.sessions.agent?.title).toBeUndefined()
    expect(buildVisibleDispatchRows(cleared)[0]).toMatchObject({
      agentTitle: undefined,
      title: 'project',
    })
  })

  it('preserves identity for unchanged, missing, and terminal targets', () => {
    const titled = stateWithSessions({
      agent: { cwd: '/work/project', kind: 'codex', title: 'Review' },
    })
    expect(setAgentTitleInWorkspace(titled, 'agent', 'Review')).toBe(titled)
    expect(setAgentTitleInWorkspace(titled, 'missing', 'Nope')).toBe(titled)

    const terminal = stateWithSessions({ shell: { cwd: '/work/project', kind: 'terminal' } })
    expect(setAgentTitleInWorkspace(terminal, 'shell', 'Nope')).toBe(terminal)
  })
})
