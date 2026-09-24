import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A Pi pane follows an in-TUI session switch (/new, /resume, /fork). Main's
// transcript caches must move with it at once. Pi writes nothing for a /new
// session until its first reply, so "the next row will fix it" left every
// main-side reader on the conversation the user had just left.
// Mock preamble mirrors sessionManager.lifecycle.test.ts.
const { createSession, deliverPrompt } = vi.hoisted(() => ({
  createSession: vi.fn(),
  deliverPrompt: vi.fn(),
}))

vi.mock('@main/workspaceDirectory.js', () => ({
  // These suites spawn into synthetic paths ('/tmp/project', '/recorded/worktree')
  // that intentionally do not exist on disk. The real spawn-path guard stats the
  // cwd, so it is stubbed here; workspaceDirectory.test.ts covers the guard
  // itself, and sessionManager.recover.test.ts overrides this mock to prove the
  // manager surfaces a missing folder.
  MissingWorkspaceDirectoryError: class MissingWorkspaceDirectoryError extends Error {
    constructor(readonly cwd: string) {
      super(`Workspace folder is missing: ${cwd}`)
      this.name = 'MissingWorkspaceDirectoryError'
    }
  },
  assertWorkspaceDirectoryExists: vi.fn(async () => {}),
}))

vi.mock('@providers/registry.main.js', () => ({
  // Pi is terminal-only: main normalizes its runtime and calls
  // createTerminalSession.
  getMainProvider: () => ({ createSession, createTerminalSession: createSession, deliverPrompt }),
}))

// Mutable so the cli-not-found case can make lookup fail. The resolver and
// setup-state writes are mocked too, because a failed cached lookup triggers a
// late PATH re-resolve that would otherwise probe the developer's real
// machine, where the CLI may well be installed.
const toolchain = vi.hoisted(() => ({ path: '/usr/bin/true' }))

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => toolchain.path,
  refreshToolchainFromState: vi.fn(async () => {}),
}))

vi.mock('@main/setup/binaryResolver.js', () => ({
  resolveToolPath: vi.fn(async () => null),
}))

vi.mock('@main/setup/setupState.js', () => ({
  updateToolPaths: vi.fn(async () => {}),
}))

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: { mark: vi.fn(), record: vi.fn(), error: vi.fn() },
}))

vi.mock('@main/providerSwitch/shared.js', () => ({
  resolveProviderTranscriptPath: vi.fn(async ({ providerSessionId }: { providerSessionId: string }) => `/sessions/${providerSessionId}.jsonl`),
}))

vi.mock('@main/storage/feedDebugLog.js', () => ({
  forgetFeedDebugSession: vi.fn(),
}))

class FakeAgentSession extends EventEmitter {
  readonly start = vi.fn(async (): Promise<void> => {
    this.emit('started', { projectDir: '/tmp/project' })
  })
  readonly stop = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn()
  readonly resize = vi.fn()
}


describe('SessionManager and a provider session switch', () => {
  beforeEach(() => {
    createSession.mockReset()
    toolchain.path = '/usr/bin/true'
  })

  it('moves the transcript file and the resume identity to the new session immediately', async () => {
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager(null, null)
    expect(await manager.recover({ sessionId: 'pane', kind: 'pi', cwd: '/tmp/project', resumeSessionId: 'old' })).toMatchObject({ ok: true })
    session.emit('jsonl-entry', { type: 'message', id: 'a1' }, '/sessions/old.jsonl')
    expect(await manager.resolveTranscriptFile('pane')).toBe('/sessions/old.jsonl')

    const forwarded: unknown[] = []
    manager.on('provider-session-changed', change => forwarded.push(change))
    // /new: pi reports the file it WILL write; nothing is on disk yet.
    session.emit('provider-session-changed', { providerSessionId: 'new', transcriptFile: '/sessions/new.jsonl', reason: 'new' })
    expect(manager.getTranscriptFile('pane')).toBe('/sessions/new.jsonl')
    expect(forwarded).toEqual([{ sessionId: 'pane', providerSessionId: 'new', transcriptFile: '/sessions/new.jsonl', reason: 'new' }])

    // A switch that names no file yet: the cache empties, and the resume-aware
    // fallback resolves the NEW session, never the old one.
    session.emit('provider-session-changed', { providerSessionId: 'newer', transcriptFile: null, reason: 'resume' })
    expect(manager.getTranscriptFile('pane')).toBeNull()
    expect(await manager.resolveTranscriptFile('pane')).toBe('/sessions/newer.jsonl')
  })
})
