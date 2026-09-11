import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeHistoryIndex } from './claudeHistory.js'
import { installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('Claude history index', () => {
  it('indexes the recorded history by session and extends by appended bytes only', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const file = join(corpus.claudeConfigDir, 'history.jsonl')
    const index = new ClaudeHistoryIndex(file)
    await index.refresh()
    const counts = corpus.manifest.counts as { claude: { historyRecords: number } }
    let total = 0
    for (const id of index.sessionIds()) total += index.bySession(id).length
    expect(total).toBe(counts.claude.historyRecords)
    const [anyId] = [...index.sessionIds()]
    const before = index.bySession(anyId!).length
    // Growth: append one record; only that record must be folded, and the
    // session's prompts stay chronological.
    await appendFile(file, JSON.stringify({ display: 'p:appended:8', pastedContents: {}, timestamp: 1_800_000_000_000, project: '/fixture/repo', sessionId: anyId }) + '\n')
    await index.refresh()
    const after = index.bySession(anyId!)
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1]).toMatchObject({ text: 'p:appended:8', timestamp: 1_800_000_000_000 })
    expect(index.bytesReadForTests()).toBeLessThan(400)
  })

  it('rebuilds from scratch when the file shrinks and tolerates a partial last line', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const file = join(corpus.claudeConfigDir, 'history.jsonl')
    const index = new ClaudeHistoryIndex(file)
    await index.refresh()
    const original = await readFile(file, 'utf8')
    const lines = original.split('\n').filter(Boolean)
    await writeFile(file, lines.slice(0, 5).join('\n') + '\n' + '{"display":"trunc')
    await index.refresh()
    let total = 0
    for (const id of index.sessionIds()) total += index.bySession(id).length
    expect(total).toBe(5)
  })

  it('treats a missing file as empty, not as an error', async () => {
    const index = new ClaudeHistoryIndex('/nonexistent/history.jsonl')
    await expect(index.refresh()).resolves.toBeUndefined()
    expect([...index.sessionIds()]).toEqual([])
  })
})
