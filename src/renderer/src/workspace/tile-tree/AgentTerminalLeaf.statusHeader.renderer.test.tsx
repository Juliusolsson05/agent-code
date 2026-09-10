import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'

// Regression net for #851. A terminal-view agent pane used to draw its own copy
// of the header, so the Status Mode fill and the color flag never reached it: a
// turn started from the raw TUI ran under a header that read as idle. These
// tests pin the pane-level contract, not PaneHeader's internals. Whatever the
// terminal leaf renders, its header must reflect the same liveness and flag
// state a rendered pane shows for the same runtime. The assertions read the
// `data-*` hooks PaneHeader exposes instead of Tailwind class names, so a
// restyle can't pass or fail them by accident.

const settings = vi.hoisted(() => ({
  dictationEnabled: false,
  dictationProvider: 'local',
  dictationShortcut: 'off',
  mouseModeEnabled: false,
  dispatchColorFlags: {} as Record<string, string>,
}))

vi.mock('@renderer/workspace/terminal/xtermWebglRenderer', () => ({
  attachXtermWebglRenderer: () => ({ ready: Promise.resolve(true), dispose: () => {} }),
}))

// Header state is independent of the PTY, so the terminal only needs to
// satisfy the mount effect's calls. Nothing here is asserted.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120
    rows = 40
    options: Record<string, unknown> = {}
    dispose() {}
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    scrollToBottom() {}
    scrollToLine() {}
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} },
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings, tailAllMode: false, workspaceRuntimes: {} }),
}))

vi.mock('@renderer/app-state/settings/theme', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  THEME_CHANGED_EVENT: 'agent-code:test-theme-change',
  getActiveAppFontFamily: () => 'monospace',
}))

vi.mock('@renderer/workspace/tile-tree/xtermTheme', () => ({
  readXtermTheme: () => ({}),
  syncXtermTheme: () => {},
}))

vi.mock('@renderer/workspace/tile-tree/TileLeaf/useComposerDictation', () => ({
  useComposerDictation: () => {},
}))

describe('AgentTerminalLeaf status header', () => {
  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace

  function leaf(runtime: SessionRuntime, showStatusMode: boolean) {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId="session-1">
          <AgentTerminalLeaf
            sessionId="session-1"
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={runtime}
            projectDir="/tmp/project"
            provider="claude"
            showStatusMode={showStatusMode}
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>
    )
  }

  const withStatus = (sessionStatus: SessionRuntime['sessionStatus']): SessionRuntime =>
    ({ ...emptyRuntime(), processStatus: 'started', sessionStatus })

  function statusRow(container: HTMLElement): Element {
    const row = container.querySelector('[data-pane-header-row="true"]')
    if (!row) throw new Error('terminal-view pane rendered no status row')
    return row
  }

  beforeEach(() => {
    settings.dispatchColorFlags = {}
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class {
      disconnect() {}
      observe() {}
      unobserve() {}
    })
    // Attach never settles: the header must not wait on the PTY, and a
    // pending attach keeps the mount effect from issuing wake or toast calls
    // this suite doesn't care about.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        attachAgentPty: () => new Promise(() => {}),
        detachAgentPty: () => Promise.resolve(),
        onSessionAgentPtyData: () => () => {},
        onSessionTerminalData: () => () => {},
        resize: () => Promise.resolve(),
        sendInput: () => Promise.resolve(),
      },
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
    vi.unstubAllGlobals()
  })

  it('lights the header while the agent runs and clears it when the agent goes idle', () => {
    const { container, rerender } = render(leaf(withStatus('running'), true))
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('true')

    // Negative half: a header stuck lit is the same lie in the other
    // direction, and a leaf that only reads status at mount would pass the
    // first assertion alone.
    rerender(leaf(withStatus('idle'), true))
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('false')
  })

  it('leaves the header unlit while running when Status Mode is off', () => {
    // Status Mode is a user setting. Terminal view must honor it the same
    // way rendered panes do, rather than lighting unconditionally.
    const { container } = render(leaf(withStatus('running'), false))
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('false')
  })

  it('paints the session color flag in terminal view', () => {
    // Same drift as the status fill: the flag came to PaneHeader after the
    // terminal header was copied, so flagging a pane and then switching it to
    // Terminal view made the flag disappear.
    settings.dispatchColorFlags = { 'session-1': 'red' }
    const { container } = render(leaf(withStatus('idle'), true))
    expect(container.querySelector('[data-pane-color-flag="red"]')).not.toBeNull()
  })
})
