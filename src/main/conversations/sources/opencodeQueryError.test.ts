import { describe, expect, it, vi } from 'vitest'

// #1434 verification a: a SQLite failure AFTER a successful open (a damaged
// page past the schema probe, a lock taken mid-query) must reach the source
// contract typed, not raw. A real database that fails only at that step is not
// reliably manufacturable, so the sqlite boundary answers "opened" with a
// statement that throws — the one thing replaced.
vi.mock('./sqlite.js', () => ({
  openReadOnlySqlite: () => ({
    ok: true,
    db: { prepare: () => ({ all: () => { throw new Error('database disk image is malformed') } }) },
    close: () => undefined,
  }),
}))

import { OpencodeConversationSource } from './opencode.js'
import { ConversationPromptsUnreadable } from './types.js'

describe('OpenCode prompts when the query fails after the open', () => {
  it('is typed as unreadable, never a raw SQLite error', async () => {
    await expect(new OpencodeConversationSource({ dataDir: '/tmp/unused' }).prompts('ses_x', '/fixture/repo')).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
  })
})
