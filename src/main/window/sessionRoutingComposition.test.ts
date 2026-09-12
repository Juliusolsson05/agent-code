import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppWindowHooks } from './appWindow.js'
import type { SessionManager } from '@main/sessionManager.js'
import type { LspManager } from '@main/lspManager.js'

const harness = vi.hoisted(() => ({
  history: vi.fn(),
  createAgent: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>(),
  built: [] as Array<{ hooks: AppWindowHooks; sent: Array<{ channel: string; args: unknown[] }>; webContents: any }>,
}))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => harness.handlers.set(channel, handler) },
}))
vi.mock('@main/window/appWindow.js', () => ({
  zoomBrowserWindow: vi.fn(),
  buildAppWindow: ({ hooks }: { hooks: AppWindowHooks }) => {
    const sent: Array<{ channel: string; args: unknown[] }> = []
    const webContents = {
      id: harness.built.length + 1, isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
    }
    harness.built.push({ hooks, sent, webContents })
    return { id: webContents.id, webContents, isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn() }
  },
}))
vi.mock('@main/sessions/historyLoader.js', () => ({ loadInitialHistoryChunk: harness.history, loadOlderHistoryChunk: vi.fn() }))
vi.mock('@providers/registry.main.js', () => ({ getMainProvider: () => ({ createSession: harness.createAgent }) }))
vi.mock('@main/workspaceDirectory.js', () => ({
  MissingWorkspaceDirectoryError: class extends Error {}, assertWorkspaceDirectoryExists: vi.fn(async () => {}),
}))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: () => '/usr/bin/true' }))
vi.mock('@main/subagents/index.js', () => ({
  SubAgentWatcherManager: class { observeParentEntry() {} stop() {} },
}))

import * as registry from './windowRegistry.js'
import { wireSessionForwarder } from '@main/sessions/forwarder.js'
import { registerSessionIpc } from '@main/ipc/session.js'
import { registerSessionRoutingIpc } from '@main/ipc/sessionRouting.js'
import { abandonPendingBequest, recordPendingBequest, registerWindowIpc } from '@main/ipc/window.js'

let manager: SessionManager & EventEmitter
let forwarder: ReturnType<typeof wireSessionForwarder>
beforeEach(() => {
  registry.resetWindowRegistryForTests()
  harness.handlers.clear()
  harness.built.length = 0
  manager = new EventEmitter() as SessionManager & EventEmitter
  manager.recover = vi.fn<SessionManager['recover']>(async (_options, admitted) => {
    admitted?.()
    return {
    ok: true, disposition: 'adopted', snapshot: {
      sessionId: 'pane', sessionRunId: 'fixture-run', kind: 'claude', cwd: '/fixture', lifecycle: 'live',
      input: { ready: true, reason: 'ready', revision: 1 },
    },
  }
  })
  manager.getScreenSnapshot = () => null
  manager.getBackendSnapshot = () => ({
    sessionId: 'pane', sessionRunId: 'fixture-run', kind: 'claude', cwd: '/fixture', lifecycle: 'live',
    input: { ready: true, reason: 'ready', revision: 1 },
  })
  manager.getConditionsSnapshot = () => null
  manager.getProcessStateSnapshot = () => null
  manager.getNativeConversationId = () => 'native-a'
  manager.getTranscriptFile = () => '/fixture/native-a.jsonl'
  harness.history.mockReset().mockResolvedValue({ entries: [], hasMore: false })
  forwarder = wireSessionForwarder(manager, new EventEmitter() as LspManager)
  registerSessionIpc(manager, {} as never)
  registerSessionRoutingIpc(manager, forwarder)
})
afterEach(() => {
  forwarder.flush()
  manager.removeAllListeners()
  registry.resetWindowRegistryForTests()
})

