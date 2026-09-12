import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { harness.handlers.set(channel, fn) } } }))

import { registerConversationsIpc } from './conversations.js'

// Re-homes the #718 evidence contract: a listing must leave a breadcrumb that
// distinguishes "zero results" from "the read failed", correlated by a cwd
// fingerprint that never retains the cwd itself.
describe('conversations IPC', () => {
  beforeEach(() => harness.handlers.clear())

  it('records a correlated success breadcrumb without the cwd', async () => {
    const list = vi.fn(async () => ({ rows: [{ nativeId: 'x' }], total: 3, hiddenChildren: 2, nextCursor: null, family: { repoRoot: '/repo', roots: ['/repo'] }, timing: { ms: 7 } }))
    const record = vi.fn()
    registerConversationsIpc({ list, prompts: vi.fn(), children: vi.fn() } as never, { record } as never)
    const handler = harness.handlers.get('conversations:list')!
    await expect(handler({}, { cwd: '/Users/me/repo/../repo', scope: 'repository', providers: ['codex'] })).resolves.toMatchObject({ total: 3 })
    expect(record).toHaveBeenCalledWith({
      area: 'conversations.list',
      name: 'conversations.list.complete',
      data: { scope: 'repository', providers: 'codex', targetFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), resultCount: 1, hiddenChildren: 2, total: 3, ms: 7, outcome: 'success' },
    })
    expect(JSON.stringify(record.mock.calls)).not.toContain('/Users/me/repo')
  })

  it('rethrows a listing failure and records it as an error, not an empty list', async () => {
    const failure = new Error('sqlite locked at /Users/me/.codex')
    const record = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerConversationsIpc({ list: vi.fn(async () => { throw failure }), prompts: vi.fn(), children: vi.fn() } as never, { record } as never)
    await expect(harness.handlers.get('conversations:list')!({}, { cwd: '/Users/me/repo', scope: 'cwd' })).rejects.toBe(failure)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ name: 'conversations.list.error', severity: 'warn', data: expect.objectContaining({ outcome: 'error' }) }))
    expect(JSON.stringify(record.mock.calls)).not.toContain('/Users/me')
    warn.mockRestore()
  })

  it('forwards prompts and children requests verbatim', async () => {
    const prompts = vi.fn(async () => [{ text: 'a', timestamp: 1 }])
    const children = vi.fn(async () => [])
    registerConversationsIpc({ list: vi.fn(), prompts, children } as never, undefined)
    await expect(harness.handlers.get('conversations:prompts')!({}, { provider: 'claude', nativeId: 'n', cwd: '/r' })).resolves.toEqual([{ text: 'a', timestamp: 1 }])
    expect(prompts).toHaveBeenCalledWith({ provider: 'claude', nativeId: 'n', cwd: '/r' })
    await harness.handlers.get('conversations:children')!({}, { provider: 'codex', nativeId: 'p', cwd: '/r' })
    expect(children).toHaveBeenCalledWith({ provider: 'codex', nativeId: 'p', cwd: '/r' })
  })
})
