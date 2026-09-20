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
    // The rows are identified by `role="option"` rather than by subtracting
    // known footer labels. The label list was the first version and it was a
    // bad oracle twice over: it carried entries ('Apply', 'Save') that no
    // dialog under test renders, and it matched with `startsWith`, so a row
    // whose title began with "Pin" or "Done" would have been silently dropped
    // from the assertion instead of failing it.
    const rows = Array.from(screen.getByRole('dialog').querySelectorAll('[role="option"]'))

    expect(rows.length).toBeGreaterThan(0)
    rows.forEach(row => expect(row.getAttribute('tabindex')).toBe('-1'))
  })

  it('Reorder Tabs keeps its per-row Move controls TABBABLE', () => {
    // The carve-out, asserted rather than merely argued for in a comment: the
    // Move up / Move down buttons NAME their target ("Move B up"), so acting
    // on the focused one is unambiguous and they are the dialog's only mouse
    // affordance that a keyboard user can also reach. Until this test,
    // `tabIndex={-1}` could be added to them and nothing in the suite noticed
    // — the invariant the PR argued hardest for had no coverage at all.
    reorderHarness()
    const moves = Array.from(screen.getByRole('dialog').querySelectorAll('button'))
      .filter(button => (button.getAttribute('aria-label') ?? '').startsWith('Move '))

    expect(moves.length).toBe(4)
    moves.forEach(move => expect(move.getAttribute('tabindex')).toBeNull())
  })

  it.each([
    { what: 'Agent View Mode', mount: viewModeHarness },
    { what: 'Reorder Tabs', mount: reorderHarness },
    { what: 'Pin Agents', mount: pinHarness },
  ])('$what announces the highlight it no longer focuses: $what', ({ mount }) => {
    // Taking the rows out of the tab order is half of the roving-focus
    // pattern. `aria-activedescendant` is the other half, and without it a
    // screen-reader user lost the only signal they had: they could Tab through
    // the rows and hear each one before, and afterwards the highlight was a
    // CSS class and nothing else.
    mount()
    const list = screen.getByRole('listbox')
    const active = list.getAttribute('aria-activedescendant')

    expect(active).toBeTruthy()
    expect(list.querySelector(`#${CSS.escape(active!)}`)).not.toBeNull()
  })
})

describe('the guard asks which CONTROL has focus, not merely whether the target is the dialog (#867)', () => {
  // The mutation this exists for: replacing `focusedControlOwnsEnter(target)`
  // with `target !== currentTarget` passed the entire 938-test suite. Every
  // case above fires Enter either at Cancel or at the dialog root, and that
  // weaker predicate answers both identically — so nothing actually pinned
  // WHICH descendants own Enter. A dialog that bows out on any descendant
  // stops working the moment its Enter is pressed with a non-control in focus,
  // which is the ordinary case for a scroller or a wrapper div.
  it.each([
    { what: 'Agent View Mode', mount: viewModeHarness, acted: (h: { setSessionAgentViewModeOverride: ReturnType<typeof vi.fn> }) => h.setSessionAgentViewModeOverride },
  ])('$what still acts on Enter from a non-control descendant', ({ mount, acted }) => {
    const harness = mount()
    // The listbox is a plain <div>: it is a descendant, it is not a control,
    // and Enter aimed at it belongs to the dialog.
    const list = screen.getByRole('listbox')

    expect(fireEvent.keyDown(list, { key: 'Enter' })).toBe(false)

    expect(acted(harness as never)).toHaveBeenCalled()
  })
})

