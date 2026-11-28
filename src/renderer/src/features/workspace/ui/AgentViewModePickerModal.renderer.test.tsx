import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'

import { AgentViewModePickerModal } from './AgentViewModePickerModal'

// Agent View Mode on the shared list hook and dialog anatomy (plan S4).
// #867 Enter ownership is pinned in focusedCancelEnter.

function harness() {
  const setSessionAgentViewModeOverride = vi.fn(() => true)
  const workspace = {
    state: { sessions: { agent: { cwd: '/repo', kind: 'claude', projectId: 'tab', joinedAt: 0 } } },
    setSessionAgentViewModeOverride,
  } as unknown as Workspace
  render(<AgentViewModePickerModal open sessionId="agent" workspace={workspace} globalMode="agent" onClose={() => {}} />)
  return { setSessionAgentViewModeOverride }
}

describe('Agent View Mode picker', () => {
  it('focuses the listbox that announces the highlight, starting on the current mode', () => {
    harness()
    const listbox = screen.getByRole('listbox')
    expect(document.activeElement).toBe(listbox)
    expect(listbox.getAttribute('aria-activedescendant')).toBe('agent-view-mode-0')
  })

  it('jumps to the last mode with End and applies it with Enter', () => {
    const { setSessionAgentViewModeOverride } = harness()
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'End' })
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(setSessionAgentViewModeOverride).toHaveBeenCalledWith('agent', 'terminal')
  })

  it('offers an Apply button that says Enter applies, beside Cancel ⎋', () => {
    const { setSessionAgentViewModeOverride } = harness()
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply.querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    fireEvent.click(apply)
    expect(setSessionAgentViewModeOverride).toHaveBeenCalledWith('agent', 'agent')
  })

  it.each([undefined, 'terminal'] as const)('offers both agy views for runtime %s', providerRuntime => {
    const setter = vi.fn(async () => 'replacement')
    const workspace = {
      state: { sessions: { agent: { cwd: '/repo', kind: 'antigravity', providerRuntime } } },
      setSessionAgentViewModeOverride: setter,
    } as unknown as Workspace
    render(<AgentViewModePickerModal open sessionId="agent" workspace={workspace} globalMode="terminal" onClose={() => {}} />)
    const next = providerRuntime ? 'Agent' : 'Terminal'
    fireEvent.click(screen.getByRole('option', { name: new RegExp('^' + next + ' ') }))
    expect(setter).toHaveBeenCalledWith('agent', next.toLowerCase())
  })

  it('explains the Hermes chat surface', () => {
    const workspace = {
      state: { sessions: { agent: { cwd: '/repo', kind: 'hermes', projectId: 'tab', joinedAt: 0 } } },
      setSessionAgentViewModeOverride: vi.fn(() => true),
    } as unknown as Workspace
    render(<AgentViewModePickerModal open sessionId="agent" workspace={workspace} globalMode="terminal" onClose={() => {}} />)
    expect(screen.getByText('Hermes has no native terminal; it always uses Agent Code rendering.')).toBeTruthy()
    expect(screen.queryByText(/Choose OpenCode Terminal/)).toBeNull()
  })
})
