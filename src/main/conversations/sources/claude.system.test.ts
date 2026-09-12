import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveFamily } from '../family.js'
import { ClaudeHistoryIndex } from './claudeHistory.js'
import { ClaudeConversationSource } from './claude.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

// One corpus per file: installing it costs seconds, and discovery is
// read-only, so every test can share the same adapter and index.
const cleanups: Array<() => Promise<void>> = []
let shared: Awaited<ReturnType<typeof setup>>
beforeAll(async () => { shared = await setup() })
afterAll(async () => { for (const c of cleanups.splice(0)) await c() })

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
    const { corpus, source, listWorktrees } = shared
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
    const { source, listWorktrees } = shared
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
    const { corpus, source, listWorktrees } = shared
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const rows = await source.discover({ scope: 'cwd', family })
    const dir = join(corpus.claudeConfigDir, 'projects', '-fixture-repo')
    const files = (await readdir(dir)).filter(n => n.endsWith('.jsonl'))
    expect(rows).toHaveLength(files.length)
  })

  it('lists a natively moved session under the worktree it moved to, and never its redirect stub', async () => {
    // Main's transcript relocation (#883) appends {type:'relocated', relocatedCwd}
    // to a live session that EnterWorktree moved, renames the file into the
    // worktree's project dir, and can leave a redirect stub behind. The head
    // records still carry the launch cwd, so without the record the picker
    // would resume the session in the main checkout.
    const { corpus, source, listWorktrees } = shared
    const id = '11111111-2222-4333-8444-555555555555'
    const worktree = '/fixture/repo/.worktrees/extension-platform'
    const user = (text: string, ts: string) => JSON.stringify({ type: 'user', uuid: `${text}-uuid`, sessionId: id, cwd: '/fixture/repo', timestamp: ts, message: { role: 'user', content: text } })
    const relocated = JSON.stringify({ type: 'relocated', sessionId: id, relocatedCwd: worktree })
    const projects = join(corpus.claudeConfigDir, 'projects')
    await mkdir(join(projects, '-fixture-repo--worktrees-extension-platform'), { recursive: true })
    await writeFile(join(projects, '-fixture-repo--worktrees-extension-platform', `${id}.jsonl`), [user('first prompt', '2026-09-11T10:00:00.000Z'), user('second prompt', '2026-09-11T11:00:00.000Z'), relocated].join('\n') + '\n')
    await writeFile(join(projects, '-fixture-repo', `${id}.jsonl`), relocated + '\n')
    const repository = await source.discover({ scope: 'repository', family: await resolveFamily('/fixture/repo', 'repository', { listWorktrees }) })
    const rows = repository.filter(r => r.nativeId === id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ cwd: worktree, userTexts: ['first prompt', 'second prompt'] })
    expect(rows[0]!.file).toContain('-fixture-repo--worktrees-extension-platform')
    // cwd scope: the session belongs to the worktree now, not to where it started.
    const atRoot = await source.discover({ scope: 'cwd', family: await resolveFamily('/fixture/repo', 'cwd', { listWorktrees }) })
    expect(atRoot.some(r => r.nativeId === id)).toBe(false)
    const atWorktree = await source.discover({ scope: 'cwd', family: await resolveFamily(worktree, 'cwd', { listWorktrees }) })
    expect(atWorktree.some(r => r.nativeId === id)).toBe(true)
  })

  it('lists prompts newest first for one conversation', async () => {
    const { source, listWorktrees } = shared
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
