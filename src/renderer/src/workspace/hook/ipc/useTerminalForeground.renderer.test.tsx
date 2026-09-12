import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { TerminalForegroundEvent, TerminalForegroundState } from '@shared/types/terminalForeground'
import type { WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import { useTerminalForeground } from './useTerminalForeground'

const initialStore = useAppStore.getState()
const originalApi = window.api
afterEach(() => {
  useAppStore.setState(initialStore, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

function Harness({ status }: { status: WorkspaceRestoreStatus }) {
  useTerminalForeground(status, useAppStore(state => state.setWorkspaceRuntimes))
  return null
}

it('applies live events, and adopts the snapshot only once the workspace has restored', async () => {
  let live!: (event: TerminalForegroundEvent) => void
  const snapshot: Record<string, TerminalForegroundState> = { shell: { busy: true, command: 'npm', cwd: '/w' } }
  const getTerminalForegrounds = vi.fn(async () => snapshot)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onTerminalForeground: (cb: typeof live) => { live = cb; return () => {} },
      getTerminalForegrounds,
    },
  })

  const { rerender } = render(<Harness status="pending" />)
  // Before restore the runtimes are about to be replaced by rehydrate, so a
  // snapshot applied now would be thrown away. It must wait.
  expect(getTerminalForegrounds).not.toHaveBeenCalled()

  rerender(<Harness status="complete-restore" />)
  await act(async () => { await Promise.resolve() })
  expect(useAppStore.getState().workspaceRuntimes.shell?.sessionStatus).toBe('running')

  act(() => live({ sessionId: 'shell', busy: false, command: 'zsh', cwd: '/w' }))
  expect(useAppStore.getState().workspaceRuntimes.shell).toMatchObject({ sessionStatus: 'idle', unreadKind: 'output' })
})
