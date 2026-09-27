import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #243: main's non-success answers carry a code, the OUTCOME row carries the
// same code, and the text the renderer shows comes from the code. The failures
// replayed here are the recorded `batch:upload:throw` rows in
// testing/fixtures/dictation/lifecycle-sessions-2026-09.json.

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  key: vi.fn(), batch: vi.fn(), append: vi.fn(),
  preview: { start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), pushChunk: vi.fn() },
  journal: [] as Array<{ layer: string; event: string; data?: Record<string, unknown> }>,
}))
vi.mock('electron', () => ({ app: { getPath: () => '/unused' }, ipcMain: {
  handle: (name: string, handler: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, handler), on: vi.fn(),
} }))
vi.mock('@main/dictation/index.js', () => ({ deepgramStreaming: () => mocks.preview, transcribeBatch: mocks.batch }))
vi.mock('@main/dictation/hotkey.js', () => ({ unregisterDictationHotkey: vi.fn(), configureDictationHotkey: vi.fn() }))
vi.mock('@main/dictation/apiKeyStore.js', () => ({ readDeepgramApiKeyForRuntime: mocks.key,
  getDeepgramApiKeyStatus: vi.fn(), setDeepgramApiKey: vi.fn() }))
vi.mock('@main/dictation/historyStore.js', () => ({ appendEntry: mocks.append,
  clearEntries: vi.fn(), deleteEntry: vi.fn(), readHistory: vi.fn(), resetTotals: vi.fn() }))
vi.mock('@main/window/windowRegistry.js', () => ({ windowIdFor: () => 'window', sendToWindow: vi.fn() }))

type Row = { tMs: number; layer: string; event: string; data?: Record<string, unknown> }
const recorded = JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../testing/fixtures/dictation/lifecycle-sessions-2026-09.json'), 'utf8')) as { sessions: Record<string, { rows: Row[] }> }
const row = (session: string, event: string) => recorded.sessions[session]!.rows.find(r => r.event === event)!

function invoke(name: string, params: unknown) {
  return mocks.handlers.get(`dictation:${name}`)!({ sender: {} }, params)
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.handlers.clear()
  mocks.journal = []
  mocks.key.mockResolvedValue('test-only-key')
  mocks.preview.start.mockReturnValue({ id: 'preview' })
  mocks.preview.stop.mockResolvedValue(null)
  mocks.append.mockResolvedValue(undefined)
  const module = await import('./dictation')
  module.registerDictationIpc({
    dictationDebugJournals: { get: () => ({ append: (entry: { layer: string; event: string; data?: Record<string, unknown> }) => mocks.journal.push(entry) }) },
    appRunJournal: { record: vi.fn() },
  } as never)
})
afterEach(() => { vi.useRealTimers() })

/** Start, send the recorded number of chunks, and stop with the recorded hold. */
async function replay(session: string) {
  const upload = row(session, 'batch:upload:start').data!
  const { id } = await invoke('stream-start', { provider: 'deepgram', debugSessionId: 'debug' })
  for (let i = 0; i < (upload.chunkCount as number); i++) await invoke('stream-chunk', { id, chunk: new ArrayBuffer(8) })
  return invoke('stream-stop', { id, audioDurationMs: row(session, 'stop:ipc-result').data!.audioDurationMs })
}
const outcome = () => mocks.journal.filter(entry => entry.layer === 'OUTCOME')

describe('dictation outcome codes in main (#243)', () => {
  it.each([
    ['provider-400', 'provider.bad-audio', 'Deepgram could not process this recording. Try again.'],
    ['network', 'network', 'Could not reach Deepgram. Check the network connection.'],
  ])('answers the recorded %s failure with its code', async (session, reason, sentence) => {
    const thrown = row(session, 'batch:upload:throw').data!
    mocks.batch.mockRejectedValue(Object.assign(new Error(thrown.message as string), {
      ...(thrown.status !== undefined ? { status: thrown.status } : {}),
      ...(thrown.details !== undefined ? { details: thrown.details } : {}),
    }))
    const result = await replay(session)
    expect(result).toMatchObject({ kind: 'error', reason })
    expect(outcome()).toEqual([expect.objectContaining({ event: 'error', data: expect.objectContaining({ code: reason }) })])
    const { dictationReasonMessage } = await import('@shared/types/dictation.js')
    expect(dictationReasonMessage(result.reason)).toBe(sentence)
  })

  it('answers a missing API key with config.missing-api-key', async () => {
    mocks.key.mockResolvedValue(null)
    expect(await invoke('stream-start', { provider: 'deepgram', debugSessionId: 'debug' }))
      .toMatchObject({ kind: 'error', reason: 'config.missing-api-key' })
  })

  // Final deadline: the recorded maximum batch is 14.3 s; one that hangs past
  // 30 s is aborted through the controller quit also uses.
  it('aborts a transcription that outlives the final deadline as final.timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mocks.batch.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))
    }))
    const stopping = replay('provider-400')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await stopping).toMatchObject({ kind: 'error', reason: 'final.timeout' })
    expect(outcome()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'final.timeout' }) })])
  })

  it('records a cancel as an IPC row, leaving the one OUTCOME row to the renderer', async () => {
    const { id } = await invoke('stream-start', { provider: 'deepgram', debugSessionId: 'debug' })
    await invoke('stream-cancel', { id })
    expect(outcome()).toEqual([])
    expect(mocks.journal).toContainEqual(expect.objectContaining({ layer: 'IPC', event: 'stream-cancel' }))
  })
})
