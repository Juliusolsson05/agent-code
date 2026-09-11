import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveFamily } from '../family.js'
import { CodexConversationSource } from './codex.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

async function setup() {
  const corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  const listWorktrees = async () => worktrees
  const source = new CodexConversationSource({ codexHome: corpus.codexHome })
  return { corpus, source, listWorktrees }
}

describe('Codex conversation source', () => {
  it('lists every family thread from the index with kinds, parents and activity, and none from the control set', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const counts = corpus.manifest.counts as { codex: { inFamily: number; control: number; exec: number; subagents: number; orchestrationChildren: number; sampledRollouts: number; unindexedSampled: number } }
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const rows = await source.discover({ scope: 'repository', family })
    const indexed = rows.filter(r => r.origin === 'index')
    expect(indexed).toHaveLength(counts.codex.inFamily)
    expect(indexed.filter(r => r.isExec)).toHaveLength(counts.codex.exec)
    expect(indexed.filter(r => r.isNativeSubagent).length).toBeGreaterThanOrEqual(counts.codex.subagents)
    expect(indexed.filter(r => r.userTexts[0]?.startsWith('<orchestration-handoff>'))).toHaveLength(counts.codex.orchestrationChildren)
    expect(indexed.every(r => r.activitySource === 'index' && r.lastUserActivityAt !== null)).toBe(true)
    // Only the sampled rollouts exist on disk in the corpus; every other index
    // row must be reported, not dropped, and marked unavailable.
    expect(indexed.filter(r => r.available).length).toBeLessThanOrEqual(counts.codex.sampledRollouts + counts.codex.unindexedSampled)
    expect(source.lastDowngradeReason()).toBeNull()
    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees }) })
    expect(everywhere.filter(r => r.origin === 'index')).toHaveLength(counts.codex.inFamily + counts.codex.control)
  })

  it('treats a Codex name that merely prefixes the title as no name', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const db = new DatabaseSync(join(corpus.codexHome, 'state_5.sqlite'))
    const named = db.prepare("select id, name, title from threads where name is not null and name <> '' limit 1").get() as { id: string; name: string; title: string } | undefined
    db.close()
    if (!named) return
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    const row = rows.find(r => r.nativeId === named.id)!
    expect(row.customTitle).toBe(named.title.startsWith(named.name) ? null : named.name)
  })

  it('unions rollouts on disk that the index does not know about', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const counts = corpus.manifest.counts as { codex: { unindexedSampled: number } }
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    const scanned = rows.filter(r => r.origin === 'scan')
    expect(scanned.length).toBe(counts.codex.unindexedSampled)
    for (const r of scanned) expect(r.available).toBe(true)
  })

  it('falls back to the rollout scan when the index is missing and reports why', async () => {
    const { corpus, source, listWorktrees } = await setup()
    await rename(join(corpus.codexHome, 'state_5.sqlite'), join(corpus.codexHome, 'state_5.sqlite.away'))
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.origin === 'scan' && r.available)).toBe(true)
    expect(source.lastDowngradeReason()).toMatch(/no state_N\.sqlite/)
  })

  it('lists prompts for a sampled rollout newest first', async () => {
    const { source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    const row = rows.find(r => r.available && r.origin === 'index' && !r.isExec)!
    const prompts = await source.prompts(row.nativeId, row.cwd ?? '')
    expect(prompts.length).toBeGreaterThan(0)
  })
})
