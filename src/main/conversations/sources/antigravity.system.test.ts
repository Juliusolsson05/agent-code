import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AntigravityRow } from 'antigravity-acp-headless'

import { registerAntigravityHistory } from '@providers/antigravity/runtime/antigravityHistory.js'
import { resolveFamily } from '../family.js'
import { AntigravityConversationSource } from './antigravity.js'
import { ConversationPromptsUnreadable } from './types.js'

// The Antigravity conversation source. The catalog asks agy itself (ACP
// session/list in a short-lived `agy acp`), so discovery is exercised against
// a stand-in EXECUTABLE that the source really spawns: a shell wrapper around
// a Node script that speaks newline-delimited JSON-RPC with the session/list
// shape recorded from agy 1.5.15 (cursor paging, ACP sessions with a
// percent-encoded cwd, TUI sessions with a plain one). The real `agy` binary
// is never run; the binary seam is the source's own `deps.binary`.

const dirs: string[] = []
const unregister: Array<() => void> = []
afterEach(() => {
  for (const drop of unregister.splice(0)) drop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'antigravity-source-'))
  dirs.push(dir)
  return dir
}

/** Write a fake `agy` that answers initialize and pages session/list. */
function fakeAgy(dir: string, pages: Array<Array<Record<string, unknown>>>): { binary: string; methods: () => string[] } {
  const log = join(dir, 'frames.log')
  const script = join(dir, 'fake-agy.mjs')
  writeFileSync(script, `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const pages = ${JSON.stringify(pages)}
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: frame.method, params: frame.params }) + '\\n')
  if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
  if (frame.method === 'session/list') {
    const index = frame.params && frame.params.cursor ? Number(frame.params.cursor) : 0
    send({ id: frame.id, result: { sessions: pages[index], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) } })
  }
})
`)
  const binary = join(dir, 'agy')
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(binary, 0o755)
  return {
    binary,
    methods: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: { cursor?: string } }).map(frame => `${frame.method}${frame.params?.cursor ? `#${frame.params.cursor}` : ''}`),
  }
}

describe('Antigravity conversation source discover', () => {
  it('lists every session agy reports across session/list pages, scoped to the repository family', async () => {
    const home = sandbox()
    const repo = join(home, 'Application Support', 'repo')
    const elsewhere = join(home, 'elsewhere')
    const agy = fakeAgy(home, [
      [
        // Created over ACP: agy reports the cwd percent-encoded.
        { sessionId: 'acp-session', cwd: repo.replace(/ /g, '%20'), title: '  Fix the build  ', updatedAt: '2026-11-20T10:00:00.000Z' },
        { sessionId: 'other-project', cwd: elsewhere, title: 'Elsewhere', updatedAt: '2026-11-21T10:00:00.000Z' },
      ],
      [
        // Created in agy's TUI: plain cwd, no title yet, no timestamp.
        { sessionId: 'tui-session', cwd: join(repo, 'packages', 'web') },
        { cwd: repo, title: 'no id: skipped' },
      ],
    ])
    const source = new AntigravityConversationSource({ binary: () => agy.binary })

    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily(repo, 'everywhere', { listWorktrees: async () => [] }) })
    expect(agy.methods()).toEqual(['initialize', 'session/list', 'session/list#1'])
    expect(everywhere.map(row => row.nativeId)).toEqual(['acp-session', 'other-project', 'tui-session'])

    const byId = new Map(everywhere.map(row => [row.nativeId, row]))
    expect(byId.get('acp-session')).toMatchObject({
      provider: 'antigravity',
      cwd: repo,
      aiTitle: 'Fix the build',
      customTitle: null,
      lastUserActivityAt: Date.parse('2026-11-20T10:00:00.000Z'),
      mtime: Date.parse('2026-11-20T10:00:00.000Z'),
      activitySource: 'index',
      origin: 'index',
      available: true,
      file: null,
      userTexts: [],
    })
    expect(byId.get('tui-session')).toMatchObject({ cwd: join(repo, 'packages', 'web'), aiTitle: null, lastUserActivityAt: 0, mtime: 0 })

    const scoped = await source.discover({ scope: 'repository', family: await resolveFamily(repo, 'repository', { listWorktrees: async () => [] }) })
    expect(scoped.map(row => row.nativeId)).toEqual(['acp-session', 'tui-session'])
  })

  it('a missing agy lists nothing instead of failing the catalog', async () => {
    const source = new AntigravityConversationSource({ binary: () => join(sandbox(), 'not-installed', 'agy') })
    const family = await resolveFamily(process.cwd(), 'everywhere', { listWorktrees: async () => [] })
    expect(await source.discover({ scope: 'everywhere', family })).toEqual([])
  })
})

describe('Antigravity conversation source prompts', () => {
  const row = (ordinal: number, role: AntigravityRow['role'], text: string): AntigravityRow => ({
    type: 'antigravity-row',
    sessionId: 'live-conv',
    key: `ag:live-conv:${ordinal}`,
    ordinal,
    role,
    text,
    timestamp: 1_763_000_000_000 + ordinal,
  })

  it('a live pane answers from its rows, newest first, user prompts only, without starting agy', async () => {
    unregister.push(registerAntigravityHistory('live-conv', {
      rows: () => [row(0, 'user', 'first prompt'), row(1, 'assistant', 'answer'), row(2, 'thought', 'hmm'), row(3, 'user', '   '), row(4, 'user', 'second prompt')],
    }))
    const source = new AntigravityConversationSource({
      binary: () => {
        throw new Error('a live conversation must not start agy')
      },
    })
    expect(await source.prompts('live-conv', '/work')).toEqual([
      { text: 'second prompt', timestamp: 1_763_000_000_004 },
      { text: 'first prompt', timestamp: 1_763_000_000_000 },
    ])
  })

  it('a conversation agy cannot replay (agy missing) is unreadable, not "no prompts"', async () => {
    const source = new AntigravityConversationSource({ binary: () => join(sandbox(), 'not-installed', 'agy') })
    await expect(source.prompts('closed-conv', process.cwd())).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
  })
})
