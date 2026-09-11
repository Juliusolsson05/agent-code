import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveFamily } from '../family.js'
import { ClaudeHistoryIndex } from './claudeHistory.js'
import { ClaudeConversationSource } from './claude.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

async function setup() {
  const corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  const listWorktrees = async () => worktrees
  const history = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
  await history.refresh()
  const source = new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history })
  return { corpus, source, listWorktrees }
}

describe('Claude conversation source', () => {
  it('discovers every family transcript across the recorded worktree dirs and nothing from the control project', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const rows = await source.discover({ scope: 'repository', family })
    const counts = corpus.manifest.counts as { claude: { inFamily: number; orchestrationChildren: number } }
    expect(rows).toHaveLength(counts.claude.inFamily)
    expect(new Set(rows.map(r => r.nativeId)).size).toBe(rows.length)
    expect(rows.every(r => r.cwd === null || family.matches(r.cwd))).toBe(true)
    expect(rows.filter(r => r.userTexts[0]?.startsWith('<orchestration-handoff>')).length).toBe(counts.claude.orchestrationChildren)
    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees }) })
    expect(everywhere.length).toBeGreaterThan(rows.length)
  })

  it('reads titles from the tail, the first prompts from a record-bounded head, and activity from history', async () => {
    const { source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const rows = await source.discover({ scope: 'repository', family })
    const titled = rows.filter(r => r.aiTitle !== null)
    // 310 of 371 real transcripts carry an ai-title record; the corpus keeps
    // the tail, so the family must show the same majority.
    expect(titled.length).toBeGreaterThan(rows.length / 2)
    for (const r of titled) expect(r.aiTitle).toMatch(/^p:[0-9a-f]{8}:\d+$/)
    const fromHistory = rows.filter(r => r.activitySource === 'history')
    expect(fromHistory.length).toBeGreaterThan(rows.length / 2)
    for (const r of fromHistory) {
      expect(r.promptCount).toBeGreaterThan(0)
      expect(r.lastUserActivityAt).toBeGreaterThan(0)
    }
    const stt = rows.find(r => r.userTexts.some(t => t.startsWith('<stt')))
    expect(stt, 'the corpus records at least one dictated first prompt').toBeDefined()
    expect(rows.every(r => r.mtime > 0 && r.file !== null && r.origin === 'scan')).toBe(true)
  })

  it('returns the exact-cwd directory only for cwd scope', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const rows = await source.discover({ scope: 'cwd', family })
    const dir = join(corpus.claudeConfigDir, 'projects', '-fixture-repo')
    const files = (await readdir(dir)).filter(n => n.endsWith('.jsonl'))
    expect(rows).toHaveLength(files.length)
  })

  it('lists prompts newest first for one conversation', async () => {
    const { source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const rows = await source.discover({ scope: 'cwd', family })
    const row = rows.find(r => (r.promptCount ?? 0) > 2)!
    const prompts = await source.prompts(row.nativeId, row.cwd ?? '/fixture/repo')
    expect(prompts.length).toBeGreaterThan(0)
    for (let i = 1; i < prompts.length; i++) {
      expect(prompts[i - 1]!.timestamp ?? 0).toBeGreaterThanOrEqual(prompts[i]!.timestamp ?? 0)
    }
  })
})
