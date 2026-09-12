import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { KeyVaultModal } from './KeyVaultModal'

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
  render(<WorkspaceProvider workspace={{ state: { sessions: {}, tabs: [] } } as unknown as Workspace}>
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
