import { describe, expect, it } from 'vitest'

import {
  exportDebugTraceFiles,
  forgetDebugTrace,
  recordHtmlTraceSnapshot,
} from './renderTrace'

function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(13, '0')
}

function readJsonl<T>(files: { name: string; content: string }[], name: string): T[] {
  const file = files.find(item => item.name === name)
  if (!file) throw new Error(`Missing trace file ${name}`)
  return file.content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

describe('renderTrace', () => {
  it('keeps real checkpoint content when pruning long HTML traces', () => {
    const sessionId = `trace-prune-${crypto.randomUUID()}`
    try {
      for (let i = 0; i < 205; i++) {
        recordHtmlTraceSnapshot(
          sessionId,
          `<section class="pane"><p>snapshot ${i}</p></section>`,
          'mutation',
        )
      }

      const files = exportDebugTraceFiles(sessionId)
      const checkpoints = readJsonl<{ hash: string; content: string }>(
        files,
        'trace/html/checkpoints.jsonl',
      )

      // Regression guard for the old prune path: it promoted a non-checkpoint
      // commit and filled the checkpoint body with the latest HTML, producing a
      // hash/content mismatch that made replay artifacts look valid while they
      // described the wrong DOM.
      expect(checkpoints.length).toBeGreaterThan(0)
      for (const checkpoint of checkpoints) {
        expect(hashText(checkpoint.content)).toBe(checkpoint.hash)
      }
    } finally {
      forgetDebugTrace(sessionId)
    }
  })

  it('forgets a closed session trace', () => {
    const sessionId = `trace-forget-${crypto.randomUUID()}`
    recordHtmlTraceSnapshot(sessionId, '<section><p>hello</p></section>', 'manual')
    expect(exportDebugTraceFiles(sessionId).length).toBeGreaterThan(0)

    forgetDebugTrace(sessionId)

    expect(exportDebugTraceFiles(sessionId)).toEqual([])
  })
})
