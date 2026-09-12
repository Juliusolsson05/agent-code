import { expect, it, vi } from 'vitest'
import { OpencodeStoreError, type OpencodeStore } from 'opencode-terminal-headless'
import { createOpencodeHistorySource } from './opencodeHistory.js'

const request = { cwd: '/w', providerSessionId: 'ses_test', limit: 5 }

it.each(['unsupported_schema', 'sqlite_unavailable', 'read_failed', 'open_failed', 'busy'] as const)(
  'preserves %s as a typed unavailable outcome', async code => {
    const error = new OpencodeStoreError(code, 'fixture failure')
    const store = vi.fn().mockRejectedValue(error)
    const source = createOpencodeHistorySource({ store, release: vi.fn() })
    await expect(source.loadHistoryChunk(request)).rejects.toMatchObject({ code: error.code, message: expect.stringContaining(error.code), cause: error })
    expect(store).toHaveBeenCalledTimes(code === 'busy' ? 3 : 1)
  },
)

it.each(['readHistory', 'countMessages'] as const)('propagates a %s failure after a successful open', async operation => {
  const error = new OpencodeStoreError('read_failed', 'fixture read failed')
  const handle = {
    readHistory: vi.fn(() => ({ records: [], hasOlder: false })),
    countMessages: vi.fn(() => 0),
  }
  handle[operation].mockImplementation(() => { throw error })
  const source = createOpencodeHistorySource({ store: async () => handle as unknown as OpencodeStore, release: vi.fn() })
  await expect(source.loadHistoryChunk(request)).rejects.toMatchObject({ code: error.code, message: expect.stringContaining(error.code), cause: error })
})
