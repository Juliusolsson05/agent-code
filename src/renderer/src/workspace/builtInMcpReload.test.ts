import { describe, expect, it, vi } from 'vitest'

import {
  reloadSessionWithBuiltInMcpDomains,
  withBuiltInMcpDomain,
} from '@renderer/workspace/builtInMcpReload'
import type { Workspace } from '@renderer/workspace/workspaceStore'

const labels = { reloaded: 'Reloaded with it', failed: 'Reload failed' }

describe('withBuiltInMcpDomain', () => {
  it('writes the whole snapshot back with the domain added once or removed', () => {
    expect(withBuiltInMcpDomain(['tldr'], 'root_management', true)).toEqual(['tldr', 'root_management'])
    expect(withBuiltInMcpDomain(['tldr', 'root_management'], 'root_management', true)).toEqual(['tldr', 'root_management'])
    expect(withBuiltInMcpDomain(['tldr', 'root_management'], 'root_management', false)).toEqual(['tldr'])
    expect(withBuiltInMcpDomain(undefined, 'root_management', true)).toEqual(['root_management'])
  })
})

describe('reloadSessionWithBuiltInMcpDomains', () => {
  function workspaceWith(replaceSession: Workspace['replaceSession']) {
    const showPaneToast = vi.fn()
    const workspace = {
      state: {
        sessions: {
          target: { cwd: '/projects/app', kind: 'codex', providerSessionId: 'thread-1', builtInMcpDomains: ['tldr'] },
          shell: { cwd: '/projects/app', kind: 'terminal' },
        },
      },
      replaceSession,
      showPaneToast,
    } as unknown as Workspace
    return { workspace, showPaneToast }
  }

  it('pins the reload to the named session and resumes its conversation with the new domains', async () => {
    const replaceSession = vi.fn().mockResolvedValue('target-2')
    const { workspace, showPaneToast } = workspaceWith(replaceSession)

    await expect(reloadSessionWithBuiltInMcpDomains(workspace, 'target', ['tldr', 'root_management'], labels))
      .resolves.toBe('target-2')
    // The failure this guards: the confirmation dialog is open while Dispatch
    // focus moves, and an unpinned reload would grant root to the wrong agent.
    expect(replaceSession).toHaveBeenCalledWith('/projects/app', {
      kind: 'codex',
      targetSessionId: 'target',
      resumeSessionId: 'thread-1',
      builtInMcpDomains: ['tldr', 'root_management'],
    })
    expect(showPaneToast).toHaveBeenCalledWith('target-2', 'Reloaded with it')
  })

  it('reports a failed reload on the original pane and refuses non-agent sessions', async () => {
    const replaceSession = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    const { workspace, showPaneToast } = workspaceWith(replaceSession)

    await expect(reloadSessionWithBuiltInMcpDomains(workspace, 'target', ['root_management'], labels)).resolves.toBeUndefined()
    expect(showPaneToast).toHaveBeenCalledWith('target', 'provider unavailable')

    await expect(reloadSessionWithBuiltInMcpDomains(workspace, 'shell', ['root_management'], labels)).resolves.toBeUndefined()
    expect(replaceSession).toHaveBeenCalledTimes(1)
  })
})
