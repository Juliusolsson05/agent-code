import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentInlineTerminal } from './AgentInlineTerminal'

// #1311 round 2 (review A): main counts raw PTY references per page and
// session, not per view. A retained pane (hidden by Settings or Reader, never
// unmounted) and the debug inline terminal share one count. If the debug
// terminal detached an attach that main REFUSED (null: no backend, as after a
// provider exit), it released the pane's reference, and the pane froze on the
// next same-id wake. So a view releases only what it took.

vi.mock('@renderer/workspace/terminal/xtermWebglRenderer', () => ({
  attachXtermWebglRenderer: () => ({ ready: Promise.resolve(true), dispose: () => {} }),
}))
vi.mock('@renderer/workspace/terminal/terminalWheelBoundary', () => ({
  attachTerminalWheelBoundary: () => ({ dispose: () => {} }),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120
    rows = 40
    options: Record<string, unknown> = {}
    dispose() {}
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@renderer/app-state/settings/theme', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  THEME_CHANGED_EVENT: 'agent-code:test-theme-change',
  getActiveAppFontFamily: () => 'monospace',
}))
vi.mock('@renderer/workspace/tile-tree/xtermTheme', () => ({
  readXtermTheme: () => ({}),
  syncXtermTheme: () => {},
}))

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

function installApi(attachResult: () => Promise<string | null>) {
  const api = {
    attachAgentPty: vi.fn(attachResult),
    detachAgentPty: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
    onSessionAgentPtyData: vi.fn(() => () => {}),
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

afterEach(() => {
  cleanup()
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

describe('AgentInlineTerminal raw PTY reference', () => {
  it('does not release a reference main refused', async () => {
    const api = installApi(() => Promise.resolve(null))
    const view = render(<AgentInlineTerminal sessionId="pane" active />)
    await vi.waitFor(() => expect(api.attachAgentPty).toHaveBeenCalled())
    await Promise.resolve()
    view.unmount()
    expect(api.detachAgentPty).not.toHaveBeenCalled()
  })

  it('releases a reference it took', async () => {
    const api = installApi(() => Promise.resolve('replay'))
    const view = render(<AgentInlineTerminal sessionId="pane" active />)
    await vi.waitFor(() => expect(api.attachAgentPty).toHaveBeenCalled())
    await Promise.resolve()
    view.unmount()
    expect(api.detachAgentPty).toHaveBeenCalledTimes(1)
  })

  // Main takes the reference when its handler runs, which can be before an
  // unmount whose cleanup then finds nothing attached yet.
  it('releases a reference that lands after it unmounted', async () => {
    let land!: (buffer: string | null) => void
    const api = installApi(() => new Promise(resolve => { land = resolve }))
    const view = render(<AgentInlineTerminal sessionId="pane" active />)
    await vi.waitFor(() => expect(api.attachAgentPty).toHaveBeenCalled())
    view.unmount()
    expect(api.detachAgentPty).not.toHaveBeenCalled()
    land('replay')
    await vi.waitFor(() => expect(api.detachAgentPty).toHaveBeenCalledTimes(1))
  })
})
