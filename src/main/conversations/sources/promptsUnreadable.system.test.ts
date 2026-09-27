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

// #1434 review round 1 (a, b): paths where "unknown" still became "no prompts"
// one level below the first fix — existsSync reads EACCES as absent, the
// providers' own walks and resolvers skip what they cannot read, and a
// transcript whose every line is garbage folded to nothing. Real files: the
// recorded corpus's rollouts and databases, locked or damaged.
describe('round 1: unknown is never "no prompts"', () => {
  const scratch = (name: string) => join(corpus.opencodeDataDir, '..', `r1-${name}`)
  async function locked<T>(dir: string, run: () => Promise<T>): Promise<T> {
    await chmod(dir, 0o000)
    try {
      return await run()
    } finally {
      await chmod(dir, 0o700)
    }
  }

  it('Codex: a known rollout under a locked day directory is unreadable, and reads once it opens', async () => {
    const source = new CodexConversationSource({ codexHome: corpus.codexHome })
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const rows = await source.discover({ scope: 'repository', family })
    const paths = (source as unknown as { rolloutPaths: Map<string, string> }).rolloutPaths
    const row = rows.find(r => paths.has(r.nativeId) && existsSync(paths.get(r.nativeId)!))!
    const before = await source.prompts(row.nativeId, row.cwd ?? '')
    const day = join(paths.get(row.nativeId)!, '..')
    await expect(locked(day, () => source.prompts(row.nativeId, row.cwd ?? ''))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    expect(await source.prompts(row.nativeId, row.cwd ?? '')).toEqual(before)
  })

  it('Codex: a state index that is there but cannot be opened, with no rollout found, is unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const codexHome = scratch('codex-bad-index')
      await mkdir(join(codexHome, 'sessions'), { recursive: true })
      await writeFile(join(codexHome, 'state_5.sqlite'), 'this is not an sqlite database')
      await expect(new CodexConversationSource({ codexHome }).prompts('019-missing', '')).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
      // No index at all and no rollout: genuinely not here.
      const bare = scratch('codex-no-index')
      await mkdir(join(bare, 'sessions'), { recursive: true })
      expect(await new CodexConversationSource({ codexHome: bare }).prompts('019-missing', '')).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('OpenCode: a real database in an inaccessible directory is unreadable, not absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dataDir = scratch('opencode-locked')
      await mkdir(dataDir, { recursive: true })
      const { copyFile } = await import('node:fs/promises')
      await copyFile(join(corpus.opencodeDataDir, 'opencode.db'), join(dataDir, 'opencode.db'))
      const source = new OpencodeConversationSource({ dataDir })
      await expect(locked(dataDir, () => source.prompts('ses_x', '/fixture/repo'))).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
      expect(await source.prompts('ses_x', '/fixture/repo')).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('Pi: a session named for this id whose header is damaged is unreadable; a readable header for another cwd is not this session', async () => {
    const home = scratch('pi-home')
    const cwd = join(home, 'project')
    const dir = join(home, '.pi', 'agent', 'sessions', encodeCwdForSessionDir(cwd))
    await mkdir(dir, { recursive: true })
    const source = new PiConversationSource({ env: {}, homeDirectory: home })
    await writeFile(join(dir, '2026-09-27T00-00-00-000Z_thread-1.jsonl'), '{bad json}\n')
    await expect(source.prompts('thread-1', cwd)).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    await writeFile(join(dir, '2026-09-27T00-00-00-000Z_thread-2.jsonl'), `${JSON.stringify({ type: 'session', id: 'thread-2', cwd: '/elsewhere' })}\n`)
    expect(await source.prompts('thread-2', cwd)).toEqual([])
  })

  it('Grok: a transcript whose summary is gone is unreadable; a transcript mid-write settles and reads', async () => {
    const grokHome = scratch('grok-home')
    const cwd = scratch('grok-project')
    await mkdir(cwd, { recursive: true })
    const lost = '33333333-3333-4333-8333-333333333333'
    const lostFile = resolveGrokTranscriptPath(cwd, lost, grokHome)
    await mkdir(join(lostFile, '..'), { recursive: true })
    await writeFile(lostFile, '')
    const source = new GrokConversationSource({ grokHome })
    await expect(source.prompts(lost, cwd)).rejects.toBeInstanceOf(ConversationPromptsUnreadable)

    const writing = '44444444-4444-4444-8444-444444444444'
    const file = resolveGrokTranscriptPath(cwd, writing, grokHome)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(join(file, '..', 'summary.json'), JSON.stringify({ info: { id: writing, cwd }, chat_format_version: 1 }))
    await writeFile(file, '{"partial":')
    // Grok's writer finishes the record while the reader waits.
    setTimeout(() => { void writeFile(file, '') }, 100)
    expect(await source.prompts(writing, cwd)).toEqual([])
  })

  it('Claude: a transcript whose every line is garbage is unreadable; one good record keeps it readable', async () => {
    const projectsDir = scratch('claude-projects')
    const cwd = '/fixture/garbled'
    const dir = join(projectsDir, sanitizePath(cwd))
    await mkdir(dir, { recursive: true })
    const source = new ClaudeConversationSource({ projectsDir, history: new ClaudeHistoryIndex(join(projectsDir, 'history.jsonl')) })
    await writeFile(join(dir, '55555555-5555-4555-8555-555555555555.jsonl'), '{not-json}\n{also not json}\n')
    await expect(source.prompts('55555555-5555-4555-8555-555555555555', cwd)).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    // And again from the prompt folder's cache (#1434 verification a: the
    // cache-hit path's check was unpinned).
    await expect(source.prompts('55555555-5555-4555-8555-555555555555', cwd)).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    // A recorded transcript with one garbage line in front: still readable,
    // the same prompts as the original (bad lines are skipped, as before).
    const recorded = new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history: new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl')) })
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const real = (await recorded.discover({ scope: 'cwd', family })).find(r => (r.promptCount ?? 0) > 0 && r.cwd)!
    const { readFile } = await import('node:fs/promises')
    const original = await readFile(join(corpus.claudeConfigDir, 'projects', sanitizePath(real.cwd!), `${real.nativeId}.jsonl`), 'utf8')
    const mixedDir = join(projectsDir, sanitizePath(real.cwd!))
    await mkdir(mixedDir, { recursive: true })
    await writeFile(join(mixedDir, `${real.nativeId}.jsonl`), `{not-json}\n${original}`)
    const expected = await recorded.prompts(real.nativeId, real.cwd!)
    expect(expected.length).toBeGreaterThan(0)
    expect(await source.prompts(real.nativeId, real.cwd!)).toEqual(expected)
  })
})

// #1434 review c: the ABSENT half of the rule, on a real fresh install (the
// Pi probe's `missing -> []` survived a mutation because every fixture created
// the directories first), and ENOTDIR — a path component that is a plain file
// — which is absence too, never "unreadable".
describe('round 1 c: absence stays "no prompts"', () => {
  it('Pi on a home with no .pi at all answers no prompts', async () => {
    const home = join(corpus.opencodeDataDir, '..', 'r1c-fresh-pi-home')
    await mkdir(home, { recursive: true })
    const source = new PiConversationSource({ env: {}, homeDirectory: home })
    expect(await source.prompts('session-1', join(home, 'project'))).toEqual([])
  })

  it('a store path through a plain file (ENOTDIR) is absent, not unreadable', async () => {
    const file = join(corpus.opencodeDataDir, '..', 'r1c-plain-file')
    await writeFile(file, 'not a directory')
    expect(await new OpencodeConversationSource({ dataDir: join(file, 'opencode') }).prompts('ses_x', '/fixture/repo')).toEqual([])
    expect(await new CodexConversationSource({ codexHome: join(file, 'codex') }).prompts('019-x', '')).toEqual([])
  })
})

// #1434 verification a.
describe('verification: the conversation file itself', () => {
  it('Codex: its own rollout with an unreadable mode in a listable tree is unreadable, not absent', async () => {
    const { copyFile } = await import('node:fs/promises')
    const id = 'ff781eb7-f74e-4308-8edb-bda07505686f'
    const codexHome = join(corpus.opencodeDataDir, '..', 'v-codex-locked-file')
    const day = join(codexHome, 'sessions', '2026', '04', '13')
    await mkdir(day, { recursive: true })
    const file = join(day, `rollout-2026-04-13T16-52-23-${id}.jsonl`)
    // A real recorded rollout (the corpus's), no index, no cached path.
    await copyFile(join(__dirname, '../../../../testing/fixtures/conversations/codex/sessions/2026/04/13', `rollout-2026-04-13T16-52-23-${id}.jsonl`), file)
    const source = new CodexConversationSource({ codexHome })
    const readable = await source.prompts(id, '')
    await chmod(file, 0o000)
    try {
      await expect(new CodexConversationSource({ codexHome }).prompts(id, '')).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
    } finally {
      await chmod(file, 0o600)
    }
    expect(await new CodexConversationSource({ codexHome }).prompts(id, '')).toEqual(readable)
  })

  it('Pi: a named file whose first row is not this session\'s header is damaged, not absent', async () => {
    const home = join(corpus.opencodeDataDir, '..', 'v-pi-home')
    const cwd = join(home, 'project')
    const dir = join(home, '.pi', 'agent', 'sessions', encodeCwdForSessionDir(cwd))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '2026-09-27T00-00-00-000Z_thread-3.jsonl'), `${JSON.stringify({ type: 'message', id: 'thread-3', cwd })}\n`)
    await expect(new PiConversationSource({ env: {}, homeDirectory: home }).prompts('thread-3', cwd)).rejects.toBeInstanceOf(ConversationPromptsUnreadable)
  })
})
