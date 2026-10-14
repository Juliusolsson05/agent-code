import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Remote providers (Hermes, #1482) through SessionManager.spawn. Same harness
// as sessionManager.userMcp.test.ts: the provider registry is mocked so the
// test observes exactly what SessionManager hands the provider.
const { createSession, getToolPath, resolveToolPath } = vi.hoisted(() => ({
  createSession: vi.fn(),
  // Deliberately "no CLI anywhere": a remote spawn must not need one.
  getToolPath: vi.fn(() => ''),
  resolveToolPath: vi.fn(async () => null),
}))

vi.mock('@main/workspaceDirectory.js', () => ({
  MissingWorkspaceDirectoryError: class extends Error {},
  assertWorkspaceDirectoryExists: vi.fn(async () => {}),
}))
vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession, deliverPrompt: vi.fn() }),
}))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath, refreshToolchainFromState: vi.fn() }))
vi.mock('@main/setup/binaryResolver.js', () => ({ resolveToolPath }))
vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: { mark: vi.fn(), record: vi.fn(), error: vi.fn() },
}))
vi.mock('@main/storage/feedDebugLog.js', () => ({ forgetFeedDebugSession: vi.fn() }))

class FakeAgentSession extends EventEmitter {
  readonly start = vi.fn(async (): Promise<void> => {
    this.emit('started', {})
  })
  readonly stop = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn()
  readonly resize = vi.fn()
}

describe('SessionManager remote provider spawn', () => {
  beforeEach(() => {
    createSession.mockReset()
    createSession.mockImplementation(() => new FakeAgentSession())
    getToolPath.mockClear()
    resolveToolPath.mockClear()
  })

  it('starts a Hermes session with no local CLI, handing the provider its connection', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const resolver = vi.fn(async () => ({ servers: [], attachedIds: [], dropped: [] }))
    manager.setUserMcpResolver(resolver)

    const result = await manager.spawn({ kind: 'hermes', cwd: '/tmp/project', remoteConnectionId: 'conn-1' })

    expect(manager.getBackendSnapshot(result.sessionId)?.lifecycle).toBe('live')
    const options = createSession.mock.calls[0]![0]
    expect(options.remoteConnectionId).toBe('conn-1')
    expect(options.binary).toBeUndefined()
    // No local binary lookup at all for a remote kind.
    expect(resolveToolPath).not.toHaveBeenCalled()
    // Nothing launched on this Mac can reach a VPS agent: no user MCP is even
    // resolved (its secrets must not be decrypted for nothing).
    expect(resolver).not.toHaveBeenCalled()
    expect(options.userMcpServers).toEqual([])
  })

  it('refuses a Hermes spawn without a connection, naming where to add one', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    await expect(manager.spawn({ kind: 'hermes', cwd: '/tmp/project' })).rejects.toThrow(/Settings → Hermes/)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('still requires a CLI for local providers', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    await expect(manager.spawn({ kind: 'codex', cwd: '/tmp/project' })).rejects.toThrow()
    expect(resolveToolPath).toHaveBeenCalledWith('codex')
    expect(createSession).not.toHaveBeenCalled()
  })
})
