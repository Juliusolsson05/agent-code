import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Conversation, ConversationListRequest, ConversationListResponse } from '@shared/conversations/types'

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

// A catalog row as main emits it; only the fields the picker shows vary.
function row(nativeId: string, label: string, provider: Conversation['provider']): Conversation {
  return {
    provider, nativeId, cwd: '/repo', repoRoot: '/repo', worktree: null, gitBranch: 'main', kind: 'user', parentNativeId: null,
    label, labelSource: 'first-prompt', firstPrompt: label, agentName: null, agentCodeTitle: null, createdAt: 1,
    lastUserActivityAt: Date.now(), activitySource: 'index', promptCount: 2, available: true, origin: 'index', match: null,
  }
}
function response(rows: Conversation[]): ConversationListResponse {
  return { rows, total: rows.length, hiddenChildren: 0, nextCursor: null, family: { repoRoot: '/repo', roots: ['/repo'] }, timing: { ms: 1 } }
}

function installApi(listConversations: (request: ConversationListRequest) => Promise<ConversationListResponse>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      expandCwd: vi.fn(async () => ({ ok: true as const, path: '/repo' })),
      listConversations,
      listDirectory: vi.fn(async () => ({ ok: true as const, entries: [] })),
      createDirectory: vi.fn(async () => ({ ok: true as const, path: '/repo' })),
    },
  })
}

describe('PathPickerModal resume target coherence', () => {
  it('removes an accepted Claude row before a pending Codex refresh can resolve', async () => {
    const codex = deferred<ConversationListResponse>()
    const list = vi.fn((request: ConversationListRequest) =>
      request.providers?.[0] === 'claude'
        ? Promise.resolve(response([row('claude-history', 'Claude saved row', 'claude')]))
        : codex.promise,
    )
    installApi(list)
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
    expect(list).toHaveBeenCalledWith({ cwd: '/repo', scope: 'cwd', providers: ['claude'], includeChildren: false, limit: 50 })
    fireEvent.click(screen.getByRole('button', { name: /^codex$/i }))

    // WHY assert during the unresolved replacement request: checking only
    // after Codex completes misses the hazardous 150ms+ window in which the
    // provider toggle has changed but a historical row can still be clicked.
    expect(screen.queryByText('Claude saved row')).not.toBeInTheDocument()
    expect(onResume).not.toHaveBeenCalled()

    codex.resolve(response([row('codex-history', 'Codex saved row', 'codex'), { ...row('gone-history', 'Gone Codex row', 'codex'), available: false }]))
    // A row whose transcript file is gone is listed for the record only.
    fireEvent.click(await screen.findByText('Gone Codex row'))
    expect(onResume).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByText('Codex saved row'))
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(
      '/repo',
      'codex-history',
      'codex',
    ))
    expect(list).toHaveBeenLastCalledWith({ cwd: '/repo', scope: 'cwd', providers: ['codex'], includeChildren: false, limit: 50 })
  })

  it('clears a failed listing message after a later successful target refresh', async () => {
    const list = vi.fn((request: ConversationListRequest) =>
      request.providers?.[0] === 'claude'
        ? Promise.reject(new Error('fixture listing failure'))
        : Promise.resolve(response([row('codex-history', 'Recovered Codex row', 'codex')])),
    )
    installApi(list)
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

describe('PathPickerModal reuse of an open tab (#913)', () => {
  it('goes to the tab that already holds the folder, and only creates on an explicit new-tab choice', async () => {
    installApi(vi.fn(async () => response([])))
    const onAccept = vi.fn()
    const onActivateTab = vi.fn()
    render(
      <PathPickerModal
        open
        defaultValue="/repo"
        onCancel={vi.fn()}
        onAccept={onAccept}
        onResume={vi.fn()}
        openTabsForPath={path => (path === '/repo' ? [{ tabId: 'tab-e', label: 'E · repo' }] : [])}
        onActivateTab={onActivateTab}
      />,
    )

    // The hint follows the debounced resolution of the typed path.
    await screen.findByText('Already open as E · repo.')
    expect(screen.queryByRole('button', { name: 'new session' })).not.toBeInTheDocument()

    // Enter (the input's submit) and the primary button both go to the tab:
    // this is the default that stops ⌘T from minting duplicate tabs.
    fireEvent.click(screen.getByRole('button', { name: 'go to tab' }))
    await waitFor(() => expect(onActivateTab).toHaveBeenCalledWith('tab-e'))
    expect(onAccept).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'new tab anyway' }))
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('/repo', 'claude'))
  })

  it('creates as before when no tab holds the folder', async () => {
    installApi(vi.fn(async () => response([])))
    const onAccept = vi.fn()
    const onActivateTab = vi.fn()
    render(
      <PathPickerModal
        open
        defaultValue="/repo"
        onCancel={vi.fn()}
        onAccept={onAccept}
        onResume={vi.fn()}
        openTabsForPath={() => []}
        onActivateTab={onActivateTab}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'new session' }))
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('/repo', 'claude'))
    expect(onActivateTab).not.toHaveBeenCalled()
    expect(screen.queryByText(/Already open as/)).not.toBeInTheDocument()
  })
})
