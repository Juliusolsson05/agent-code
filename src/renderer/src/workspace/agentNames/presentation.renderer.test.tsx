import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DispatchAgentList } from '@renderer/workspace/dispatch/DispatchAgentList'
import type { DispatchAgentRow, DispatchTabGroup } from '@renderer/workspace/dispatch/dispatchSelectors'
import { AgentTitleHeader } from '@renderer/workspace/tile-tree/AgentTitleHeader'

// Mock only the Zustand transport boundary, exactly as the color-flag layout
// tests do: the real store's persist middleware is unrelated to what changes
// here, and one shared state object makes the header and the index fail
// together if they ever disagree about the selector's inputs.
const appState = vi.hoisted(() => ({
  settings: { agentNamesEnabled: true, dispatchColorFlags: {} as Record<string, string> },
  workspaceState: { sessions: {} as Record<string, { cwd: string; kind: string; agentNameId?: string }> },
  workspaceAgentNames: {} as Record<string, string>,
  workspaceRuntimes: {} as Record<string, unknown>,
  setDispatchColorFlag: vi.fn(),
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))

const AGENT = 'session-agent'
const SHELL = 'session-shell'

function seed(): void {
  appState.settings.agentNamesEnabled = true
  appState.workspaceState.sessions = {
    [AGENT]: { cwd: '/recorded', kind: 'claude', agentNameId: 'identity-one' },
    [SHELL]: { cwd: '/recorded', kind: 'terminal', agentNameId: 'identity-two' },
  }
  appState.workspaceAgentNames = { 'identity-one': 'Apollo', 'identity-two': 'Jasper' }
}

function row(sessionId: string, label: string, kind: 'claude' | 'terminal'): DispatchAgentRow {
  return {
    key: `tab-a:grid:${sessionId}`,
    label,
    globalIndex: Number(label.slice(1)),
    tabId: 'tab-a',
    tabTitle: 'Agent Code',
    tabIndex: 0,
    sessionId,
    kind,
    title: `${label} workflow`,
    placement: 'grid',
    depth: 0,
  }
}

function group(): DispatchTabGroup {
  return {
    tab: { id: 'tab-a', title: 'Agent Code', root: { type: 'leaf', sessionId: AGENT }, focusedSessionId: AGENT },
    tabIndex: 0,
    rows: [row(AGENT, 'A1', 'claude'), row(SHELL, 'A2', 'terminal')],
  }
}

function renderIndex() {
  return render(
    <DispatchAgentList
      groups={[group()]}
      pinnedRows={[]}
      activeSessionId={AGENT}
      dispatchScope="project"
      focusSessionInTab={vi.fn()}
      showWorktreeBadges={false}
    />,
  )
}

afterEach(() => {
  appState.workspaceAgentNames = {}
  appState.workspaceState.sessions = {}
  appState.settings.dispatchColorFlags = {}
})

describe('agent name presentation', () => {
  it('shows the name beside the title in the shared agent header', () => {
    seed()
    const { container } = render(<AgentTitleHeader sessionId={AGENT} title="Investigate queue race" />)

    const badge = container.querySelector('[data-agent-name-badge="true"]')
    expect(badge).toHaveTextContent('Apollo')
    expect(container.querySelector('[data-agent-title-header="true"]')).toHaveTextContent('Investigate queue race')
  })

  it('still renders the header for a named agent that has no title', () => {
    // WHY: the header previously returned null without a title. A user who
    // enabled names and never titles their agents would otherwise see nothing,
    // and the operator could address an agent the user cannot see named.
    seed()
    const { container } = render(<AgentTitleHeader sessionId={AGENT} />)
    expect(container.querySelector('[data-agent-name-badge="true"]')).toHaveTextContent('Apollo')
  })

  it('names a shell in the shared header (#865)', () => {
    seed()
    const { container } = render(<AgentTitleHeader sessionId={SHELL} />)
    expect(container.querySelector('[data-agent-name-badge="true"]')).toHaveTextContent('Jasper')
  })

  it('renders nothing at all while the setting is off', () => {
    seed()
    appState.settings.agentNamesEnabled = false
    const { container } = render(<AgentTitleHeader sessionId={AGENT} title="Investigate queue race" />)
    expect(container.querySelector('[data-agent-name-badge="true"]')).toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toHaveTextContent('Investigate queue race')
  })

  it('holds the row open for an agent whose name has not arrived yet', () => {
    // WHY this matters far beyond a blank badge: a name arrives over IPC well
    // after the pane mounts. When the row's EXISTENCE depended on the name,
    // every named agent pane grew ~23px mid-life on every window load, shrank
    // the terminal box, refit, and sent a second PTY resize as a SIGWINCH into
    // a live, mid-output TUI. The TUI's redraw then erased a line count
    // computed for the pre-resize frame and left garbled fragments in the
    // scrollback permanently. Reserving the box removes the resize.
    seed()
    appState.workspaceAgentNames = {}
    const { container } = render(<AgentTitleHeader sessionId={AGENT} />)

    expect(container.querySelector('[data-agent-title-header="true"]')).not.toBeNull()
    const placeholder = container.querySelector('[data-agent-name-placeholder="true"]')
    expect(placeholder).not.toBeNull()
    // It must not be readable or addressable as a name: an operator resolving
    // agents by name must never match a pane that has none yet.
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('[data-agent-name-badge="true"]')).toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toHaveTextContent('')
  })

  it('holds the row open for a shell whose name has not arrived yet', () => {
    // Same SIGWINCH hazard as agents: a row appearing mid-life would resize the
    // live shell and garble a TUI running in it (vim, htop).
    seed()
    appState.workspaceAgentNames = {}
    const { container } = render(<AgentTitleHeader sessionId={SHELL} />)
    expect(container.querySelector('[data-agent-name-placeholder="true"]')).not.toBeNull()
  })

  it('reserves nothing while the setting is off, so unnamed users lose no space', () => {
    seed()
    appState.workspaceAgentNames = {}
    appState.settings.agentNamesEnabled = false
    const { container } = render(<AgentTitleHeader sessionId={AGENT} />)
    expect(container.firstChild).toBeNull()
  })

  it('chips the name on every Dispatch row, shells included', () => {
    seed()
    const { container } = renderIndex()

    const rows = container.querySelectorAll<HTMLElement>('[data-dispatch-row="true"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('[data-dispatch-agent-name="true"]')).toHaveTextContent('Apollo')
    expect(rows[1].querySelector('[data-dispatch-agent-name="true"]')).toHaveTextContent('Jasper')
    // The title must keep its own truncation slot; the chip is a sibling, not
    // a prefix inside the truncating span.
    expect(rows[0]).toHaveTextContent('A1 workflow')
    // The hover tooltip joins name and title the same way AgentTitleHeader
    // does. The truncating title is exactly what a narrow index hides, so a
    // tooltip that omitted the name answered "what is this agent called"
    // differently from the pane header showing the same agent.
    expect(rows[0].getAttribute('title')).toBe('Apollo — A1 workflow')
    expect(rows[1].getAttribute('title')).toBe('Jasper — A2 workflow')
  })

  it('drops every Dispatch chip when the setting is off', () => {
    seed()
    appState.settings.agentNamesEnabled = false
    const { container } = renderIndex()
    expect(container.querySelectorAll('[data-dispatch-agent-name="true"]')).toHaveLength(0)
  })
})
