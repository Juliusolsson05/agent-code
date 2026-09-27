import { link, mkdir, mkdtemp, readFile, realpath, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { canonicalizePath, sanitizePathSegment } from '@shared/runtime/projectDir.js'

// #1273: past claude-code-headless's body budget, request events carry
// `body_omitted` and the newest body lives in latest-request-body.json. The
// bundle must still carry a prompt, or the budget silently removes the one
// thing a bug report most needs (review of claude-code-headless#62).
const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-proxy-reader-')))
vi.mock('@main/storage/paths.js', () => ({ PROXY_EVENTS_DIR: root }))
// A hook that runs right after the run selection stats a live events file, so
// a test can rotate the file between selection and read (steering q54).
let afterSelectionStat: (() => Promise<void>) | null = null
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const stats = await actual.stat(...args)
      if (afterSelectionStat && String(args[0]).endsWith('/proxy-events.jsonl')) {
        const hook = afterSelectionStat
        afterSelectionStat = null
        await hook()
      }
      return stats
    },
    // A hook that runs right after the reader fstats an opened handle, so a
    // test can change the file between that fstat and the read.
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (afterLiveOpen && String(args[0]).endsWith('/proxy-events.jsonl')) {
        const hook = afterLiveOpen
        afterLiveOpen = null
        await hook()
      }
      const statHandle = handle.stat.bind(handle)
      handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
        const stats = await statHandle(...statArgs)
        if (afterHandleStat && String(args[0]).endsWith('/proxy-events.jsonl')) {
          const hook = afterHandleStat
          afterHandleStat = null
          await hook()
        }
        return stats
      }) as typeof handle.stat
      return handle
    },
  }
})
let afterHandleStat: (() => Promise<void>) | null = null
// Runs right after the reader opens the live file, before it sizes or reads
// it: a rotation landing between the reader's two opens.
let afterLiveOpen: (() => Promise<void>) | null = null
const { readProxyEventsForBundle } = await import('./proxyEventsReader.js')

async function runDir(sessionKey: string, files: Record<string, string>): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ac-proxy-cwd-')))
  const dir = join(root, sanitizePathSegment(await canonicalizePath(cwd)), sanitizePathSegment(sessionKey), 'run-1')
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return cwd
}

it('appends the newest kept request body after the events tail', async () => {
  const request = JSON.stringify({ kind: 'request', flow_id: 7, body_omitted: 'file-budget' })
  const latest = JSON.stringify({ kind: 'request-body-latest', flow_id: 7, body_b64: Buffer.from('{"messages":[]}').toString('base64') })
  const cwd = await runDir('session-a', { 'proxy-events.jsonl': `${request}\n`, 'latest-request-body.json': `${latest}\n` })
  const section = await readProxyEventsForBundle({ cwd, sessionKey: 'session-a' })
  const lines = section.proxyEvents?.trim().split('\n') ?? []
  expect(lines).toEqual([request, latest])
})

it('is unchanged for a run that never passed its budget', async () => {
  const request = JSON.stringify({ kind: 'request', flow_id: 1, body_b64: 'e30=' })
  const cwd = await runDir('session-b', { 'proxy-events.jsonl': `${request}\n` })
  const section = await readProxyEventsForBundle({ cwd, sessionKey: 'session-b' })
  expect(section.proxyEvents).toBe(`${request}\n`)
})

// ── Reading across a rotation (#372 Codex, #1273 Claude; steering q54) ──
//
// Both writers rotate proxy-events.jsonl to proxy-events.1.jsonl while this
// reader may be running. Lines are REAL ones: the Codex mirror's recorded
// 0.157 chunk and a recorded Claude addon chunk.
const codexChunk = JSON.parse(await readFile(join(import.meta.dirname,
  '../../../packages/codex-headless/testing/fixtures/proxy-mirror/models-chunk-2865.json'), 'utf8')) as { path: string; size: number; base64: string }
const claudeLine = (JSON.parse(await readFile(join(import.meta.dirname,
  '../../../testing/fixtures/proxy-events-reader/claude-response-chunk.json'), 'utf8')) as { line: string }).line