describe('a click must not hand the row the keyboard (#867 review)', () => {
  // `tabIndex={-1}` takes rows out of the TAB order and nothing else:
  // Chromium focuses a <button> on click regardless. A clicked row therefore
  // held DOM focus and owned every Enter afterwards, so the dialog's own Enter
  // bowed out for the rest of its life — after one mouse click, in dialogs
  // built for mixed mouse and keyboard use.
  //
  // happy-dom does not focus on click, so asserting the symptom directly would
  // pass vacuously. The structural property is what is pinned: the row cancels
  // mousedown, which is what keeps focus on the dialog in a real browser.
  it.each([
    { what: 'Agent View Mode', mount: viewModeHarness },
    { what: 'Reorder Tabs', mount: reorderHarness },
    { what: 'Pin Agents', mount: pinHarness },
  ])('$what rows cancel mousedown so focus stays on the dialog', ({ mount }) => {
    mount()
    const rows = Array.from(screen.getByRole('dialog').querySelectorAll('[role="option"]'))

    expect(rows.length).toBeGreaterThan(0)
    // `fireEvent.mouseDown(...) === false` is the default being prevented.
    rows.forEach(row => expect(fireEvent.mouseDown(row)).toBe(false))
  })
})

describe('Pin Sessions: the dialog keeps the keys it advertises (#867 review)', () => {
  it('opens with focus on the dialog, not on Cancel', () => {
    // Radix's FocusScope focuses the first TABBABLE node on mount. Once the
    // rows left the tab order that node was CANCEL, so the very first Enter —
    // the one the dialog's own description calls "commit" — cancelled and
    // discarded the pins. The two sibling dialogs already prevented this with
    // `onOpenAutoFocus`; this one did not.
    const { onConfirm, onCancel } = pinHarness()

    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    // And the advertised key works from that starting point, with no rescue
    // gesture in between.
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Enter' })).toBe(false)
    expect(onConfirm).toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('does not toggle a pin when Space presses a focused button', () => {
    // Space is a button's activation key, and this dialog `preventDefault`s it
    // to toggle the highlighted row. With Cancel focused that meant Cancel did
    // nothing AND a pin the user was not looking at silently changed.
    const { onConfirm } = pinHarness()
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    expect(fireEvent.keyDown(cancel, { key: ' ' })).toBe(true)

    // Nothing toggled: the initial selection is still what commits.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith(['a'])
  })

  it('still toggles the highlighted row on Space from the dialog', () => {
    // The control: "Space never toggles" would satisfy the case above and
    // break the dialog's only selection gesture.
    const { onConfirm } = pinHarness()
    const dialog = screen.getByRole('dialog')

    fireEvent.keyDown(dialog, { key: ' ' })
    fireEvent.keyDown(dialog, { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith([])
  })
})

describe('Reorder Tabs: the ↑/↓ buttons leave the dialog usable (#867 review)', () => {
  // These buttons only became Enter-activatable with #867's guard, so what
  // happens right after one fires is new behaviour this PR is responsible for.
  it('moves the picked marker with the row it moved', () => {
    // Otherwise the accent "moving" paint stays on the row the user picked
    // earlier while the move happens elsewhere, and the NEXT arrow key moves
    // the wrong row — the exact confusion the two-phase model exists to stop.
    // A row CLICK already carried the marker; the buttons did not.
    const { onConfirm } = reorderHarness()
    const dialog = screen.getByRole('dialog')

    // Pick A (cursor starts on the first row), then move B up with its button.
    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Move B up' }))
    // The marker now names B, so the arrow moves B back down rather than
    // dragging A around behind the user's back.
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    fireEvent.keyDown(dialog, { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith(['a', 'b'])
  })

  it('hands focus back to the dialog after a move that disables the button', () => {
    // A move can disable the button that performed it (the row is now at an
    // end). A disabled control keeps focus while dropping out of the event
    // path, so real keys reached neither the button nor the dialog's ancestor
    // handler: arrows and Enter went dead in the middle of a reorder.
    reorderHarness()
    const up = screen.getByRole('button', { name: 'Move B up' })
    // Focus has to be ON the button first, the way a real Tab-then-Enter or a
    // real click leaves it. `fireEvent.click` alone moves no focus in
    // happy-dom, so asserting the end state without this passed while the
    // dialog still had focus from mount — the test would have been green on
    // the broken code, which is the failure mode this whole file is about.
    up.focus()
    expect(document.activeElement).toBe(up)

    fireEvent.click(up)

    expect(up).toBeDisabled()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
})
