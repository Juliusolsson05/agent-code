import { describe, expect, it, vi } from 'vitest'

import type { AgentNameRegistry } from '@main/agentNames/registry'

// vi.hoisted, because vi.mock factories are hoisted above ordinary consts and
// would otherwise hit the temporal dead zone the first time a mocked module is
// imported.
const { handlers, windowIdFor, getBrowserWindow } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  windowIdFor: vi.fn<(sender: unknown) => string | null>(),
  getBrowserWindow: vi.fn<(id: string) => object | null>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
}))
vi.mock('@main/storage/paths.js', () => ({ STATE_DIR: '/recorded/state' }))
vi.mock('@main/window/windowRegistry.js', () => ({
  windowIdFor: (sender: unknown) => windowIdFor(sender),
  getBrowserWindow: (id: string) => getBrowserWindow(id),
}))

const { registerAgentNamesIpc } = await import('@main/agentNames/ipc.js')

function fakeRegistry(): { registry: AgentNameRegistry; resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(async (identities: readonly string[]) =>
    Object.fromEntries(identities.map((identity, index) => [identity, `Name${index}`])))
  return { registry: { resolve } as unknown as AgentNameRegistry, resolve }
}

function event(options: { registered: boolean; mainFrame: boolean; live?: boolean }) {
  const sender = { mainFrame: {} }
  windowIdFor.mockReturnValue(options.registered ? 'window-one' : null)
  // Default live: the existing cases are about the other two clauses, and a
  // registered window is normally still open.
  getBrowserWindow.mockReturnValue(options.live === false ? null : { id: 1 })
  return { sender, senderFrame: options.mainFrame ? sender.mainFrame : {} }
}

describe('agent names IPC', () => {
  it('refuses a sender that is not a registered application window', async () => {
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await expect(handler(event({ registered: false, mainFrame: true }), ['a']))
      .rejects.toThrow(/registered application window/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a sub-frame of a registered window', async () => {
    // WHY the frame check is separate from the window check: an embedded
    // iframe (rendered content, a preview surface) shares the window's
    // WebContents. Allocating names from there would let untrusted page
    // content burn spoken addresses.
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await expect(handler(event({ registered: true, mainFrame: false }), ['a']))
      .rejects.toThrow(/registered application window/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a still-registered window whose BrowserWindow is already gone', async () => {
    // The liveness clause the control host's senderWindow applies. A retired
    // window's queued invoke would otherwise spend a spoken address that
    // allocation can never hand back.
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await expect(handler(event({ registered: true, mainFrame: true, live: false }), ['a']))
      .rejects.toThrow(/registered application window/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('de-duplicates identities before allocating', async () => {
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await handler(event({ registered: true, mainFrame: true }), ['a', 'b', 'a'])

    expect(resolve).toHaveBeenCalledWith(['a', 'b'])
  })

  it('rejects a malformed request before it reaches the registry', async () => {
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await expect(handler(event({ registered: true, mainFrame: true }), ['', 'b'])).rejects.toThrow()
    await expect(handler(event({ registered: true, mainFrame: true }), 'not-an-array')).rejects.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })
})