describe('session routing through its real lifecycle callers', () => {
  it('preserves committed output and exit through a close veto, including the deferred cleanup turn', async () => {
    const left = registry.createAppWindow()
    registry.createAppWindow()
    registry.claimSessionForWindow('pane', left)
    harness.built[0]!.hooks.onClosing()
    manager.emit('jsonl-entry', {
      sessionId: 'pane', file: 'native-source',
      entry: { info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: 'last output' }] },
    })
    manager.emit('removed', { sessionId: 'pane' })
    manager.emit('exit', { sessionId: 'pane', exitCode: 0 })
    await new Promise(resolve => setImmediate(resolve))
    expect(harness.built[0]!.sent).toEqual([])
    expect(harness.built[1]!.sent).toEqual([])
    harness.built[0]!.hooks.onCloseVetoed()
    expect(harness.built[0]!.sent.map(e => e.channel)).toEqual(['session:jsonl-entries', 'session:exit'])
    expect(registry.windowForSession('pane')).toBe(left)
  })

  it('does not let a delayed kill response release a successor recovery claim', async () => {
    const left = registry.createAppWindow()
    registry.claimSessionForWindow('pane', left)
    const previous = registry.captureSessionWindowLease('pane')
    let finishKill!: (value: boolean) => void
    manager.kill = vi.fn(() => new Promise<boolean>(resolve => { finishKill = resolve }))
    const evt = { sender: harness.built[0]!.webContents }
    const killing = harness.handlers.get('session:kill')!(evt, 'pane')
    await harness.handlers.get('session:recover')!(evt, { sessionId: 'pane' })
    const successor = registry.captureSessionWindowLease('pane')
    expect(successor).not.toBe(previous)
    finishKill(true)
    await killing
    expect(registry.captureSessionWindowLease('pane')).toBe(successor)
    expect(registry.windowForSession('pane')).toBe(left)
  })

  it('rejects a conflicting window before recovery can expose a screen snapshot', async () => {
    const left = registry.createAppWindow()
    registry.createAppWindow()
    registry.claimSessionForWindow('pane', left)
    await expect(harness.handlers.get('session:recover')!({
      sender: harness.built[1]!.webContents,
    }, { sessionId: 'pane' })).rejects.toThrow('owned by another window')
    expect(manager.recover).toHaveBeenCalledTimes(1)
    expect(harness.built[1]!.sent).toEqual([])
  })

  it.each(['session:kill', 'session:kill-owned'])('rejects %s from a different window without releasing the visible claim', async channel => {
    const left = registry.createAppWindow()
    registry.createAppWindow()
    const lease = registry.claimSessionForWindow('pane', left)
    manager.kill = vi.fn(async () => true)
    manager.killOwned = vi.fn(async () => true)
    expect(await harness.handlers.get(channel)!({ sender: harness.built[1]!.webContents },
      channel === 'session:kill' ? 'pane' : { sessionId: 'pane', kind: 'claude', cwd: '/fixture' })).toBe(false)
    expect(manager.kill).not.toHaveBeenCalled()
    expect(manager.killOwned).not.toHaveBeenCalled()
    expect(registry.captureSessionWindowLease('pane')).toBe(lease)
  })

  it('releases a failed spawn id which no renderer ever received', async () => {
    registry.createAppWindow()
    manager.spawn = vi.fn<SessionManager['spawn']>(async (_options, onId) => {
      onId?.('failed-pane')
      throw new Error('fixture startup failure')
    })
    await expect(harness.handlers.get('session:spawn')!({
      sender: harness.built[0]!.webContents,
    }, {})).rejects.toThrow('fixture startup failure')
    expect(registry.captureSessionWindowLease('failed-pane')).toBeNull()
  })

  it('does not let a refused handoff release a subsequent claim in its destination', async () => {
    const left = registry.createAppWindow()
    const right = registry.createAppWindow()
    registry.claimSessionForWindow('pane', left)
    registry.transferSessions(['pane'], right)
    recordPendingBequest(left, right, ['pane'])
    const successor = registry.claimSessionForWindow('pane', right)
    abandonPendingBequest(left)
    expect(registry.captureSessionWindowLease('pane')).toBe(successor)
  })

  it('does not let an adoption acknowledgement from an obsolete renderer delete the saved source window', async () => {
    const left = registry.createAppWindow()
    const right = registry.createAppWindow()
    const removeWindow = vi.fn(async () => {})
    registerWindowIpc({ removeWindow } as never)
    recordPendingBequest(left, right, [])
    harness.built[1]!.hooks.onRendererUnavailable()
    harness.built[1]!.hooks.onRendererReady()
    await harness.handlers.get('window:adoption-complete')!({ sender: harness.built[1]!.webContents }, left)
    expect(removeWindow).not.toHaveBeenCalled()
    abandonPendingBequest(left)
  })
})


