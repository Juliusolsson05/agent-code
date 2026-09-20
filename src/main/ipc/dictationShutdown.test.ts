import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  key: vi.fn(), batch: vi.fn(), append: vi.fn(), unregister: vi.fn(), configure: vi.fn(),
  preview: { start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), pushChunk: vi.fn() },
}))
vi.mock('electron', () => ({ app: { getPath: () => '/unused' }, ipcMain: {
  handle: (name: string, handler: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, handler), on: vi.fn(),
} }))
vi.mock('@main/dictation/index.js', () => ({ deepgramStreaming: () => mocks.preview, transcribeBatch: mocks.batch }))
vi.mock('@main/dictation/hotkey.js', () => ({ unregisterDictationHotkey: mocks.unregister, configureDictationHotkey: mocks.configure }))
vi.mock('@main/dictation/apiKeyStore.js', () => ({ readDeepgramApiKeyForRuntime: mocks.key,
  getDeepgramApiKeyStatus: vi.fn(), setDeepgramApiKey: vi.fn() }))
vi.mock('@main/dictation/historyStore.js', () => ({ appendEntry: mocks.append,
  clearEntries: vi.fn(), deleteEntry: vi.fn(), readHistory: vi.fn(), resetTotals: vi.fn() }))
vi.mock('@main/window/windowRegistry.js', () => ({ windowIdFor: () => 'window', sendToWindow: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function invoke(name: string, params: unknown) {
  const handler = mocks.handlers.get(`dictation:${name}`)
  if (!handler) throw new Error(`Handler missing: ${name}`)
  return handler({ sender: {} }, params)
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.handlers.clear()
  vi.unstubAllGlobals()
  mocks.key.mockResolvedValue('test-only-key')
  mocks.preview.start.mockReturnValue({ id: 'preview' })
  mocks.preview.stop.mockResolvedValue(null)
  mocks.append.mockResolvedValue(undefined)
})

async function setup() {
  const module = await import('./dictation')
  module.registerDictationIpc({ dictationDebugJournals: { get: () => ({ append: vi.fn() }) },
    appRunJournal: { record: vi.fn() } } as never)
  return module
}

describe('dictation IPC shutdown ownership', () => {
  it('does not publish a stream after shutdown overtakes key resolution', async () => {
    const key = deferred<string>()
    mocks.key.mockReturnValue(key.promise)
    const module = await setup()
    const start = invoke('stream-start', { provider: 'deepgram' })
    const settled = vi.fn()
    const shutdown = module.cleanupDictationIpcResources().then(settled)
    expect(settled).not.toHaveBeenCalled()
    key.resolve('test-only-key')
    expect(await start).toMatchObject({ kind: 'error' })
    await shutdown
    expect(mocks.preview.start).not.toHaveBeenCalled()
    await expect(invoke('stream-start', { provider: 'deepgram' })).rejects.toThrow('shutting down')
  })

  it('cancels previews without joining abandoned stop promises and drains admitted batch/history producers', async () => {
    const module = await setup()
    const batch = deferred<{ kind: 'ok'; raw: string }>()
    const preview = deferred<null>()
    mocks.batch.mockReturnValue(batch.promise)
    mocks.preview.stop.mockReturnValue(preview.promise)
    const { id } = await invoke('stream-start', { provider: 'deepgram' })
    await invoke('stream-chunk', { id, chunk: new ArrayBuffer(4) })
    const stop = invoke('stream-stop', { id, audioDurationMs: 1000 })
    expect(mocks.batch).toHaveBeenCalledOnce()
    // A second utterance is still active while the first batch owns work that
    // has already disappeared from activeSessions. Both lifetimes must drain.
    await invoke('stream-start', { provider: 'deepgram' })
    const settled = vi.fn()
    const shutdown = module.cleanupDictationIpcResources().then(settled)
    expect(mocks.preview.cancel).toHaveBeenCalledWith('preview')
    expect(mocks.batch.mock.calls[0]![0].signal.aborted).toBe(true)
    batch.resolve({ kind: 'ok', raw: 'recoverable dictation' })
    await stop
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ text: 'recoverable dictation' }))
    await shutdown
    expect(settled).toHaveBeenCalledOnce()
    // The native preview cancel contract may never settle preview.promise.
    // That optional promise cannot hold committed application exit.
    preview.resolve(null)
  })

  it('removes a hotkey installed by a configuration request that finishes after shutdown', async () => {
    const module = await setup()
    const configured = deferred<{ ok: boolean; binding: string }>()
    mocks.configure.mockReturnValue(configured.promise)
    const request = invoke('hotkey-configure', { binding: 'Fn' })
    const shutdown = module.cleanupDictationIpcResources()
    configured.resolve({ ok: true, binding: 'Fn' })
    expect(await request).toMatchObject({ ok: false })
    await shutdown
    expect(mocks.unregister).toHaveBeenCalledTimes(2)
  })
  it('propagates committed cancellation through the real controller and pinned provider HTTP path', async () => {
    const { transcribeBatch } = await import('../dictation/controller')
    mocks.batch.mockImplementation(transcribeBatch)
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Quit cancelled HTTP', 'AbortError')), { once: true })
      })
    }))
    try {
      const module = await setup()
      const { id } = await invoke('stream-start', { provider: 'deepgram' })
      await invoke('stream-chunk', { id, chunk: new ArrayBuffer(4) })
      const stop = invoke('stream-stop', { id, audioDurationMs: 1000 })
      expect(signal?.aborted).toBe(false)
      await module.cleanupDictationIpcResources()
      expect(signal?.aborted).toBe(true)
      expect(await stop).toMatchObject({ kind: 'error' })
      expect(mocks.append).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

})
