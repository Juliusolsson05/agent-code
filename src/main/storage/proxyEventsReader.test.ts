import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { canonicalizePath, sanitizePathSegment } from '@shared/runtime/projectDir.js'

// #1273: past claude-code-headless's body budget, request events carry
// `body_omitted` and the newest body lives in latest-request-body.json. The
// bundle must still carry a prompt, or the budget silently removes the one
// thing a bug report most needs (review of claude-code-headless#62).
const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-proxy-reader-')))
vi.mock('@main/storage/paths.js', () => ({ PROXY_EVENTS_DIR: root }))
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

// agent-code#372: the Codex mirror rotates a full file to
// proxy-events.1.jsonl. A bundle taken right after a rotation must still
// carry the recent traffic before it, from the END of the rotated file, on a
// clean line boundary, ahead of the current file.
it('fills the bundle from the rotated file after a rotation', async () => {
  // A recorded Codex 0.157 chunk line, as the mirror writes it.
  const recorded = JSON.parse(await readFile(join(import.meta.dirname,
    '../../../packages/codex-headless/testing/fixtures/proxy-mirror/models-chunk-2865.json'), 'utf8')) as { path: string; size: number; base64: string }
  const line = (n: number) => JSON.stringify({ kind: 'response-chunk', requestId: `req-${n}`, path: recorded.path, size: recorded.size, chunk: { _buffer_b64: recorded.base64 } })
  // Well over the 5 MiB bundle budget (1,600 × ~3.9 KB), so only its tail fits.
  const rotated = Array.from({ length: 1600 }, (_, i) => line(i + 1)).join('\n') + '\n'
  const current = `${JSON.stringify({ kind: 'mirror-rotated', rotations: 1 })}\n${line(1601)}\n`
  const cwd = await runDir('session-rotated', { 'proxy-events.1.jsonl': rotated, 'proxy-events.jsonl': current })
  const section = await readProxyEventsForBundle({ cwd, sessionKey: 'session-rotated' })
  const lines = (section.proxyEvents ?? '').trim().split('\n').map(text => JSON.parse(text) as { kind: string; requestId?: string; dropped_bytes?: number })
  expect(lines[0]).toMatchObject({ kind: 'truncated' })
  const ids = lines.filter(entry => entry.kind === 'response-chunk').map(entry => entry.requestId)
  // Contiguous and ending with the rotated file's last line, then the current file.
  expect(ids.at(-2)).toBe('req-1600')
  expect(ids.at(-1)).toBe('req-1601')
  const first = Number(ids[0]!.slice(4))
  expect(ids).toEqual(Array.from({ length: 1601 - first + 1 }, (_, i) => `req-${first + i}`))
  expect(lines.at(-2)).toMatchObject({ kind: 'mirror-rotated' })
  expect(Buffer.byteLength(section.proxyEvents ?? '')).toBeLessThanOrEqual(5 * 1024 * 1024 + 512)
})
