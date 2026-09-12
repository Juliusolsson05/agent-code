import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'
import { renderWorkspaceLeaf } from './TileTree'

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

  it('lights the header while the agent runs and clears it when the agent goes idle', () => {
    const { container, rerender } = render(leaf(withStatus('running'), true))
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('true')

    // Negative half: a header stuck lit is the same lie in the other
    // direction, and a leaf that only reads status at mount would pass the
    // first assertion alone.
    rerender(leaf(withStatus('idle'), true))
    expect(statusRow(container).getAttribute('data-status-lit')).toBe('false')
  })

  it('shows a transcript diagnostic inside the pane, and clears it when it resolves', () => {
    // #894 / feature E. The TUI can switch session under us — /new, /sessions,
    // a fork — and this pane goes on following the session it launched with.
    // Agent Status and the Dispatch row report that, but BOTH can be closed,
    // and this pane is the one the user is looking at. Testing the formatting
    // helper alone is exactly how this shipped invisible, so this mounts the
    // real leaf and reads the rendered text.
    const switched = {
      ...withStatus('idle'),
      transcriptError: 'OpenCode switched to session ses_new inside the TUI. This pane still follows ses_old.',
    }
    const { container, rerender } = render(leaf(switched, true))
    const banner = container.querySelector('[data-terminal-transcript-error="true"]')
    expect(banner?.textContent).toContain('ses_new')
    expect(banner?.textContent).toContain('still follows ses_old')
    // It must not swallow keyboard focus from the terminal.
    expect(banner?.querySelector('button, input, a, [tabindex]')).toBeNull()

    // The negative half: a banner that never clears would be its own lie, and
    // a leaf that only read the error at mount would pass the assertion above.
    rerender(leaf(withStatus('idle'), true))
    expect(container.querySelector('[data-terminal-transcript-error="true"]')).toBeNull()
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

// WHY a second suite that enters through renderWorkspaceLeaf: #851 wasn't a
// header bug, it was the setting never reaching the terminal branch of
// WorkspaceLeaf. The suite above mounts the leaf with an explicit prop, so it
// would stay green if that hop went back to a constant or a default. This
// suite pins that one hop (WorkspaceLeaf → AgentTerminalLeaf) at runtime.
//
// It does NOT cover the surface-level hops from #856 (MainSurface →
// Spotlight / Tiled Tabs → renderWorkspaceLeaf / TileTree). Those are guarded
// only by the required prop types under tsc; vitest doesn't type-check.
describe('terminal-view status header wiring', () => {
  function workspaceWith(runtime: SessionRuntime): Workspace {
    // `getRuntime` is the fallback useSessionRuntime reads when the store has
    // no entry for the session. The mocked store's `workspaceRuntimes` is
    // empty, so this runtime is the one the leaf sees. `tabs: []` makes the
    // pane label '?', which this suite doesn't assert on.
    return {
      state: { sessions: { 'session-1': { kind: 'claude', cwd: '/tmp/project' } }, tabs: [] },
      getRuntime: () => runtime,
      focusSessionInTab: vi.fn(),
      acknowledgeSession: vi.fn(),
      ensureSessionLive: vi.fn().mockResolvedValue(undefined),
      showPaneToast: vi.fn(),
    } as unknown as Workspace
  }

  it.each([true, false])('threads Status Mode=%s from the surface into a terminal-view pane', showStatusMode => {
    const workspace = workspaceWith(withStatus('running'))
    const { container } = render(
      <AgentTerminalOwnershipProvider>
        {renderWorkspaceLeaf('session-1', 'session-1', workspace, 'tab-1', 'terminal', showStatusMode, false)}
      </AgentTerminalOwnershipProvider>,
    )
    // Prove the terminal branch is what rendered. The rendered TileLeaf also
    // draws a PaneHeader with `data-status-lit`, so without this a routing
    // change could pass the assertion below without touching the wiring
    // under test.
    expect(screen.getByText('raw claude')).toBeTruthy()
    expect(statusRow(container).getAttribute('data-status-lit')).toBe(String(showStatusMode))
  })
})
