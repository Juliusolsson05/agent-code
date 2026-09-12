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

// Regression net for #858. A persisted related selection can mount a CHILD
// agent's raw TUI under the PARENT's pane label, with nothing marking it and
// no way back. These tests pin the pane-level contract: the existing status
// row names the displayed related agent (relation + label) and offers a
// `parent` button back to the owner, and neither appears when the pane is
// simply showing its own agent. See AgentTerminalLeaf.statusHeader for the
// #851 regression net this file's mocks/beforeEach/afterEach are copied from
// (verbatim, lines 1-117).

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

describe('AgentTerminalLeaf related-agent identity (#858)', () => {
  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace
  const tabs = [{ sessionId: 'child', relation: 'orchestration' as const, label: 'worker-2', title: 'Tests', kind: 'codex' as const, placement: 'grid' as const }]

  function leaf(renderedSessionId: string, onSelect = vi.fn()) {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId={renderedSessionId}>
          <AgentTerminalLeaf
            sessionId={renderedSessionId}
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={withStatus('idle')}
            projectDir="/tmp/project"
            provider="codex"
            showStatusMode
            ownerSessionId="parent"
            relatedAgentTabs={tabs}
            onSelectRelatedSession={onSelect}
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>
    )
  }

  it('names the related agent in the status row and returns to the parent', () => {
    // The chip row is not used: every header row is taken out of the PTY,
    // so chips appearing when a child spawns would resize the live TUI. The
    // one-line status row carries the answer instead.
    const onSelect = vi.fn()
    const { container, getByRole } = render(leaf('child', onSelect))
    expect(statusRow(container)).toHaveTextContent('orchestration worker-2')
    getByRole('button', { name: 'parent' }).click()
    expect(onSelect).toHaveBeenCalledWith('parent')
  })

  it('adds nothing while the pane shows its own agent', () => {
    const { container, queryByRole } = render(leaf('parent'))
    expect(statusRow(container)).not.toHaveTextContent('worker-2')
    expect(queryByRole('button', { name: 'parent' })).toBeNull()
  })
})
