import { afterEach, describe, expect, it, vi } from 'vitest'

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
    const listPrompts = vi.fn(async () => [{ text: 'p:x:1', timestamp: '2026-09-11T00:00:00.000Z' }])
    const source = new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir, listPrompts })
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
    const prompts = await source.prompts(rows[0]!.nativeId, rows[0]!.cwd!)
    expect(prompts).toEqual([{ text: 'p:x:1', timestamp: Date.parse('2026-09-11T00:00:00.000Z') }])
    expect(listPrompts).toHaveBeenCalledWith(rows[0]!.cwd, rows[0]!.nativeId)
  })

  it('is empty, not broken, when the database is absent', async () => {
    const source = new OpencodeConversationSource({ dataDir: '/nonexistent/opencode', listPrompts: async () => [] })
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => [] })
    await expect(source.discover({ scope: 'everywhere', family })).resolves.toEqual([])
  })
})
