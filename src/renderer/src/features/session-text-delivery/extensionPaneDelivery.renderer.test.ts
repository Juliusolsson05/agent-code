import { describe, expect, it, vi } from 'vitest'

import {
  deliverTextToSession,
  textDeliverySurface,
} from '@renderer/features/session-text-delivery/deliverTextToSession'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'

// An extension pane has neither a composer nor a PTY. Key Vault insertion used to
// resolve it as a "rendered" agent surface, write the secret into an invisible
// composer draft, report success, and let autosave persist it to workspace.json.
describe('text delivery into an extension-view pane', () => {
  it('refuses instead of writing a hidden composer draft', async () => {
    const state = {
      sessions: { ext: { kind: 'extension-view', cwd: '/repo', extensionViewId: 'timer.main' } },
    } as unknown as WorkspaceState
    const setDraftInput = vi.fn()
    const workspace = { state, getRuntime: () => emptyRuntime(), setDraftInput, ensureSessionLive: vi.fn() } as never

    expect(textDeliverySurface(workspace, 'ext')).toBeNull()
    expect(await deliverTextToSession(workspace, 'ext', 'sk-live-SECRET')).toEqual({ delivered: false, reason: 'no-session' })
    expect(setDraftInput).not.toHaveBeenCalled()
  })
})
