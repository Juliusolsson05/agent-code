import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { existsSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveGrokTranscriptPath } from 'grok-code-headless'
import { encodeCwdForSessionDir } from 'pi-terminal-headless'

import { sanitizePath } from '@shared/runtime/projectDir.js'
import { resolveFamily } from '../family.js'
import { ClaudeHistoryIndex } from './claudeHistory.js'
import { ClaudeConversationSource } from './claude.js'
import { CodexConversationSource } from './codex.js'
import { PiConversationSource } from './pi.js'
import { GrokConversationSource } from './grok.js'
import { OpencodeConversationSource } from './opencode.js'
import { ConversationPromptsUnreadable } from './types.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

// #1306: a conversation whose transcript or store is THERE but unreadable
// answered [] from every source, so View Prompts said "no prompts" for a
// damaged file. Each source now throws ConversationPromptsUnreadable for it,
// and a missing file still answers [] (a new session has none yet). The Pi
// source is pinned in pi.system.test.ts.
//
// Real files: the recorded conversation corpus, made unreadable with chmod
// (or, for OpenCode's store, replaced by bytes that are not a database).

const cleanups: Array<() => Promise<void>> = []
let corpus: Awaited<ReturnType<typeof installConversationCorpus>>
let listWorktrees: () => Promise<Array<{ path: string }>>
beforeAll(async () => {
  corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  listWorktrees = async () => worktrees
})
afterAll(async () => { for (const c of cleanups.splice(0)) await c() })

// The prompt folder caches by size and mtime, and a cached answer for an
// unchanged file is correct. The file changes first (as a live transcript
// does), so the read after it is a real read of an unreadable file.
async function unreadable<T>(file: string, run: () => Promise<T>): Promise<T> {
  await appendFile(file, '\n')
  await chmod(file, 0o000)
  try {
    return await run()
  } finally {
    await chmod(file, 0o600)
  }
}

describe('a conversation file that is there but unreadable', () => {
  it('Claude says so; a missing one is still no prompts', async () => {
    const history = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
    await history.refresh()
    const source = new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history })
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const row = (await source.discover({ scope: 'cwd', family })).find(r => (r.promptCount ?? 0) > 0 && r.cwd)!
    const file = join(corpus.claudeConfigDir, 'projects', sanitizePath(row.cwd!), `${row.nativeId}.jsonl`)
    await expect(unreadable(file, () => source.prompts(row.nativeId, row.cwd!))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    expect(await source.prompts('00000000-0000-0000-0000-000000000000', row.cwd!)).toEqual([])
  })

  it('Codex says so for a known rollout', async () => {
    const source = new CodexConversationSource({ codexHome: corpus.codexHome })
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const rows = await source.discover({ scope: 'repository', family })
    const paths = (source as unknown as { rolloutPaths: Map<string, string> }).rolloutPaths
    // A rollout the corpus actually holds (some recorded paths point elsewhere).
    const row = rows.find(r => paths.has(r.nativeId) && existsSync(paths.get(r.nativeId)!))!
    const file = paths.get(row.nativeId)!
    expect(file).toBeTruthy()
    await expect(unreadable(file, () => source.prompts(row.nativeId, row.cwd ?? ''))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
  })

  it('OpenCode says so when its store is not a database; no store at all is no prompts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const damaged = join(corpus.opencodeDataDir, '..', 'opencode-damaged')
      await mkdir(damaged, { recursive: true })
      await writeFile(join(damaged, 'opencode.db'), 'this is not an sqlite database')
      await expect(new OpencodeConversationSource({ dataDir: damaged }).prompts('ses_x', '/fixture/repo')).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
      expect(await new OpencodeConversationSource({ dataDir: join(damaged, 'absent') }).prompts('ses_x', '/fixture/repo')).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('Grok says so; a missing one is still no prompts', async () => {
    const grokHome = join(corpus.opencodeDataDir, '..', 'grok-home')
    // Grok resolves the cwd's real path, so it must exist.
    const cwd = join(corpus.opencodeDataDir, '..', 'grok-project')
    await mkdir(cwd, { recursive: true })
    const id = '11111111-1111-4111-8111-111111111111'
    const file = resolveGrokTranscriptPath(cwd, id, grokHome)
    await mkdir(join(file, '..'), { recursive: true })
    // A session the loader accepts: its summary names it, format version 1.
    await writeFile(join(file, '..', 'summary.json'), JSON.stringify({ info: { id, cwd }, chat_format_version: 1 }))
    await writeFile(file, '')
    const source = new GrokConversationSource({ grokHome })
    await expect(unreadable(file, () => source.prompts(id, cwd))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    expect(await source.prompts('22222222-2222-4222-8222-222222222222', cwd)).toEqual([])
  })
})

// Steering q116: the step BEFORE the read (finding the file) also mapped every
// failure to "not here". A stat or readdir that fails for anything but absence
// is unknown and is said; after the directory recovers, the same call reads.
describe('finding a conversation file that cannot be listed', () => {
  async function unlisted<T>(dir: string, run: () => Promise<T>): Promise<T> {
    await chmod(dir, 0o000)
    try {
      return await run()
    } finally {
      await chmod(dir, 0o700)
    }
  }

  it('Claude: an unlistable project directory is unreadable, then reads once it recovers', async () => {
    const history = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
    await history.refresh()
    const source = new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history })
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const row = (await source.discover({ scope: 'cwd', family })).find(r => (r.promptCount ?? 0) > 1 && r.cwd)!
    const dir = join(corpus.claudeConfigDir, 'projects', sanitizePath(row.cwd!))
    await expect(unlisted(dir, () => source.prompts(row.nativeId, row.cwd!))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    expect((await source.prompts(row.nativeId, row.cwd!)).length).toBeGreaterThan(0)
  })

  it('Codex: an unlistable sessions tree is unreadable; a missing one is no prompts', async () => {
    const codexHome = join(corpus.opencodeDataDir, '..', 'codex-unlistable')
    await mkdir(join(codexHome, 'sessions'), { recursive: true })
    const source = new CodexConversationSource({ codexHome })
    await expect(unlisted(join(codexHome, 'sessions'), () => source.prompts('019-thread', ''))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    expect(await source.prompts('019-thread', '')).toEqual([])
    expect(await new CodexConversationSource({ codexHome: join(codexHome, 'absent') }).prompts('019-thread', '')).toEqual([])
  })

  it('Pi: an unlistable session directory is unreadable, then answers once it recovers', async () => {
    const home = join(corpus.opencodeDataDir, '..', 'pi-home')
    const cwd = join(home, 'project')
    const dir = join(home, '.pi', 'agent', 'sessions', encodeCwdForSessionDir(cwd))
    await mkdir(dir, { recursive: true })
    const source = new PiConversationSource({ env: {}, homeDirectory: home })
    await expect(unlisted(dir, () => source.prompts('session-1', cwd))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    expect(await source.prompts('session-1', cwd)).toEqual([])
  })
})
