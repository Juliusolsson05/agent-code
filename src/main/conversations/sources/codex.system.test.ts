import { chmod, readdir, rename, rm } from 'node:fs/promises'
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

  it('lists the same rows for a family whose roots keep their case', async () => {
    // On linux the family does not lowercase; `lower(cwd) = ?` must still be
    // bound to a lowercased root, or every row recorded at the repo root
    // vanishes while the LIKE clause keeps the worktree rows.
    const { source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const mixed = { ...family, cwd: family.cwd.toUpperCase(), roots: family.roots.map(r => r.toUpperCase()) }
    const lower = await source.discover({ scope: 'repository', family })
    const upper = await source.discover({ scope: 'repository', family: mixed })
    expect(upper.map(r => r.nativeId).sort()).toEqual(lower.map(r => r.nativeId).sort())
    const cwdLower = await source.discover({ scope: 'cwd', family: await resolveFamily('/fixture/repo', 'cwd', { listWorktrees }) })
    const cwdUpper = await source.discover({ scope: 'cwd', family: { ...family, scope: 'cwd', cwd: '/FIXTURE/REPO' } })
    expect(cwdUpper).toHaveLength(cwdLower.length)
    expect(cwdLower.length).toBeGreaterThan(0)
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

  it('unions rollouts on disk that the index does not know about, and only those', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const counts = corpus.manifest.counts as { codex: { unindexedSampled: number; controlRollouts: number; archivedRollouts: number } }
    // The corpus keeps rollout files for indexed threads of OTHER projects
    // (and of an archived family thread when one exists). Neither may be
    // re-listed as unindexed: treating them so read nine hundred rollout
    // heads per discovery on the author's machine (seven seconds) and would
    // resurrect archived threads.
    expect(counts.codex.controlRollouts + counts.codex.archivedRollouts).toBeGreaterThan(0)
    for (const scope of ['repository', 'everywhere'] as const) {
      const family = await resolveFamily('/fixture/repo', scope, { listWorktrees })
      const rows = await source.discover({ scope, family })
      const scanned = rows.filter(r => r.origin === 'scan')
      expect(scanned.length).toBeLessThanOrEqual(counts.codex.unindexedSampled)
      for (const r of scanned) expect(r.available).toBe(true)
      const ids = rows.map(r => r.nativeId)
      expect(new Set(ids).size).toBe(ids.length)
    }
    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees }) })
    expect(everywhere.filter(r => r.origin === 'scan')).toHaveLength(counts.codex.unindexedSampled)
  })

  it('forgets the parsed head of a rollout that is gone (#1278)', async () => {
    // `heads` is keyed by file and was never pruned: every rollout Codex ever
    // wrote and then deleted or archived kept its head for the process's life.
    const { corpus, listWorktrees } = await setup()
    await rename(join(corpus.codexHome, 'state_5.sqlite'), join(corpus.codexHome, 'state_5.sqlite.away'))
    const source = new CodexConversationSource({ codexHome: corpus.codexHome, walkTtlMs: 0 })
    const heads = (source as unknown as { heads: Map<string, unknown> }).heads
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const first = await source.discover({ scope: 'everywhere', family })
    const gone = first[0]!.file!
    expect(heads.has(gone)).toBe(true)

    await rm(gone)
    const second = await source.discover({ scope: 'everywhere', family })
    expect(second.map(r => r.file)).not.toContain(gone)
    expect(heads.has(gone)).toBe(false)
    expect(heads.size).toBe(second.length)
  })

  it('skips an unreadable rollout instead of failing the whole Codex list (#1251 row 8)', async () => {
    // readline's async iterator rethrows a stream error (EACCES here, EIO on a
    // failing disk), and nothing between readRolloutHead and discover() caught
    // it, so one rollout the app cannot open emptied the Codex column.
    const { corpus, source, listWorktrees } = await setup()
    const counts = corpus.manifest.counts as { codex: { inFamily: number; unindexedSampled: number } }
    const rollouts = (await readdir(join(corpus.codexHome, 'sessions'), { recursive: true }))
      .filter(name => /rollout-.*\.jsonl$/.test(name)).map(name => join(corpus.codexHome, 'sessions', name))
    expect(rollouts.length).toBeGreaterThan(1)
    for (const file of rollouts) await chmod(file, 0o000)
    // unshift: permissions come back before the corpus cleanup removes the tree.
    cleanups.unshift(async () => { for (const file of rollouts) await chmod(file, 0o600) })
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })

    // Index path: the indexed rows never open a rollout and must all survive;
    // the unindexed union is what reads heads, and it now skips what it cannot.
    const indexed = await source.discover({ scope: 'everywhere', family })
    expect(indexed.filter(r => r.origin === 'index').length).toBeGreaterThanOrEqual(counts.codex.inFamily)
    expect(indexed.filter(r => r.origin === 'scan')).toHaveLength(0)
    // Review of #1411 (c): the skip must not look like a complete result.
    expect(counts.codex.unindexedSampled).toBeGreaterThan(0)
    expect(source.lastDowngradeReason()).toMatch(/skipped \d+ unreadable rollout/)

    // Fallback path: one readable rollout still lists beside unreadable ones.
    await chmod(rollouts[0]!, 0o600)
    await rename(join(corpus.codexHome, 'state_5.sqlite'), join(corpus.codexHome, 'state_5.sqlite.away'))
    const fresh = new CodexConversationSource({ codexHome: corpus.codexHome })
    const scanned = await fresh.discover({ scope: 'everywhere', family })
    expect(scanned.map(r => r.file)).toEqual([rollouts[0]])
    expect(fresh.lastDowngradeReason()).toMatch(/no state_N\.sqlite.*; skipped \d+ unreadable rollout/)
  })

  // Review of #1411 (b): SQLite keeps any value in any column, so one thread
  // whose title is a BLOB made `.trim()` throw and rejected the whole index.
  it('lists every indexed thread when one row holds a value of the wrong type (#1251 row 8)', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const before = await source.discover({ scope: 'everywhere', family })
    const db = new DatabaseSync(join(corpus.codexHome, 'state_5.sqlite'))
    const [victim, second] = (db.prepare('select id from threads where archived = 0 limit 2').all() as Array<{ id: string }>).map(row => row.id)
    // Every string column the row projects, not only the title (review of
    // #1411, round 2: guards on `source` and the others survived mutation).
    db.prepare(`update threads set title = x'00', preview = x'00', name = x'00', source = x'00', thread_source = x'00',
      agent_role = x'00', git_branch = x'00', originator = x'00', cwd = x'00', rollout_path = x'00',
      created_at_ms = x'00', updated_at_ms = x'00', first_user_message = 'fallback label' where id = ?`).run(victim)
    // The fallback chain itself: an empty title falls to a BLOB first message,
    // which must fall through to the preview rather than throw.
    db.prepare("update threads set title = '', first_user_message = x'00', preview = 'preview label' where id = ?").run(second)
    db.close()

    const after = await new CodexConversationSource({ codexHome: corpus.codexHome }).discover({ scope: 'everywhere', family })
    expect(after).toHaveLength(before.length)
    const victimRow = after.find(r => r.nativeId === victim)
    expect(victimRow?.userTexts).toEqual(['fallback label'])
    expect(victimRow?.cwd).toBeNull()
    expect(victimRow?.gitBranch).toBeNull()
    expect(after.find(r => r.nativeId === second)?.userTexts).toEqual(['preview label'])
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
