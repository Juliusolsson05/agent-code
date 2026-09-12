import { expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { buildAgentRows } from './CloseOldAgentsModal'

// Close Old Agents aged sessions by transcript timestamps, which shells do not
// have, so terminals were excluded outright. The foreground monitor (#865) gives
// them an age: the last time a command started, finished or the shell cd'd.
it('ages an idle terminal from its last foreground change', () => {
  const state = {
    tabs: [{ id: 'tab', title: 'project', root: { type: 'leaf', sessionId: 'shell' }, focusedSessionId: 'shell' }],
    activeTabId: 'tab', dispatchMode: null, gridRelatedSelections: {},
    sessions: { shell: { cwd: '/work/api', kind: 'terminal' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: [],
  } as unknown as Workspace['state']
  const runtimes = {
    shell: { ...emptyRuntime(), terminalForeground: { busy: false, command: 'zsh', cwd: '/work/api', changedAt: 1_000 } },
  } as Workspace['runtimes']

  expect(buildAgentRows(state, runtimes, 61_000)).toEqual([
    expect.objectContaining({ sessionId: 'shell', kind: 'terminal', lastActiveAt: 1_000, ageMs: 60_000, isLive: false }),
  ])
})
