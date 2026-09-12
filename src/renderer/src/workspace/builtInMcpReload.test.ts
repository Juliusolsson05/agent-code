import { describe, expect, it, vi } from 'vitest'

import { reloadSessionWithBuiltInMcpChoice } from '@renderer/workspace/builtInMcpReload'
import type { Workspace } from '@renderer/workspace/workspaceStore'

const labels = { reloaded: 'Reloaded with it', failed: 'Reload failed' }

describe('reloadSessionWithBuiltInMcpChoice', () => {
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

  it('pins the reload to the named session and records the grant as an explicit choice', async () => {
    const replaceSession = vi.fn().mockResolvedValue('target-2')
    const { workspace, showPaneToast } = workspaceWith(replaceSession)

    await expect(reloadSessionWithBuiltInMcpChoice(workspace, 'target', 'root_management', true, labels))
      .resolves.toBe('target-2')
    // The failure this guards: the confirmation dialog is open while Dispatch
    // focus moves, and an unpinned reload would grant root to the wrong agent.
    //
    // The grant is a per-domain CHOICE rather than a new effective list, so a
    // later global Settings change cannot reverse it, and the pane's existing
    // TLDR capability is preserved as its own choice rather than being
    // overwritten by this one edit.
    expect(replaceSession).toHaveBeenCalledWith('/projects/app', {
      kind: 'codex',
      targetSessionId: 'target',
      resumeSessionId: 'thread-1',
      builtInMcpOverrides: { tldr: true, root_management: true },
    })
    expect(showPaneToast).toHaveBeenCalledWith('target-2', 'Reloaded with it')
  })

  it('revokes by writing an explicit off rather than dropping back to inheritance', async () => {
    const replaceSession = vi.fn().mockResolvedValue('target-2')
    const { workspace } = workspaceWith(replaceSession)

    await reloadSessionWithBuiltInMcpChoice(workspace, 'target', 'root_management', false, labels)
    // Revoking must survive the next reload even if something else would have
    // supplied the capability, so it is recorded as false, not as absence.
    expect(replaceSession).toHaveBeenCalledWith('/projects/app', expect.objectContaining({
      builtInMcpOverrides: { tldr: true, root_management: false },
    }))
  })

  it('reports a failed reload on the original pane and refuses non-agent sessions', async () => {
    const replaceSession = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    const { workspace, showPaneToast } = workspaceWith(replaceSession)

    await expect(reloadSessionWithBuiltInMcpChoice(workspace, 'target', 'root_management', true, labels)).resolves.toBeUndefined()
    expect(showPaneToast).toHaveBeenCalledWith('target', 'provider unavailable')

    await expect(reloadSessionWithBuiltInMcpChoice(workspace, 'shell', 'root_management', true, labels)).resolves.toBeUndefined()
    expect(replaceSession).toHaveBeenCalledTimes(1)
  })
})
