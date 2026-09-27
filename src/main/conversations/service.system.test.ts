import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ClaudeHistoryIndex } from './sources/claudeHistory.js'
import { ClaudeConversationSource } from './sources/claude.js'
import { CodexConversationSource } from './sources/codex.js'
import { OpencodeConversationSource } from './sources/opencode.js'
import { ConversationService } from './service.js'
import { corpusWorktreesPorcelain, installConversationCorpus, type InstalledCorpus } from '../../../testing/support/conversations/installCorpus.js'

// One corpus install per file: the install copies 450 files and costs more
// than a second on a loaded machine, and every case below reads only.
let corpus: InstalledCorpus
let service: () => ConversationService
beforeAll(async () => {
  corpus = await installConversationCorpus()
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  service = () => {
    const claudeHistory = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
    return new ConversationService({
      sources: [
        new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history: claudeHistory }),
        new CodexConversationSource({ codexHome: corpus.codexHome }),
        new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir }),
      ],
      ledger: null,
      listWorktrees: async () => worktrees,
      claudeHistory,
    })
  }
})
afterAll(async () => { await corpus?.cleanup() })

describe('ConversationService', () => {
  it('lists the repository across providers, hides children, and reports timing', async () => {
    const counts = corpus.manifest.counts as { claude: { inFamily: number }; codex: { inFamily: number }; opencode: { inFamily: number } }
    const response = await service().list({ cwd: '/fixture/repo/.worktrees/extension-platform', scope: 'repository', limit: 500 })
    expect(response.total).toBeGreaterThanOrEqual(counts.claude.inFamily + counts.codex.inFamily + counts.opencode.inFamily)
    expect(new Set(response.rows.map(r => r.provider)).size).toBeGreaterThanOrEqual(2)
    expect(response.hiddenChildren).toBeGreaterThan(0)
    expect(response.family.repoRoot).toBe('/fixture/repo')
    expect(response.timing.ms).toBeGreaterThanOrEqual(0)
  })

  it('searches Claude prompts through history and lists a row\'s prompts and children', async () => {
    const s = service()
    const all = await s.list({ cwd: '/fixture/repo', scope: 'repository', includeChildren: true, limit: 5000 })
    const parent = all.rows.find(r => r.provider === 'claude' && (r.promptCount ?? 0) > 1 && r.cwd)!
    expect(parent).toBeDefined()
    const prompts = await s.prompts({ provider: 'claude', nativeId: parent.nativeId, cwd: parent.cwd! })
    expect(prompts.length).toBeGreaterThan(0)
    const needle = prompts[0]!.text.slice(0, 10)
    const hits = await s.list({ cwd: '/fixture/repo', scope: 'repository', query: needle, includeChildren: true, limit: 5000 })
    expect(hits.rows.some(r => r.nativeId === parent.nativeId)).toBe(true)
    const codexParent = all.rows.find(r => r.provider === 'codex' && all.rows.some(c => c.parentNativeId === r.nativeId))
    expect(codexParent).toBeDefined()
    const children = await s.children({ provider: 'codex', nativeId: codexParent!.nativeId, cwd: codexParent!.cwd! })
    expect(children.length).toBeGreaterThan(0)
    expect(children.every(c => c.parentNativeId === codexParent!.nativeId)).toBe(true)
  })

  it('serves a second listing from cache without re-discovering within the freshness window', async () => {
    const s = service()
    const first = await s.list({ cwd: '/fixture/repo', scope: 'repository', limit: 20 })
    const second = await s.list({ cwd: '/fixture/repo', scope: 'repository', limit: 20 })
    expect(second.rows.map(r => r.nativeId)).toEqual(first.rows.map(r => r.nativeId))
    expect(s.discoveriesForTests()).toBe(1)
  })
})

// #1430 (found by #1429 review b): `git worktree list` timing out answered `[]`,
// resolveFamily fell back to the cwd alone, and the service cached that guess
// for DISCOVERY_FRESH_MS. From a linked checkout the main checkout's
// conversations dropped out of the repository picker and nothing said so.
describe('ConversationService when git times out listing worktrees', () => {
  it('says the family is incomplete, does not cache it, and recovers when git answers', async () => {
    const porcelain = await corpusWorktreesPorcelain()
    const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
    let timedOut = true
    const calls: string[] = []
    const claudeHistory = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
    const s = new ConversationService({
      sources: [
        new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history: claudeHistory }),
        new CodexConversationSource({ codexHome: corpus.codexHome }),
        new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir }),
      ],
      ledger: null,
      // The shape main's listWorktreesForCwdDetailed answers.
      listWorktrees: async cwd => {
        calls.push(cwd)
        return timedOut ? { worktrees: [], timedOut: true } : { worktrees, timedOut: false }
      },
      claudeHistory,
    })
    const cwd = '/fixture/repo/.worktrees/extension-platform'

    const slow = await s.list({ cwd, scope: 'repository', limit: 500 })
    expect(slow.family.gitTimedOut).toBe(true)
    // Asked again at once: a guessed family is never served from the cache.
    await s.list({ cwd, scope: 'repository', limit: 500 })
    expect(calls).toHaveLength(2)

    timedOut = false
    const answered = await s.list({ cwd, scope: 'repository', limit: 500 })
    expect(answered.family.gitTimedOut).toBeUndefined()
    expect(answered.family.repoRoot).toBe('/fixture/repo')
    // The main checkout's rows are back: the guessed family was missing some.
    expect(answered.total).toBeGreaterThan(slow.total)
  })
})
