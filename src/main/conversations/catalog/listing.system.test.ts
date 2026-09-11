import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { conversationKey } from '@shared/conversations/types.js'
import { resolveFamily } from '../family.js'
import type { RepositoryFamily } from '../family.js'
import { ClaudeHistoryIndex } from '../sources/claudeHistory.js'
import { ClaudeConversationSource } from '../sources/claude.js'
import { CodexConversationSource } from '../sources/codex.js'
import { OpencodeConversationSource } from '../sources/opencode.js'
import type { SourceConversation } from '../sources/types.js'
import { buildListing } from './listing.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

// WHY one corpus per file: installing the corpus and discovering 1,400
// conversations costs seconds, and buildListing is pure, so every test reads
// the same discovered sources without mutating them.
const cleanups: Array<() => Promise<void>> = []
let shared: Corpus
beforeAll(async () => { shared = await loadCorpus() })
afterAll(async () => { for (const c of cleanups.splice(0)) await c() })

type Expectations = { kinds: Record<string, string>; labelSources: Record<string, string>; defaultOrderTop: string[] }

type Corpus = {
  all: SourceConversation[]
  family: RepositoryFamily
  history: ClaudeHistoryIndex
  expectations: Expectations
}

async function loadCorpus(): Promise<Corpus> {
  const corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => worktrees })
  const history = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
  const sources = [
    new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history }),
    new CodexConversationSource({ codexHome: corpus.codexHome }),
    new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir, listPrompts: async () => [] }),
  ]
  const all = (await Promise.all(sources.map(s => s.discover({ scope: 'repository', family })))).flat()
  const expectations = JSON.parse(await readFile('testing/fixtures/conversations/expectations.json', 'utf8')) as Expectations
  return { all, family, history, expectations }
}

describe('buildListing over the recorded corpus', () => {
  it('drops nothing and duplicates nothing: rows plus hidden children equal the sources', async () => {
    const { all, family } = shared
    const response = buildListing({ sources: all, ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'repository', includeChildren: false, limit: 10_000 }, startedAt: Date.now() })
    expect(new Set(all.map(s => conversationKey(s.provider, s.nativeId))).size).toBe(all.length)
    expect(response.total).toBe(all.length)
    expect(response.rows.length + response.hiddenChildren).toBe(response.total)
    expect(response.hiddenChildren).toBeGreaterThan(0)
    expect(response.rows.every(r => r.kind === 'user' || r.kind === 'projected')).toBe(true)
  })

  it('reproduces the user-authored kinds, label sources and default order', async () => {
    const { all, family, expectations } = shared
    const everything = buildListing({ sources: all, ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'repository', includeChildren: true, limit: 10_000 }, startedAt: Date.now() })
    const byKey = new Map(everything.rows.map(r => [conversationKey(r.provider, r.nativeId), r]))
    const kindMismatches: string[] = []
    const labelMismatches: string[] = []
    for (const [key, kind] of Object.entries(expectations.kinds)) {
      const row = byKey.get(key)
      if (!row) { kindMismatches.push(`${key}: missing`); continue }
      if (row.kind !== kind) kindMismatches.push(`${key}: ${row.kind} != ${kind}`)
      const expectedSource = expectations.labelSources[key]
      if (expectedSource && row.labelSource !== expectedSource) labelMismatches.push(`${key}: ${row.labelSource} != ${expectedSource}`)
    }
    expect(kindMismatches).toEqual([])
    expect(labelMismatches).toEqual([])
    const shown = everything.rows.filter(r => r.kind === 'user' || r.kind === 'projected').map(r => conversationKey(r.provider, r.nativeId))
    expect(shown.slice(0, expectations.defaultOrderTop.length)).toEqual(expectations.defaultOrderTop)
  })

  it('never falls back to mtime for an indexed provider and marks fallback labels', async () => {
    const { all, family } = shared
    const response = buildListing({ sources: all, ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'repository', includeChildren: true, limit: 10_000 }, startedAt: Date.now() })
    for (const row of response.rows) {
      // An unindexed rollout found by the scan may hold no user event in its
      // head; only rows the INDEX served must never fall back to mtime.
      if (row.origin === 'index') expect(row.activitySource, `${row.provider}:${row.nativeId}`).not.toBe('mtime')
      if (row.labelSource === 'cwd' || row.labelSource === 'native-id') expect(row.firstPrompt).toBeNull()
      expect(row.label.length).toBeGreaterThan(0)
    }
  })

  it('pages with a stable cursor and hides children per page', async () => {
    const { all, family } = shared
    const request = { cwd: '/fixture/repo', scope: 'repository' as const, includeChildren: false, limit: 5 }
    const first = buildListing({ sources: all, ledger: new Map(), family, request, startedAt: Date.now() })
    expect(first.rows).toHaveLength(5)
    expect(first.nextCursor).not.toBeNull()
    const second = buildListing({ sources: all, ledger: new Map(), family, request: { ...request, cursor: first.nextCursor }, startedAt: Date.now() })
    expect(second.rows[0]!.lastUserActivityAt).toBeLessThanOrEqual(first.rows[4]!.lastUserActivityAt)
    expect(new Set([...first.rows, ...second.rows].map(r => r.nativeId)).size).toBe(10)
  })

  it('searches labels and Claude history prompts with a match span', async () => {
    const { all, family, history } = shared
    // A session with history whose transcript is in the family: the corpus
    // history slice is built from exactly those sessions.
    const anyId = [...history.sessionIds()].find(id => all.some(s => s.provider === 'claude' && s.nativeId === id))!
    const needle = history.bySession(anyId)[0]!.text.slice(0, 12)
    const none = buildListing({ sources: [], ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'repository', query: needle, limit: 30 }, startedAt: Date.now() })
    expect(none.rows).toEqual([])
    const searched = buildListing({
      sources: all, ledger: new Map(), family,
      request: { cwd: '/fixture/repo', scope: 'repository', query: needle, includeChildren: true, limit: 30 },
      promptsFor: row => row.provider === 'claude' ? history.bySession(row.nativeId).map(p => p.text) : [],
      startedAt: Date.now(),
    })
    const hit = searched.rows.find(r => r.nativeId === anyId)
    expect(hit?.match).toMatchObject({ start: expect.any(Number), end: expect.any(Number) })
    expect(searched.rows.every(r => r.match !== null)).toBe(true)
  })

  it('applies provider and scope filters', async () => {
    const { all } = shared
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees: async () => [] })
    const codexOnly = buildListing({ sources: all, ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'cwd', providers: ['codex'], includeChildren: true, limit: 10_000 }, startedAt: Date.now() })
    expect(codexOnly.rows.length).toBeGreaterThan(0)
    expect(codexOnly.rows.every(r => r.provider === 'codex')).toBe(true)
    expect(codexOnly.family.repoRoot).toBe('/fixture/repo')
  })
})
