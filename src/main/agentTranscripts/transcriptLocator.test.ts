import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  loadHistoryChunk: vi.fn(async () => ({ entries: [], hasMore: false })),
  transcriptLocator: vi.fn((id: string) => `fixture-db:${id}`),
  resolveTranscriptPath: vi.fn(async () => null),
  createSession: vi.fn(),
}))
vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => fake,
  listMainProviders: () => [{ ...fake, parseTranscriptLocator: (locator: string) => locator.startsWith('fixture-db:') ? locator.slice(11) : null,
    transcriptLastModifiedAt: async () => 42 }],
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('@main/workspaceDirectory.js', () => ({ assertWorkspaceDirectoryExists: vi.fn(async () => {}) }))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: () => '/usr/bin/true' }))
vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { mark: vi.fn(), record: vi.fn(), error: vi.fn() } }))
vi.mock('@main/storage/feedDebugLog.js', () => ({ forgetFeedDebugSession: vi.fn() }))
vi.mock('@main/providerSwitch/shared.js', () => ({ resolveProviderTranscriptPath: fake.resolveTranscriptPath }))

import { SessionManager } from '@main/sessionManager.js'
import { providerSessionLocator, transcriptLastModifiedAt } from './transcriptLocator.js'

it('uses a registry locator and modification evidence for a provider without a transcript file', async () => {
  expect(providerSessionLocator('codex', 'native-session')).toBe('fixture-db:native-session')
  await expect(transcriptLastModifiedAt('fixture-db:native-session')).resolves.toBe(42)
})

it('resolves resumed provider-owned history before the first entry through the real manager', async () => {
  class Session extends EventEmitter {
    async start() { this.emit('started', {}) }
    async stop() {}
    write() {}
    resize() {}
  }
  fake.createSession.mockImplementation(() => new Session())
  const manager = new SessionManager()
  try {
    const result = await manager.recover({ sessionId: 'pane', kind: 'codex', cwd: '/fixture', resumeSessionId: 'native-resume' })
    expect(result.ok).toBe(true)
    expect(manager.getTranscriptFile('pane')).toBeNull()
    await expect(manager.resolveTranscriptFile('pane')).resolves.toBe('fixture-db:native-resume')
    expect(fake.resolveTranscriptPath).not.toHaveBeenCalled()
  } finally { await manager.killAll() }
})
