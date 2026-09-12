import { afterEach, describe, expect, it } from 'vitest'

import { resolveFamily } from '../family.js'
import { OPENCODE_PLACEHOLDER_TITLE, OpencodeConversationSource } from './opencode.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('OpenCode conversation source', () => {
  it('lists family sessions with parent links, titles and first user texts from the database', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const counts = corpus.manifest.counts as { opencode: { inFamily: number; control: number; children: number } }
    const porcelain = await corpusWorktreesPorcelain()
    const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
    const source = new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir })
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => worktrees })
    const rows = await source.discover({ scope: 'repository', family })
    expect(rows).toHaveLength(counts.opencode.inFamily)
    expect(rows.filter(r => r.isNativeSubagent)).toHaveLength(counts.opencode.children)
    expect(rows.every(r => r.activitySource === 'index' && r.origin === 'index')).toBe(true)
    expect(rows.some(r => r.userTexts.length > 0)).toBe(true)
    // The placeholder title the app writes is reported as no title, so an
    // empty terminal session can classify as empty; the corpus keeps that
    // app-authored constant verbatim, so this is exercised for real.
    expect(rows.some(r => r.aiTitle === null && r.userTexts.length === 0)).toBe(true)
    for (const r of rows) expect(r.aiTitle).not.toBe(OPENCODE_PLACEHOLDER_TITLE)
    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => worktrees }) })
    expect(everywhere).toHaveLength(counts.opencode.inFamily + counts.opencode.control)
    // Prompts come from the database, newest first, and the oldest of them is
    // the first user text discovery already read for the same session.
    const withTexts = rows.find(r => r.userTexts.length > 0)!
    const prompts = await source.prompts(withTexts.nativeId, withTexts.cwd!)
    expect(prompts.length).toBeGreaterThanOrEqual(withTexts.userTexts.length)
    expect(prompts.at(-1)!.text).toBe(withTexts.userTexts[0])
    for (let i = 1; i < prompts.length; i++) expect(prompts[i]!.timestamp ?? 0).toBeLessThanOrEqual(prompts[i - 1]!.timestamp ?? Number.POSITIVE_INFINITY)
  })

  it('lists the same rows for a family whose roots keep their case', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const porcelain = await corpusWorktreesPorcelain()
    const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
    const source = new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir })
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => worktrees })
    const lower = await source.discover({ scope: 'repository', family })
    const upper = await source.discover({ scope: 'repository', family: { ...family, cwd: family.cwd.toUpperCase(), roots: family.roots.map(r => r.toUpperCase()) } })
    expect(upper.map(r => r.nativeId).sort()).toEqual(lower.map(r => r.nativeId).sort())
    expect(lower.length).toBeGreaterThan(0)
  })

  it('is empty, not broken, when the database is absent', async () => {
    const source = new OpencodeConversationSource({ dataDir: '/nonexistent/opencode' })
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => [] })
    await expect(source.discover({ scope: 'everywhere', family })).resolves.toEqual([])
  })
})