describe('read-only gap repair through the registry, forwarder and IPC', () => {
  function setup() {
    const left = registry.createAppWindow()
    registry.createAppWindow()
    registry.sendToSessionWindow('pane', 'session:screen', { plain: 'never published' })
    const lease = registry.claimSessionForWindow('pane', left)!
    const gap = registry.sessionRoutingGapsForWindow(left)[0]!
    const event = { sender: harness.built[0]!.webContents }
    return { left, lease, gap, event, resync: () => harness.handlers.get('session:resync-routing')!(event, gap) }
  }

  it('flushes old coalesced frames before current seeds and does not manufacture lifecycle or input', () => {
    const { resync, left } = setup()
    manager.getScreenSnapshot = () => ({ plain: 'current', markdown: 'current', recent: 'current', recentMarkdown: 'current' })
    manager.emit('screen', { sessionId: 'pane', plain: 'older', markdown: 'older', recent: 'older', recentMarkdown: 'older' })
    const receipt = resync()
    expect(receipt.kind).toBe('seeded')
    expect(harness.built[0]!.sent.filter(e => e.channel === 'session:screen').map(e => (e.args[0] as { plain: string }).plain)).toEqual(['older', 'current'])
    expect(harness.built[0]!.sent.some(e => ['session:started', 'session:exit', 'session:semantic-event'].includes(e.channel))).toBe(false)
    expect(harness.built[1]!.sent).toEqual([])
    expect(manager.recover).not.toHaveBeenCalled()
    expect(registry.sessionRoutingGapsForWindow(left)).toEqual([])
  })

  it('rejects another window and old owner revisions before loading content', async () => {
    const { gap, event, left } = setup()
    expect(harness.handlers.get('session:resync-routing')!({ sender: harness.built[1]!.webContents }, gap)).toEqual({ kind: 'stale' })
    registry.claimSessionForWindow('pane', left)
    expect(harness.handlers.get('session:resync-routing')!(event, gap)).toEqual({ kind: 'stale' })
    expect(await harness.handlers.get('session:load-routing-history')!(event, gap, 'guess')).toEqual({ kind: 'stale' })
    expect(harness.history).not.toHaveBeenCalled()
  })

  it.each(['transfer', 'reload', 'native-change', 'backend-change'])('discards a history reply after %s and keeps its read admission until settlement', async change => {
    const { left, gap, event, resync } = setup()
    const receipt = resync()
    let finish!: (value: unknown) => void
    harness.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const load = () => harness.handlers.get('session:load-routing-history')!(event, gap, receipt.history.sourceKey)
    const reading = load()
    expect(await load()).toEqual({ kind: 'unavailable' })
    if (change === 'transfer') registry.transferSessions(['pane'], registry.createAppWindow())
    if (change === 'reload') { harness.built[0]!.hooks.onRendererUnavailable(); harness.built[0]!.hooks.onRendererReady(); registry.claimSessionForWindow('pane', left) }
    if (change === 'native-change') manager.getNativeConversationId = () => 'native-b'
    if (change === 'backend-change') manager.getBackendSnapshot = () => null
    finish({ entries: [{ private: 'old native content' }], hasMore: false })
    expect(await reading).toEqual({ kind: 'stale' })
    expect(harness.history).toHaveBeenCalledTimes(1)
  })

  it('admits display ownership through the real manager only after its kind/cwd checks', async () => {
    const { SessionManager: RealManager } = await import('@main/sessionManager.js')
    const agent = Object.assign(new EventEmitter(), {
      start: vi.fn(async () => {}), stop: vi.fn(async () => {}), write: vi.fn(), resize: vi.fn(),
    })
    harness.createAgent.mockReturnValue(agent)
    const real = new RealManager()
    const realForwarder = wireSessionForwarder(real, new EventEmitter() as LspManager)
    const options = { sessionId: 'admission-pane', kind: 'claude' as const, cwd: '/fixture' }
    await real.recover(options)
    const left = registry.createAppWindow()
    const event = { sender: harness.built[0]!.webContents }
    registerSessionIpc(real, {} as never)
    expect(await harness.handlers.get('session:recover')!(event, { ...options, cwd: '/other' })).toMatchObject({ ok: false, code: 'ownership-conflict' })
    expect(registry.captureSessionWindowLease(options.sessionId)).toBeNull()
    real.emit('screen', { sessionId: options.sessionId, plain: 'private', markdown: 'private', recent: 'private', recentMarkdown: 'private' })
    realForwarder.flush()
    expect(harness.built[0]!.sent).toEqual([])
    expect(await harness.handlers.get('session:recover')!(event, options)).toMatchObject({ ok: true, disposition: 'adopted' })
    expect(registry.windowForSession(options.sessionId)).toBe(left)
    await real.kill(options.sessionId)
    realForwarder.flush()
    real.removeAllListeners()
  })
})
