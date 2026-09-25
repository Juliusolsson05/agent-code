import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { ConfirmHost } from '@renderer/components/ui/confirm-dialog'
import { KeyVaultModal } from './KeyVaultModal'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// The app, not a modal, owns workspace boot/subscriptions. This catches an
// accidental call to useWorkspace() while exercising the real context seam.
vi.mock('@renderer/workspace/workspaceStore', () => ({
  useWorkspace: () => { throw new Error('Modal started another workspace controller') },
}))
const api = {
  keyVaultStatus: vi.fn(async () => ({ encryptionAvailable: true, authPromptAvailable: true, unlocked: true })),
  keyVaultList: vi.fn(async () => ({
    providers: [{ id: 'p', name: 'Brave' }],
    keys: [{ id: 'k', providerId: 'p', name: 'main', note: '', hint: '1234' }],
  })),
  keyVaultUnlock: vi.fn(async () => {}),
  keyVaultLock: vi.fn(async () => {}),
  keyVaultReveal: vi.fn(async () => 'test-secret-1234'),
  keyVaultRenameProvider: vi.fn(async () => {}),
  keyVaultPutKey: vi.fn(async () => {}),
  onKeyVaultLocked: vi.fn((_callback: () => void) => () => {}),
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', api)
  Object.assign(window, { api })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function open() {
  render(<WorkspaceProvider workspace={{ state: { sessions: {}, tabs: [], activeTabId: '',   pinnedSessionIds: [], stage: oneLaneStage() } } as unknown as Workspace}>
    <KeyVaultModal />
  </WorkspaceProvider>)
}

it('reuses the app workspace and renames a provider through an inline form', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
  fireEvent.change(screen.getByPlaceholderText('Provider name'), { target: { value: 'Brave Search' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(api.keyVaultRenameProvider).toHaveBeenCalledWith('p', 'Brave Search'))
})

it('drops a pending reveal after a lock broadcast instead of displaying stale plaintext', async () => {
  let resolve!: (value: string) => void
  const promise = new Promise<string>(done => { resolve = done })
  api.keyVaultReveal.mockReturnValueOnce(promise)
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
  await waitFor(() => expect(api.keyVaultReveal).toHaveBeenCalled())
  act(() => api.onKeyVaultLocked.mock.calls.at(-1)![0]())
  await act(async () => { resolve('test-secret-1234'); await promise })
  expect(screen.queryByText('test-secret-1234')).toBeNull()
})

it('keeps a failed key edit available for retry', async () => {
  api.keyVaultPutKey.mockRejectedValueOnce(new Error('Disk unavailable'))
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByPlaceholderText('Note (optional)'), { target: { value: 'keep my edits' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Disk unavailable')
  expect(screen.getByPlaceholderText('Note (optional)')).toHaveValue('keep my edits')
})

// Plan S36: the key form saves on Enter, a typed key is never thrown away by
// one Escape, and the provider list is a one-Tab-stop tablist.
it('saves a new key on Enter from its fields and labels Save ↩', async () => {
  open()
  fireEvent.click(await screen.findByRole('button', { name: '+ New Key' }))
  fireEvent.change(screen.getByPlaceholderText('Key name (e.g. main)'), { target: { value: 'ci' } })
  const value = screen.getByPlaceholderText('Value')
  fireEvent.change(value, { target: { value: 'secret' } })
  expect(screen.getByRole('button', { name: 'Save' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
  fireEvent.keyDown(value, { key: 'Enter' })
  await waitFor(() => expect(api.keyVaultPutKey).toHaveBeenCalledWith(expect.objectContaining({ name: 'ci', value: 'secret' })))
})

it('asks before Escape discards a key being typed', async () => {
  render(<WorkspaceProvider workspace={{ state: { sessions: {}, tabs: [], activeTabId: '', pinnedSessionIds: [], stage: oneLaneStage() } } as unknown as Workspace}>
    <KeyVaultModal />
    <ConfirmHost />
  </WorkspaceProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '+ New Key' }))
  const value = screen.getByPlaceholderText('Value')
  fireEvent.change(value, { target: { value: 'secret' } })
  fireEvent.keyDown(value, { key: 'Escape' })
  expect(await screen.findByRole('dialog', { name: 'Discard this key?' })).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
})

it('makes the provider list one Tab stop and closes from Close ⎋', async () => {
  open()
  const tab = await screen.findByRole('tab', { name: 'Brave' })
  expect(tab).toHaveAttribute('tabindex', '0')
  expect(tab).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('button', { name: 'Close' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
})

// Steering note k6: switching provider must not silently drop a typed key,
// and an UNTOUCHED Edit form is not "dirty".
function openWithConfirm() {
  render(<WorkspaceProvider workspace={{ state: { sessions: {}, tabs: [], activeTabId: '', pinnedSessionIds: [], stage: oneLaneStage() } } as unknown as Workspace}>
    <KeyVaultModal />
    <ConfirmHost />
  </WorkspaceProvider>)
}
const twoProviders = {
  providers: [{ id: 'p', name: 'Brave' }, { id: 'q', name: 'Exa' }],
  keys: [{ id: 'k', providerId: 'p', name: 'main', note: 'prod', hint: '1234' }],
}

it.each(['arrow', 'click'] as const)('asks before a provider switch by %s drops a typed key, and keeps both on Cancel', async how => {
  api.keyVaultList.mockResolvedValue(twoProviders)
  openWithConfirm()
  fireEvent.click(await screen.findByRole('button', { name: '+ New Key' }))
  fireEvent.change(screen.getByPlaceholderText('Value'), { target: { value: 'typed-secret' } })
  const brave = screen.getByRole('tab', { name: 'Brave' })
  if (how === 'arrow') {
    brave.focus()
    fireEvent.keyDown(brave, { key: 'ArrowDown' })
  } else {
    fireEvent.click(screen.getByRole('tab', { name: 'Exa' }))
  }
  const confirm = await screen.findByRole('dialog', { name: 'Discard this key?' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
  await waitFor(() => expect(confirm).not.toBeInTheDocument())
  expect(screen.getByRole('tab', { name: 'Brave' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByPlaceholderText('Value')).toHaveValue('typed-secret')
})

it('closes an untouched Edit form without asking, and asks once its note changes', async () => {
  api.keyVaultList.mockResolvedValue(twoProviders)
  openWithConfirm()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  // Untouched (seeded name "main", note "prod"): switching provider does not ask.
  fireEvent.click(screen.getByRole('tab', { name: 'Exa' }))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Exa' })).toHaveAttribute('aria-selected', 'true'))
  expect(screen.queryByRole('dialog', { name: 'Discard this key?' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Brave' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByPlaceholderText('Note (optional)'), { target: { value: 'staging' } })
  fireEvent.click(screen.getByRole('tab', { name: 'Exa' }))
  expect(await screen.findByRole('dialog', { name: 'Discard this key?' })).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
})
