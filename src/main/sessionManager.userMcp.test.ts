import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedUserMcpServer, UserMcpDroppedServer } from '@shared/userMcp/types.js'

// Harness mirrors sessionManager.recover.test.ts: the provider registry is
// mocked so these tests observe exactly what SessionManager hands a provider,
// which is the contract under test (#1143).
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }))

vi.mock('@main/workspaceDirectory.js', () => ({
  MissingWorkspaceDirectoryError: class extends Error {},
  assertWorkspaceDirectoryExists: vi.fn(async () => {}),
}))
vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession, deliverPrompt: vi.fn() }),
}))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: () => '/usr/bin/true' }))
vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: { mark: vi.fn(), record: vi.fn(), error: vi.fn() },
}))
vi.mock('@main/storage/feedDebugLog.js', () => ({ forgetFeedDebugSession: vi.fn() }))

class FakeAgentSession extends EventEmitter {
  readonly start = vi.fn(async (): Promise<void> => {
    this.emit('started', { projectDir: '/tmp/project' })
  })
  readonly stop = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn()
  readonly resize = vi.fn()
}

const beeper: ResolvedUserMcpServer = {
  id: 'srv-beeper',
  name: 'beeper',
  entry: { type: 'http', url: 'http://localhost:23373/v0/mcp' },
  secrets: {},
}

describe('SessionManager user MCP servers', () => {
  beforeEach(() => {
    createSession.mockReset()
    createSession.mockImplementation(() => new FakeAgentSession())
  })

  it('hands the provider exactly the servers main resolved and reports them on the snapshot', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const resolver = vi.fn(async () => ({ servers: [beeper], attachedIds: [beeper.id], dropped: [] }))
    manager.setUserMcpResolver(resolver)

    const result = await manager.spawn({ kind: 'claude', cwd: '/tmp/project', userMcpOverrides: { 'srv-beeper': true, 'bad id!': true } })

    // The renderer's override map is untrusted: malformed ids never reach the resolver.
    expect(resolver).toHaveBeenCalledWith({ provider: 'claude', overrides: { 'srv-beeper': true }, cwd: '/tmp/project' })
    expect(createSession.mock.calls[0]![0].userMcpServers).toEqual([beeper])
    expect(result.userMcpServerIds).toEqual(['srv-beeper'])
    expect(manager.getBackendSnapshot(result.sessionId)?.userMcpServerIds).toEqual(['srv-beeper'])
  })

  it('still launches the agent when a server is dropped, and says why', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const dropped: UserMcpDroppedServer[] = [{ name: 'beeper', reason: 'Secret "beeper-authorization" is not set' }]
    manager.setUserMcpResolver(async () => ({ servers: [], attachedIds: [], dropped }))
    const events: unknown[] = []
    manager.on('user-mcp-unavailable', event => events.push(event))

    const result = await manager.spawn({ kind: 'codex', cwd: '/tmp/project' })

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession.mock.calls[0]![0].userMcpServers).toEqual([])
    expect(events).toEqual([{ sessionId: result.sessionId, servers: dropped }])
  })

  it('treats a resolver failure as "no user servers", never as a failed launch', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    manager.setUserMcpResolver(async () => { throw new Error('keyring locked') })
    const events: unknown[] = []
    manager.on('user-mcp-unavailable', event => events.push(event))

    const result = await manager.spawn({ kind: 'claude', cwd: '/tmp/project' })

    expect(manager.getBackendSnapshot(result.sessionId)?.lifecycle).toBe('live')
    expect(result.userMcpServerIds).toEqual([])
    expect(events).toHaveLength(1)
  })

  it('never consults the resolver for terminal sessions', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const resolver = vi.fn()
    manager.setUserMcpResolver(resolver)
    // Terminal spawn goes through TerminalSession, which this harness does not
    // fake; only the absence of a resolver call matters here.
    await manager.spawn({ kind: 'terminal', cwd: '/tmp/project' }).catch(() => {})
    expect(resolver).not.toHaveBeenCalled()
  })
})
