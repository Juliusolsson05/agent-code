import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { readRange } from './shared.js'

describe('readRange', () => {
  it('does not advance through an incomplete trailing UTF-8 sequence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-subagent-range-'))
    try {
      const file = join(dir, 'agent.jsonl')
      const bytes = Buffer.from('{"message":"ok 😄"}\n', 'utf8')
      const splitAt = bytes.indexOf(Buffer.from('😄', 'utf8')) + 1
      await writeFile(file, bytes)

      const first = await readRange(file, 0, splitAt)
      expect(first.text).toBe('{"message":"ok ')
      expect(first.nextOffset).toBe(splitAt - 1)

      const second = await readRange(file, first.nextOffset, bytes.length)
      expect(second.text).toBe('😄"}\n')
      expect(second.nextOffset).toBe(bytes.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
