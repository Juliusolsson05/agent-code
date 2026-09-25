import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
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
