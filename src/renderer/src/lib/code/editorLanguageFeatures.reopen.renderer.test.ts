import { afterEach, expect, it, vi } from 'vitest'

import { registerEditorLspContext, syncEditorLspModel } from './editorLanguageFeatures'

// #1208: when the server loses a document the editor still shows, the sync
// gate asks for it back, and a server that keeps dying is not respawned on
// every keystroke.
const lost = new Error("Error invoking remote method 'lsp:change-document': Error: LSP document is not open")

function model(uri: string) {
  let version = 1
  let text = 'first'
  return {
    uri: { toString: () => uri },
    getVersionId: () => version,
    getValue: () => text,
    type: (next: string) => { text = next; version += 1 },
  }
}

const originalApi = (window as { api?: unknown }).api
afterEach(() => { (window as { api?: unknown }).api = originalApi; vi.useRealTimers() })

it('reopens a lost document with the current text, and backs off while reopening keeps failing', async () => {
  vi.useFakeTimers()
  const changeLspDocument = vi.fn(async () => { throw lost })
  ;(window as { api?: unknown }).api = { changeLspDocument }
  const reopen = vi.fn(async (_content: string) => false)
  const editor = model('file-editor://lost')
  const unregister = registerEditorLspContext('file-editor://lost', { workspaceRoot: '/repo', openDefinition: async () => false, reopen })

  editor.type('second')
  expect(await syncEditorLspModel(editor as never)).toBe(false)
  expect(reopen).toHaveBeenCalledTimes(1)
  expect(reopen).toHaveBeenLastCalledWith('second')

  // Typing inside the backoff window does not respawn anything.
  editor.type('third')
  await syncEditorLspModel(editor as never)
  expect(reopen).toHaveBeenCalledTimes(1)

  // The window expires, and the next try is allowed.
  vi.advanceTimersByTime(5_000)
  editor.type('fourth')
  await syncEditorLspModel(editor as never)
  expect(reopen).toHaveBeenCalledTimes(2)

  // The window doubled: 5 s later is still inside it.
  vi.advanceTimersByTime(5_000)
  editor.type('fifth')
  await syncEditorLspModel(editor as never)
  expect(reopen).toHaveBeenCalledTimes(2)

  // A success syncs this version and resets the backoff.
  vi.advanceTimersByTime(5_000)
  reopen.mockResolvedValue(true)
  editor.type('sixth')
  expect(await syncEditorLspModel(editor as never)).toBe(true)
  expect(reopen).toHaveBeenLastCalledWith('sixth')

  // After a success the backoff starts over at 5 s, not where it had grown.
  reopen.mockResolvedValue(false)
  editor.type('seventh')
  await syncEditorLspModel(editor as never)
  expect(reopen).toHaveBeenCalledTimes(4)
  vi.advanceTimersByTime(5_000)
  editor.type('eighth')
  await syncEditorLspModel(editor as never)
  expect(reopen).toHaveBeenCalledTimes(5)
  unregister()
})

it('does not reopen on any other failure', async () => {
  ;(window as { api?: unknown }).api = { changeLspDocument: vi.fn(async () => { throw new Error('LSP document is too large') }) }
  const reopen = vi.fn(async () => true)
  const editor = model('file-editor://other')
  const unregister = registerEditorLspContext('file-editor://other', { workspaceRoot: '/repo', openDefinition: async () => false, reopen })
  editor.type('second')
  expect(await syncEditorLspModel(editor as never)).toBe(false)
  expect(reopen).not.toHaveBeenCalled()
  unregister()
})

// #1266 review B3: the newest mount replaced the shared reopen callback, and
// unmounting it left that dead callback selected for the surviving mount.
it('reopens with the surviving mount after the newest one unmounts', async () => {
  ;(window as { api?: unknown }).api = { changeLspDocument: vi.fn(async () => { throw lost }) }
  const survivor = vi.fn(async (_content: string) => true)
  const departed = vi.fn(async (_content: string) => false)
  const editor = model('file-editor://two-mounts')
  const unregisterA = registerEditorLspContext('file-editor://two-mounts', { workspaceRoot: '/repo', openDefinition: async () => false, reopen: survivor })
  const unregisterB = registerEditorLspContext('file-editor://two-mounts', { workspaceRoot: '/repo', openDefinition: async () => false, reopen: departed })
  unregisterB()
  editor.type('second')
  expect(await syncEditorLspModel(editor as never)).toBe(true)
  expect(survivor).toHaveBeenCalledWith('second')
  expect(departed).not.toHaveBeenCalled()
  unregisterA()
})
