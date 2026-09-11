import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { TerminalLeaf } from './TerminalLeaf'

// #865: plain terminals render the shared PaneHeader instead of a hand-drawn
// `terminal $` strip. Same drift #851 fixed for agent terminal views: every
// header feature added since April (cwd, color flag, title/name row, Status
// Mode) skipped the copy. Assertions read the data-* hooks PaneHeader exposes,
// never Tailwind classes.

const store = vi.hoisted(() => ({
  settings: {
    dictationEnabled: false,
    dictationProvider: 'local',
    dictationShortcut: 'off',
    agentNamesEnabled: false,
    dispatchColorFlags: {} as Record<string, string>,
  },
  tailAllMode: false,
  workspaceState: { sessions: {} as Record<string, { cwd: string; kind: string; title?: string }> },
  workspaceRuntimes: {} as Record<string, unknown>,
  workspaceAgentNames: {} as Record<string, string>,
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof store) => unknown) => selector(store),
}))
vi.mock('@renderer/workspace/terminal/xtermWebglRenderer', () => ({
  attachXtermWebglRenderer: () => ({ ready: Promise.resolve(true), dispose: () => {} }),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120
    rows = 40
    options: Record<string, unknown> = {}
    modes = { bracketedPasteMode: true }
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0 } }
    dispose() {}
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    scrollToBottom() {}
    scrollToLine() {}
    registerMarker() { return null }
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
vi.mock('@renderer/workspace/tile-tree/xtermTheme', () => ({ readXtermTheme: () => ({}), syncXtermTheme: () => {} }))
vi.mock('@renderer/workspace/tile-tree/TileLeaf/useComposerDictation', () => ({ useComposerDictation: () => {} }))

const workspace = {
  acknowledgeSession: vi.fn(),
  // Never settles: the header must not wait on the PTY.
  ensureSessionLive: vi.fn(() => new Promise(() => {})),
  showPaneToast: vi.fn(),
} as unknown as Workspace

function leaf(showStatusMode = true) {
  return (
    <TerminalLeaf
      sessionId="shell"
      paneLabel="A1"
      focused
      onFocusRequest={() => {}}
      workspace={workspace}
      showStatusMode={showStatusMode}
    />
  )
}

function statusRow(container: HTMLElement): Element {
  const row = container.querySelector('[data-pane-header-row="true"]')
  if (!row) throw new Error('plain terminal rendered no shared status row')
  return row
}

beforeEach(() => {
  store.workspaceState.sessions = { shell: { cwd: '/work/api', kind: 'terminal' } }
  store.workspaceRuntimes = {}
  store.settings.dispatchColorFlags = {}
  store.tailAllMode = false
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { disconnect() {} observe() {} unobserve() {} })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      attachTerminal: () => new Promise(() => {}),
      onSessionTerminalData: () => () => {},
      resize: () => Promise.resolve(),
      sendInput: () => Promise.resolve(true),
    },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
  vi.unstubAllGlobals()
})

describe('TerminalLeaf shared header', () => {
  it('renders the shared status row, the pane id hook and the spawn folder', () => {
    const { container } = render(leaf())
    expect(statusRow(container)).toHaveTextContent('terminal')
    expect(container.querySelector('[data-pane-id="shell"]')).not.toBeNull()
    expect(container.querySelector('[title="/work/api"]')).not.toBeNull()
  })

  it('names the foreground command and lights Status Mode while a command runs', () => {
    store.workspaceRuntimes = {
      shell: { sessionStatus: 'running', terminalForeground: { busy: true, command: 'npm', cwd: '/work/web', changedAt: 1 } },
    }
    const { container } = render(leaf())
    expect(statusRow(container)).toHaveTextContent('npm')
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('true')
    // Live cwd from tmux wins over the spawn cwd, so the header follows `cd`.
    expect(container.querySelector('[title="/work/web"]')).not.toBeNull()
  })

  it('honors Status Mode being off', () => {
    store.workspaceRuntimes = { shell: { sessionStatus: 'running', terminalForeground: null } }
    const { container } = render(leaf(false))
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('false')
  })

  it('shows the color flag and the title row', () => {
    store.settings.dispatchColorFlags = { shell: 'red' }
    store.workspaceState.sessions.shell.title = 'dev server'
    const { container } = render(leaf())
    expect(container.querySelector('[data-pane-color-flag="red"]')).not.toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toHaveTextContent('dev server')
  })

  it('shows the TAIL pill while auto-follow is on', () => {
    store.workspaceRuntimes = { shell: { tailMode: true } }
    const { container } = render(leaf())
    expect(statusRow(container)).toHaveTextContent('TAIL')
  })
})
