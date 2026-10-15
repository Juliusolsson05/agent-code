import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { HermesPromptError } from 'hermes-headless'

import { createHermesClientLog, errorFields } from '@main/hermes/clientLog.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-client-log-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Hermes client log (#1527)', () => {
  it('writes UTC lines that line up with the server log, and never the message text', async () => {
    const dir = await tempDir()
    const log = createHermesClientLog({ dir, now: () => new Date('2026-10-15T15:51:08.000Z') })
    log.write({ connectionId: 'c1', conversation: '20260821_224701_cfacfa4e', event: 'hold-failed', text: 'the user\'s private words', textLength: 24, requestId: 'hh6', code: 4001 })
    await log.flush()
    const [line] = (await readFile(join(dir, 'client.jsonl'), 'utf8')).trim().split('\n')
    const parsed = JSON.parse(line!)
    expect(parsed).toEqual({ t: '2026-10-15T15:51:08.000Z', connectionId: 'c1', conversation: '20260821_224701_cfacfa4e', event: 'hold-failed', textLength: 24, requestId: 'hh6', code: 4001 })
  })

  it('rotates once at the cap, keeping the previous file and bounding disk use', async () => {
    const dir = await tempDir()
    const log = createHermesClientLog({ dir, maxBytes: 400 })
    for (let index = 0; index < 30; index += 1) log.write({ connectionId: 'c1', event: `e${index}`, pad: 'x'.repeat(40) })
    await log.flush()
    const current = await stat(join(dir, 'client.jsonl'))
    const previous = await stat(join(dir, 'client.1.jsonl'))
    expect(current.size).toBeLessThanOrEqual(400)
    expect(previous.size).toBeLessThanOrEqual(400)
    // The newest line is in the current file: rotation never loses the latest event.
    expect(await readFile(join(dir, 'client.jsonl'), 'utf8')).toContain('"event":"e29"')
  })

  it('reduces a refused Hermes prompt to the fields that match the server line', () => {
    expect(errorFields(new HermesPromptError('refused', 'session not found', 4001, 'hh6'))).toEqual({
      error: 'session not found',
      errorName: 'HermesPromptError',
      code: 4001,
      kind: 'refused',
      requestId: 'hh6',
    })
  })
})
