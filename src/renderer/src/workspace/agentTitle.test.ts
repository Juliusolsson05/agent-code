import { describe, expect, it } from 'vitest'

import {
  AGENT_TITLE_MAX_LENGTH,
  limitAgentTitleLength,
  normalizeAgentTitle,
  resumeAutoAgentTitleInWorkspace,
  setAutoAgentTitleInWorkspace,
  setAgentTitleInWorkspace,
} from '@renderer/workspace/agentTitle'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { WorkspaceState } from '@renderer/workspace/types'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import { carryDurableMeta } from '@renderer/workspace/hook/actions/undoClose'

function stateWithSessions(
  sessions: WorkspaceState['sessions'],
): WorkspaceState {
  const sessionId = Object.keys(sessions)[0] ?? ''
  // Every row is filed under the one project, in the order given. The cases
  // pass bare `{ cwd, kind }` rows because they are about TITLES; without this
  // stamp the rows would be unowned (#992: ownership is the row's own
  // `projectId`), no index would list them, and every row-level assertion
  // below would be reading `undefined`.
  const filed = Object.fromEntries(
    Object.entries(sessions).map(([id, meta], index) => [id, { projectId: 'tab', joinedAt: index, ...meta }]),
  )
  return {
    tabs: sessionId
      ? [{ id: 'tab', title: 'project' }]
      : [],
    activeTabId: sessionId ? 'tab' : '',
    stage: freshStage(),
    sessions: filed,
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

  it('preserves identity for unchanged and missing targets', () => {
    const titled = stateWithSessions({
      agent: { cwd: '/work/project', kind: 'codex', title: 'Review' },
    })
    expect(setAgentTitleInWorkspace(titled, 'agent', 'Review')).toBe(titled)
    expect(setAgentTitleInWorkspace(titled, 'missing', 'Nope')).toBe(titled)
  })

  it('titles a plain terminal with the same normalization as an agent (#865)', () => {
    // WHY terminals are titled now: a title is session metadata the user
    // authors to scan a busy grid, and a shell running a dev server needs a
    // label as much as an agent does. #660 scoped shells out; #865 reverses it.
    const terminal = stateWithSessions({ shell: { cwd: '/work/project', kind: 'terminal' } })
    const titled = setAgentTitleInWorkspace(terminal, 'shell', '  dev server  ')
    expect(titled.sessions.shell?.title).toBe('dev server')
    expect(buildVisibleDispatchRows(titled)[0]).toMatchObject({ agentTitle: 'dev server' })
  })

  it('lets an enabled agent update its own title while manual edits and clears remain protected', () => {
    const original = stateWithSessions({ agent: { cwd: '/work/project', kind: 'claude', builtInMcpDomains: ['auto_title'] } })
    const first = setAutoAgentTitleInWorkspace(original, 'agent', '  Fix queued prompts  ')
    expect(first.sessions.agent).toMatchObject({ title: 'Fix queued prompts', titleMode: 'auto' })
    const changed = setAutoAgentTitleInWorkspace(first, 'agent', 'Repair title routing')
    expect(changed.sessions.agent?.title).toBe('Repair title routing')

    const manual = setAgentTitleInWorkspace(changed, 'agent', 'My label')
    expect(manual.sessions.agent).toMatchObject({ title: 'My label', titleMode: 'manual' })
    expect(setAutoAgentTitleInWorkspace(manual, 'agent', 'Ignored')).toBe(manual)

    const cleared = setAgentTitleInWorkspace(manual, 'agent', '')
    expect(cleared.sessions.agent).toMatchObject({ titleMode: 'paused' })
    expect(cleared.sessions.agent?.title).toBeUndefined()
    expect(setAutoAgentTitleInWorkspace(cleared, 'agent', 'Ignored')).toBe(cleared)

    const resumed = resumeAutoAgentTitleInWorkspace(cleared, 'agent')
    expect(resumed.sessions.agent?.titleMode).toBeUndefined()
    expect(setAutoAgentTitleInWorkspace(resumed, 'agent', 'New job').sessions.agent?.title).toBe('New job')
  })

  it('protects legacy titles and never lets an agent title a terminal or disabled pane', () => {
    const original = stateWithSessions({
      legacy: { cwd: '/work/project', kind: 'codex', title: 'Human name', builtInMcpDomains: ['auto_title'] },
      shell: { cwd: '/work/project', kind: 'terminal', builtInMcpDomains: ['auto_title'] },
      disabled: { cwd: '/work/project', kind: 'pi' },
    })
    expect(setAutoAgentTitleInWorkspace(original, 'legacy', 'Ignored')).toBe(original)
    expect(setAutoAgentTitleInWorkspace(original, 'shell', 'Ignored')).toBe(original)
    expect(setAutoAgentTitleInWorkspace(original, 'disabled', 'Ignored')).toBe(original)
  })

  it('keeps a manual clear paused when an agent is restored under a new session ID', () => {
    const original = stateWithSessions({ agent: { cwd: '/work/project', kind: 'claude', builtInMcpDomains: ['auto_title'] } })
    const cleared = setAgentTitleInWorkspace(original, 'agent', '')
    const restored = carryDurableMeta({ cwd: '/work/project', kind: 'claude', builtInMcpDomains: ['auto_title'] }, cleared.sessions.agent!)
    const afterUndo = stateWithSessions({ replacement: restored })
    expect(afterUndo.sessions.replacement?.titleMode).toBe('paused')
    expect(setAutoAgentTitleInWorkspace(afterUndo, 'replacement', 'Wrong title')).toBe(afterUndo)
  })
})
