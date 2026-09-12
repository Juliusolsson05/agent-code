import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TLDR_HISTORY_LIMIT } from '@shared/types/tldr.js'
import { TldrStore } from './TldrStore.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup(options?: { maxHistoryFiles?: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-history-'))
  directories.push(directory)
  return { directory, store: new TldrStore(join(directory, 'tldr.json'), undefined, options) }
}
const allow = () => true

describe('TLDR history', () => {
  it('keeps the newest entries first, skips an unchanged repeat, and stays bounded', async () => {
    const { store } = await setup()
    await store.update('agent-a', 'Goal: add history.', allow)
    await store.update('agent-a', 'Store is done; building the modal.', allow)
    // Re-posting an unchanged status is not a new moment in the task.
    await store.update('agent-a', 'Store is done; building the modal.', allow)
    await store.update('agent-a', 'Complete. PR #1 is open.', allow)
    const history = await store.history('agent-a')
    expect(history.map(entry => entry.text)).toEqual([
      'Complete. PR #1 is open.', 'Store is done; building the modal.', 'Goal: add history.',
    ])
    expect(history.map(entry => entry.revision)).toEqual([4, 2, 1])

    for (let index = 0; index < TLDR_HISTORY_LIMIT + 5; index += 1) await store.update('agent-b', `Step ${index}.`, allow)
    const bounded = await store.history('agent-b')
    expect(bounded).toHaveLength(TLDR_HISTORY_LIMIT)
    expect(bounded[0]!.text).toBe(`Step ${TLDR_HISTORY_LIMIT + 4}.`)
    expect(bounded.at(-1)!.text).toBe('Step 5.')
  })

  it('reports the last write time and recovers from a corrupt history file without failing the report', async () => {
    const { directory, store } = await setup()
    expect(await store.lastWrittenAt('agent-a')).toBeUndefined()
    const first = await store.update('agent-a', 'First report.', allow)
    expect(await store.lastWrittenAt('agent-a')).toBe(first.updatedAt)

    const historyFile = join(directory, 'tldr-history', `${createHash('sha256').update('agent-a').digest('hex')}.json`)
    await writeFile(historyFile, '{ not json')
    await expect(store.history('agent-a')).rejects.toThrow()
    // The current report is the acknowledged truth; a broken secondary view
    // must not make the agent's tool call fail and be retried.
    await expect(store.update('agent-a', 'Second report.', allow)).resolves.toMatchObject({ text: 'Second report.' })
    expect((await store.history('agent-a')).map(entry => entry.text)).toEqual(['Second report.'])
  })

  it('evicts the least recently written histories beyond the file cap', async () => {
    const { store } = await setup({ maxHistoryFiles: 2 })
    for (const identity of ['agent-a', 'agent-b', 'agent-c']) {
      await store.update(identity, `${identity} report.`, allow)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(await store.history('agent-a')).toEqual([])
    expect(await store.history('agent-c')).toHaveLength(1)
    // The current record is never evicted with its history.
    expect(await store.lastWrittenAt('agent-a')).toEqual(expect.any(String))
  })
})
