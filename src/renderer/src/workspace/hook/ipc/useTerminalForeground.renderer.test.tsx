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

const recordUsage = vi.fn()
const readRuntime = (sessionId: string) => useAppStore.getState().workspaceRuntimes[sessionId]

function Harness({ status }: { status: WorkspaceRestoreStatus }) {
  useTerminalForeground(status, useAppStore(state => state.setWorkspaceRuntimes), readRuntime, recordUsage)
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

it('treats the post-restart snapshot as a first sighting, and only a real change as use (#1178)', async () => {
  recordUsage.mockClear()
  let live!: (event: TerminalForegroundEvent) => void
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onTerminalForeground: (cb: typeof live) => { live = cb; return () => {} },
      // What main hands a freshly restarted renderer: every shell's CURRENT
      // state, into runtimes that have none yet.
      getTerminalForegrounds: vi.fn(async () => ({ shell: { busy: false, command: 'zsh', cwd: '/w' } })),
    },
  })

  render(<Harness status="complete-restore" />)
  await act(async () => { await Promise.resolve() })
  // The restart is not a use: it may only give a record-less shell its floor.
  expect(recordUsage.mock.calls).toEqual([['shell', 'floor']])

  // The same state again changes nothing, so it is not a use either.
  act(() => live({ sessionId: 'shell', busy: false, command: 'zsh', cwd: '/w' }))
  expect(recordUsage).toHaveBeenCalledTimes(1)

  // A command starting is.
  act(() => live({ sessionId: 'shell', busy: true, command: 'npm', cwd: '/w' }))
  expect(recordUsage.mock.calls.at(-1)).toEqual(['shell', 'use'])
})
