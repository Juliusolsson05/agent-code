import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentViewModePickerModal } from '@renderer/features/workspace/ui/AgentViewModePickerModal'
import { ReorderTabsModal } from '@renderer/features/workspace/ui/ReorderTabsModal'
import { PinAgentsModal } from '@renderer/features/dispatch-pin/PinAgentsModal'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// #867. Three list dialogs handled Enter on `DialogContent`, called
// `preventDefault` — which cancels the focused button's native click — and ran
// the LIST's action instead. So Tab to Cancel, Enter, and the change you were
// abandoning was applied: a view-mode override, a tab reorder, an unpinning.
//
// The rule `dialog-actions.tsx` documents is that a focused footer button owns
// its own Enter, and #860 exported `focusedControlOwnsEnter` for exactly this.
// #862 fixed the same bug in Switch Provider; these are the three the audit of
// all 36 `DialogContent` consumers found afterwards.
//
// `fireEvent.keyDown(...) === true` means the default was NOT prevented, which
// is what lets the real browser deliver the focused button's click. happy-dom
// does not synthesize that click, so "the handler did not act" and "the
// default survived" are asserted together — neither alone is the property.

function viewModeHarness() {
  const setSessionAgentViewModeOverride = vi.fn(() => true)
  const onClose = vi.fn()
  const workspace = {
    state: {
      sessions: { agent: { cwd: '/repo', kind: 'claude', projectId: 'tab', joinedAt: 0 } },
      tabs: [{ id: 'tab', title: 'Project' }],
      activeTabId: 'tab',
      stage: { lanes: [{ selectedSessionId: 'agent' }], rows: [{ length: 1 }], focusedLane: 0 },
      pinnedSessionIds: [],
    },
    setSessionAgentViewModeOverride,
  } as unknown as Workspace
  render(<AgentViewModePickerModal open sessionId="agent" workspace={workspace} globalMode="agent" onClose={onClose} />)
  return { setSessionAgentViewModeOverride, onClose }
}

function reorderHarness() {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ReorderTabsModal
      open
      tabs={[{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] as never}
      activeTabId={'a' as never}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  )
  return { onConfirm, onCancel }
}

function pinHarness() {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <PinAgentsModal
      open
      rows={[{ sessionId: 'a', title: 'A', kind: 'claude' }, { sessionId: 'b', title: 'B', kind: 'codex' }] as never}
      initialSelectedIds={['a'] as never}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  )
  return { onConfirm, onCancel }
}

describe('a focused footer button owns its own Enter (#867)', () => {
  it('Agent View Mode: Enter on Cancel does not apply the highlighted override', () => {
    const { setSessionAgentViewModeOverride, onClose } = viewModeHarness()
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true)

    expect(setSessionAgentViewModeOverride).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Reorder Tabs: Enter on Cancel does not commit the reorder being abandoned', () => {
    // The footer here is a plain `<div>`, not a `DialogFooter` — which is why
    // the check has to be on the focused CONTROL rather than on the slot.
    const { onConfirm, onCancel } = reorderHarness()
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true)

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Pin Agents: Enter on Cancel does not save the unpinning', () => {
    const { onConfirm, onCancel } = pinHarness()
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true)

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('the list still owns Enter when the list has focus (#867)', () => {
  // The control that makes the three above mean something: "Enter never acts"
  // would satisfy them too, and would break every one of these dialogs.
  it('Agent View Mode still applies the highlighted option', () => {
    const { setSessionAgentViewModeOverride } = viewModeHarness()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })

    expect(setSessionAgentViewModeOverride).toHaveBeenCalled()
  })

  it('Reorder Tabs still runs its whole two-phase model from the list', () => {
    // Enter picks, arrows move the picked tab, Enter commits. Asserted end to
    // end because "Enter entered move mode" is invisible from the outside,
    // and the reorder that comes out is the only thing that proves both
    // Enters were the list's.
    const { onConfirm } = reorderHarness()
    const dialog = screen.getByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    fireEvent.keyDown(dialog, { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith(['b', 'a'])
  })

  it('Pin Agents still commits the selection', () => {
    const { onConfirm } = pinHarness()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalled()
  })
})

describe('keyboard focus never rests on a list row (#867)', () => {
  // The other half of the fix, and the half Enter handling cannot cover:
  // Space clicks the FOCUSED control. A row that can be Tab-focused therefore
  // acts on a row other than the arrow-driven highlight the dialog is showing,
  // whatever the Enter branch does. happy-dom does not synthesize keyboard
  // clicks, so the structure is what makes the path impossible.
  it.each([
    { what: 'Agent View Mode', mount: viewModeHarness },
    { what: 'Reorder Tabs', mount: reorderHarness },
    { what: 'Pin Agents', mount: pinHarness },
  ])('$what keeps every row out of the tab order', ({ mount }) => {
    mount()
    const footer = ['Cancel', 'Done', 'Apply', 'Pin', 'Save']
    // Buttons with an `aria-label` are deliberately excluded: Reorder Tabs'
    // per-row Move up/Move down controls NAME their target ("Move B up"), so
    // acting on the focused one is unambiguous and they belong in the tab
    // order. The divergence this pins is a row whose meaning comes from the
    // highlight, not from its own label.
    const rows = Array.from(screen.getByRole('dialog').querySelectorAll('button'))
      .filter(button => !button.getAttribute('aria-label'))
      .filter(button => !footer.some(label => (button.textContent ?? '').trim().startsWith(label)))

    expect(rows.length).toBeGreaterThan(0)
    rows.forEach(row => expect(row.getAttribute('tabindex')).toBe('-1'))
  })
})
