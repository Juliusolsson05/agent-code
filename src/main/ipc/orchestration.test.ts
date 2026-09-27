import { expect, it, vi } from 'vitest'

// #1369 review b: the carry crosses preload -> IPC -> OrchestrationBridge, and
// every other test injected one side (the renderer mocks window.api, the main
// tests call carryParent directly), so dropping the handler or the preload
// method left them all green. Here ONE electron mock routes ipcRenderer.invoke
// into whatever ipcMain.handle registered: the real preload method reaches
// the real handler and the real bridge, as in the app.
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) },
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for '${channel}'`)
      return await handler({}, ...args)
    },
  },
}))
vi.mock('@main/window/windowRegistry.js', () => ({ sendToWindow: () => true, windowForSession: () => 'test-window' }))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')
const { registerOrchestrationIpc } = await import('./orchestration.js')
const { orchestrationApi } = await import('@preload/api/orchestration.js')

it('carries a replaced parent from the renderer API into the bridge', async () => {
  const bridge = new OrchestrationBridge()
  registerOrchestrationIpc(bridge)
  await orchestrationApi.carryOrchestrationParent('parent-a', 'parent-b')
  expect((bridge as unknown as { replacedParents: Map<string, { to: string }> }).replacedParents.get('parent-a')?.to).toBe('parent-b')
})

it('ignores a malformed carry instead of recording an alias for undefined', async () => {
  const bridge = new OrchestrationBridge()
  registerOrchestrationIpc(bridge)
  await handlers.get('orchestration:carry-parent')!({}, undefined)
  await handlers.get('orchestration:carry-parent')!({}, { from: 'parent-a' })
  expect((bridge as unknown as { replacedParents: Map<string, unknown> }).replacedParents.size).toBe(0)
})
