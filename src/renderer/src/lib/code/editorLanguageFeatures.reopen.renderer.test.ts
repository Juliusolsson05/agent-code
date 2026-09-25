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

// #1266 review C2: the 60 s ceiling is what bounds the long-run respawn rate
// for a server that dies at startup; the first test only grows to 20 s.
it('never waits more than 60 s between reopen attempts', async () => {
  vi.useFakeTimers()
  ;(window as { api?: unknown }).api = { changeLspDocument: vi.fn(async () => { throw lost }) }
  const reopen = vi.fn(async (_content: string) => false)
  const editor = model('file-editor://ceiling')
  const unregister = registerEditorLspContext('file-editor://ceiling', { workspaceRoot: '/repo', openDefinition: async () => false, reopen })
  const attempts: number[] = []
  for (let second = 0; second <= 240; second++) {
    const before = reopen.mock.calls.length
    editor.type(`t${second}`)
    await syncEditorLspModel(editor as never)
    if (reopen.mock.calls.length > before) attempts.push(second)
    vi.advanceTimersByTime(1_000)
  }
  // 5 s doubling, capped at 60 s.
  expect(attempts).toEqual([0, 5, 15, 35, 75, 135, 195])
  unregister()
})

// #1266 review C3: a reopen that resolves after its mount is gone must not
// mark anything synced, and nothing retries for the departed model.
it('ignores a reopen that settles after the editor unmounted', async () => {
  const changeLspDocument = vi.fn(async () => { throw lost })
  ;(window as { api?: unknown }).api = { changeLspDocument }
  let settle!: (value: boolean) => void
  const reopen = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve }))
  const editor = model('file-editor://gone')
  const unregister = registerEditorLspContext('file-editor://gone', { workspaceRoot: '/repo', openDefinition: async () => false, reopen })
  editor.type('second')
  const sync = syncEditorLspModel(editor as never)
  await vi.waitFor(() => expect(reopen).toHaveBeenCalledTimes(1))
  unregister()
  settle(true)
  expect(await sync).toBe(false)
  editor.type('third')
  expect(await syncEditorLspModel(editor as never)).toBe(false)
  expect(changeLspDocument).toHaveBeenCalledTimes(1)
  expect(reopen).toHaveBeenCalledTimes(1)
})

// #1266 review C4: the reopen carried this exact text, so the version is
// synced; without that, every later request re-sent a redundant didChange.
it('treats the reopened text as synced', async () => {
  const changeLspDocument = vi.fn(async () => { throw lost })
  ;(window as { api?: unknown }).api = { changeLspDocument }
  const editor = model('file-editor://synced')
  const unregister = registerEditorLspContext('file-editor://synced', { workspaceRoot: '/repo', openDefinition: async () => false, reopen: async () => true })
  editor.type('second')
  expect(await syncEditorLspModel(editor as never)).toBe(true)
  expect(await syncEditorLspModel(editor as never)).toBe(true)
  expect(changeLspDocument).toHaveBeenCalledTimes(1)
  unregister()
})