const PROVIDERS = {
  codex: (n: number) => JSON.stringify({ kind: 'response-chunk', requestId: `req-${n}`, path: codexChunk.path, size: codexChunk.size, chunk: { _buffer_b64: codexChunk.base64 } }),
  claude: (n: number) => JSON.stringify({ ...(JSON.parse(claudeLine) as object), flow_id: n }),
} as const
const idOf = (line: Record<string, unknown>) => Number(String(line.requestId ?? line.flow_id).replace('req-', ''))
const BUDGET = 5 * 1024 * 1024
// Enough lines that one generation alone is well over the 5 MiB budget.
const OVER_BUDGET = { codex: 1600, claude: 20000 } as const

async function runWith(provider: keyof typeof PROVIDERS, files: { rotated?: [number, number]; live?: [number, number] }) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ac-proxy-cwd-')))
  const sessionKey = `${provider}-${Math.random().toString(36).slice(2)}`
  const dir = join(root, sanitizePathSegment(await canonicalizePath(cwd)), sanitizePathSegment(sessionKey), 'run-1')
  await mkdir(dir, { recursive: true })
  const range = ([from, to]: [number, number]) => Array.from({ length: to - from + 1 }, (_, i) => PROVIDERS[provider](from + i) + '\n').join('')
  if (files.rotated) await writeFile(join(dir, 'proxy-events.1.jsonl'), range(files.rotated))
  await writeFile(join(dir, 'proxy-events.jsonl'), files.live ? range(files.live) : '')
  return { cwd, sessionKey, dir }
}

async function bundle(run: { cwd: string; sessionKey: string }) {
  const section = await readProxyEventsForBundle({ cwd: run.cwd, sessionKey: run.sessionKey })
  const text = section.proxyEvents ?? ''
  // Never NUL padding, always whole JSONL lines, never over the budget
  // (plus the one header line).
  expect(text.includes('\u0000')).toBe(false)
  const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const events = lines.filter(line => line.kind !== 'truncated')
  expect(Buffer.byteLength(text) - (lines[0]?.kind === 'truncated' ? Buffer.byteLength(JSON.stringify(lines[0])) + 1 : 0)).toBeLessThanOrEqual(BUDGET)
  return { lines, ids: events.map(idOf) }
}
const contiguousTo = (ids: number[], last: number) =>
  expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => last - ids.length + 1 + i))

