import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@shared/types/session'

import { PathPickerModal } from './PathPickerModal'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

function session(sessionId: string, summary: string): SessionInfo {
  return { sessionId, summary, lastModified: Date.now(), fileSize: 1 }
}

function installApi(listSessionsForCwd: Window['api']['listSessionsForCwd']): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      expandCwd: vi.fn(async () => ({ ok: true as const, path: '/repo' })),
      listSessionsForCwd,
      listDirectory: vi.fn(async () => ({ ok: true as const, entries: [] })),
      createDirectory: vi.fn(async () => ({ ok: true as const, path: '/repo' })),
    },
  })
}

describe('PathPickerModal resume target coherence', () => {
  it('removes an accepted Claude row before a pending Codex refresh can resolve', async () => {
    const codex = deferred<SessionInfo[]>()
    const list = vi.fn((_cwd: string, _limit: number, provider: string) =>
      provider === 'claude'
        ? Promise.resolve([session('claude-history', 'Claude saved row')])
        : codex.promise,
    )
    installApi(list as Window['api']['listSessionsForCwd'])
    const onResume = vi.fn()
    render(
      <PathPickerModal
        open
        defaultValue="/repo"
        onCancel={vi.fn()}
        onAccept={vi.fn()}
        onResume={onResume}
      />,
    )

    await screen.findByText('Claude saved row')
    fireEvent.click(screen.getByRole('button', { name: /^codex$/i }))

    // WHY assert during the unresolved replacement request: checking only
    // after Codex completes misses the hazardous 150ms+ window in which the
    // provider toggle has changed but a historical row can still be clicked.
    expect(screen.queryByText('Claude saved row')).not.toBeInTheDocument()
    expect(onResume).not.toHaveBeenCalled()

    codex.resolve([session('codex-history', 'Codex saved row')])
    fireEvent.click(await screen.findByText('Codex saved row'))
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(
      '/repo',
      'codex-history',
      'codex',
    ))
  })

  it('clears a failed listing message after a later successful target refresh', async () => {
    const list = vi.fn((_cwd: string, _limit: number, provider: string) =>
      provider === 'claude'
        ? Promise.reject(new Error('fixture listing failure'))
        : Promise.resolve([session('codex-history', 'Recovered Codex row')]),
    )
    installApi(list as Window['api']['listSessionsForCwd'])
    render(
      <PathPickerModal
        open
        defaultValue="/repo"
        onCancel={vi.fn()}
        onAccept={vi.fn()}
        onResume={vi.fn()}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load saved sessions')
    fireEvent.click(screen.getByRole('button', { name: /^codex$/i }))
    await screen.findByText('Recovered Codex row')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
