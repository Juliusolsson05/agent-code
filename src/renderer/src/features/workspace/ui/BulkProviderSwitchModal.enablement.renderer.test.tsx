import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'

vi.mock('@renderer/features/providers/store', () => ({
  useProviderEnablementStore: { getState: () => ({ enabledKinds: new Set(['claude', 'codex']) }) },
  useEnabledAgentProviderKinds: vi.fn(),
  enabledAgentProviderKindsSnapshot: vi.fn(),
}))

import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'

// Minimal mirror of the policy test's fixture — only the fields the modal's
// render path reads; the assertion is about the OFFERED directions, not the
// batch machinery.
function workspaceFixture(): Workspace {
  return {
    state: {
      activeTabId: 'project-tab',
      tabs: [{ id: 'project-tab', title: 'Project tab' }],
      sessions: { agent: { cwd: '/projects/agent-code', kind: 'codex', projectId: 'project-tab', joinedAt: 0 } },
      pinnedSessionIds: [],
      stage: { lanes: [{ selectedSessionId: 'agent' }], rows: [{ length: 1 }], focusedLane: 0 },
      lastProviderSwitchBatch: null,
    },
    runtimes: { agent: { ...emptyRuntime(), entries: [] } },
    focusSessionInTab: vi.fn(),
    closeSession: vi.fn(),
    switchAgentsToProvider: vi.fn().mockResolvedValue(undefined),
    returnLastProviderSwitchBatch: vi.fn(),
  } as unknown as Workspace
}

describe('BulkProviderSwitchModal enablement filtering', () => {
  beforeEach(() => {
    vi.mocked(useEnabledAgentProviderKinds).mockReturnValue(new Set(['claude', 'codex']))
  })

  it('offers no direction involving a disabled provider', () => {
    render(<BulkProviderSwitchModal open workspace={workspaceFixture()} onClose={() => {}} />)
    // Assert on the direction <option>s specifically: the modal's static
    // description copy mentions provider names and is not an offered choice.
    const optionText = [...document.querySelectorAll('option')].map(o => o.textContent ?? '').join('|')
    expect(optionText).toBe('Claude → Codex|Codex → Claude')
    expect(optionText).not.toContain('Grok')
    expect(optionText).not.toContain('OpenCode')
  })
})