for (const provider of ['codex', 'claude'] as const) {
  describe(`${provider} events across a rotation`, () => {
    const over = OVER_BUDGET[provider]

    it('fills the 5 MiB budget from the end of .1, then the live file, contiguous', async () => {
      const run = await runWith(provider, { rotated: [1, over], live: [over + 1, over + 3] })
      const { lines, ids } = await bundle(run)
      expect(lines[0]).toMatchObject({ kind: 'truncated' })
      contiguousTo(ids, over + 3)
      expect(ids.length).toBeGreaterThan(3)
    })

    it('takes the whole of both generations when they fit, with no header', async () => {
      const run = await runWith(provider, { rotated: [1, 5], live: [6, 8] })
      const { lines, ids } = await bundle(run)
      expect(lines[0]?.kind).not.toBe('truncated')
      expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })

    it('reads only the live tail when the live file alone passes the budget', async () => {
      const run = await runWith(provider, { rotated: [1, 10], live: [11, over + 10] })
      const { lines, ids } = await bundle(run)
      expect(lines[0]).toMatchObject({ kind: 'truncated' })
      contiguousTo(ids, over + 10)
      expect(ids[0]).toBeGreaterThan(11)
    })

    // The run was selected (and sized) on the old inode; then the writer
    // rotated: the old file is .1 and the path is a new, empty file.
    it('reads the rotated generation when the file rotates between selection and read', async () => {
      const run = await runWith(provider, { live: [1, over] })
      afterSelectionStat = async () => {
        await rename(join(run.dir, 'proxy-events.jsonl'), join(run.dir, 'proxy-events.1.jsonl'))
        await writeFile(join(run.dir, 'proxy-events.jsonl'), PROVIDERS[provider](over + 1) + '\n')
      }
      const { lines, ids } = await bundle(run)
      expect(afterSelectionStat).toBeNull()
      expect(lines[0]).toMatchObject({ kind: 'truncated' })
      contiguousTo(ids, over + 1)
    })

    // A saved size larger than the file actually opened (the new, smaller
    // generation): a fixed-size read of the saved size padded with NULs.
    it('never pads when the file opened is smaller than the selection saw', async () => {
      const run = await runWith(provider, { live: [1, over] })
      afterSelectionStat = async () => {
        await rename(join(run.dir, 'proxy-events.jsonl'), join(run.dir, 'proxy-events.1.jsonl'))
        await writeFile(join(run.dir, 'proxy-events.jsonl'), '')
      }
      const { ids } = await bundle(run)
      contiguousTo(ids, over)
    })

    // The rotation landed between the reader's two opens: .1 is the very
    // file already read as live. Its lines must not appear twice.
    it('does not duplicate lines when .1 is the same file as the live one', async () => {
      const run = await runWith(provider, { live: [1, 4] })
      await link(join(run.dir, 'proxy-events.jsonl'), join(run.dir, 'proxy-events.1.jsonl'))
      const { lines, ids } = await bundle(run)
      expect(ids).toEqual([1, 2, 3, 4])
      // Every retry sees the same collision, so after the last attempt the
      // bundle must SAY older traffic was lost rather than look complete
      // (#1332 round-2 review A: that path was unpinned).
      expect(lines[0]).toMatchObject({ kind: 'truncated' })
      expect(String(lines[0]!.reason)).toContain('rotated away during the read')
    })

    // The live tail was cut, so `.1` is not adjacent to it: even when the cut
    // leaves room (here a large unfinished last line is dropped), filling it
    // from `.1` would splice older lines onto a gap.
    it('never fills from .1 when the live tail was already cut', async () => {
      const run = await runWith(provider, { rotated: [1, 10], live: [11, over + 10] })
      await writeFile(join(run.dir, 'proxy-events.jsonl'), PROVIDERS[provider](over + 11).repeat(4), { flag: 'a' })
      const { ids } = await bundle(run)
      contiguousTo(ids, over + 10)
    })

    // The file shrinks after the reader sized its handle (a truncation): the
    // read returns fewer bytes than asked, and the rest must not become NULs.
    it('uses only the bytes actually read when the file shrinks under the handle', async () => {
      const run = await runWith(provider, { live: [1, 4] })
      const keep = [1, 2].map(n => PROVIDERS[provider](n) + '\n').join('')
      afterHandleStat = async () => { await truncate(join(run.dir, 'proxy-events.jsonl'), Buffer.byteLength(keep)) }
      const { ids } = await bundle(run)
      expect(afterHandleStat).toBeNull()
      expect(ids).toEqual([1, 2])
    })

    // #1332 review A1/B1/C2: the writer renamed live to `.1` and has not
    // created the next file yet. The run is still found, from `.1`.
    it('finds a run whose live file is missing mid-rotation', async () => {
      const run = await runWith(provider, { rotated: [1, 4] })
      await unlink(join(run.dir, 'proxy-events.jsonl'))
      const section = await readProxyEventsForBundle({ cwd: run.cwd, sessionKey: run.sessionKey })
      expect(section.match).toBe('exact')
      expect(section.runDir).toBe(run.dir)
      const { ids } = await bundle(run)
      expect(ids).toEqual([1, 2, 3, 4])
    })

    // #1332 review A2 and B3: the writer rotates right after the reader
    // opened the live file. Read once, both handles would be that file (now
    // `.1`), the previous generation would be gone, and the bundle would look
    // complete. The reader tries again and gets the consistent pair.
    it('reads a consistent pair when the file rotates between the two opens', async () => {
      const run = await runWith(provider, { rotated: [1, 3], live: [4, 6] })
      afterLiveOpen = async () => {
        await rename(join(run.dir, 'proxy-events.jsonl'), join(run.dir, 'proxy-events.1.jsonl'))
        await writeFile(join(run.dir, 'proxy-events.jsonl'), PROVIDERS[provider](7) + '\n')
      }
      const { lines, ids } = await bundle(run)
      expect(afterLiveOpen).toBeNull()
      expect(lines[0]?.kind).not.toBe('truncated')
      expect(ids).toEqual([4, 5, 6, 7])
    })

    // #1332 review C3: an unfinished LAST line of the live file does not
    // break its adjacency to `.1`.
    it('still fills from .1 when the live file ends in an unfinished line', async () => {
      const run = await runWith(provider, { rotated: [1, 4], live: [5, 6] })
      const partial = PROVIDERS[provider](7).slice(0, 40)
      await writeFile(join(run.dir, 'proxy-events.jsonl'), partial, { flag: 'a' })
      const { lines, ids } = await bundle(run)
      expect(ids).toEqual([1, 2, 3, 4, 5, 6])
      expect(lines[0]).toMatchObject({ kind: 'truncated', dropped_bytes: Buffer.byteLength(partial) })
    })

    // #1332 review A5: dropped_bytes counts BYTES. A non-ASCII unfinished
    // line (the recorded proxy message shape) would be undercounted in UTF-16
    // units. And a `.1` left out entirely is counted whole.
    it('counts dropped bytes exactly, in bytes', async () => {
      const partial = '{"kind":"response-error","message":"upstream said: överbelastad ✗'
      const small = await runWith(provider, { live: [1, 2] })
      // A kept line with non-ASCII text too, so a UTF-16 count of the kept
      // text would come out wrong.
      await writeFile(join(small.dir, 'proxy-events.jsonl'), '{"kind":"response-error","requestId":"req-3","message":"upstream said: överbelastad ✗"}\n' + partial, { flag: 'a' })
      expect((await bundle(small)).lines[0]).toMatchObject({ kind: 'truncated', dropped_bytes: Buffer.byteLength(partial) })

      const big = await runWith(provider, { rotated: [1, 10], live: [11, over + 10] })
      const { lines, ids } = await bundle(big)
      const liveSize = (await stat(join(big.dir, 'proxy-events.jsonl'))).size
      const rotatedSize = (await stat(join(big.dir, 'proxy-events.1.jsonl'))).size
      const kept = ids.map(id => Buffer.byteLength(PROVIDERS[provider](id) + '\n')).reduce((a, b) => a + b, 0)
      expect(lines[0]).toMatchObject({ dropped_bytes: liveSize - kept + rotatedSize })
      expect(String(lines[0]!.reason)).toContain('proxy-events.1.jsonl + ')
    })

    // #1332 review B2: a selected run that vanished before it could be read
    // is no payload, not an `exact` match with nothing in it.
    it('reports no match when the selected run vanishes before the read', async () => {
      const run = await runWith(provider, { live: [1, 2] })
      afterSelectionStat = async () => { await unlink(join(run.dir, 'proxy-events.jsonl')) }
      const section = await readProxyEventsForBundle({ cwd: run.cwd, sessionKey: run.sessionKey })
      expect(afterSelectionStat).toBeNull()
      expect(section).toMatchObject({ proxyEvents: null, match: 'none', runDir: null })
    })

    // #1332 review C: the bundle keeps its locators, the run dir and the
    // run's session-meta.json, alongside the rotated read.
    it('keeps the run dir and session meta with a rotated read', async () => {
      const run = await runWith(provider, { rotated: [1, 2], live: [3, 3] })
      const meta = JSON.stringify({ cwd: run.cwd, sessionKey: run.sessionKey })
      await writeFile(join(run.dir, 'session-meta.json'), meta)
      const section = await readProxyEventsForBundle({ cwd: run.cwd, sessionKey: run.sessionKey })
      expect(section.runDir).toBe(run.dir)
      expect(section.sessionMeta).toBe(meta)
    })

    it('drops a trailing line the writer has not finished', async () => {
      const run = await runWith(provider, { live: [1, 2] })
      await writeFile(join(run.dir, 'proxy-events.jsonl'), PROVIDERS[provider](3).slice(0, 40), { flag: 'a' })
      const { ids } = await bundle(run)
      expect(ids).toEqual([1, 2])
    })
  })
}
