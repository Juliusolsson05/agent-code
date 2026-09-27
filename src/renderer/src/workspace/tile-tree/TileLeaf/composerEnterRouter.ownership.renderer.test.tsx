import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConditionOptionList } from '@providers/shared/renderer/conditions/ConditionOptionList'
import { ConditionPromptShell } from '@providers/shared/renderer/conditions/ConditionPromptShell'
import { PaneDialogHostProvider } from '@renderer/components/ui/pane-dialog'
import { registerComposerEnterTarget, submitActiveComposer } from '@renderer/workspace/tile-tree/TileLeaf/composerEnterRegistry'

// Who owns a document-level Enter when condition UI is on screen
// (Claude review of #1221, reviewer A, findings F1 and F3).
//
// F1: an inline approval option list is a role="listbox". The router treated
// ANY listbox in the document as an open popup, so one agent waiting on an
// approval disabled Enter-to-send and Submit Active Composer in every pane.
// F3: Enter aimed inside a pane prompt fell through to the router, which
// submitted another pane's hovered draft.
//
// Real components (the shared ConditionOptionList and ConditionPromptShell),
// real key events, and the registry TileLeaf uses.

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); cleanup() })

function paneB(init: { focused?: boolean; hovered?: boolean }) {
  const submit = vi.fn()
  cleanups.push(registerComposerEnterTarget({
    key: 'b', focused: init.focused ?? false, hovered: init.hovered ?? false,
    hasSubmittableDraft: () => true, focus: () => {}, submit,
  }))
  return submit
}

const approval = (
  <div data-pane-id="pane-a">
    <ConditionOptionList
      label="Approve command"
      options={[{ label: 'Yes' }, { label: 'No' }]}
      selectedIndex={0}
      marker="›"
      onChoose={() => {}}
    />
  </div>
)

describe('an inline approval list elsewhere (F1)', () => {
  it('does not disable Enter-to-send for the pane the user is in', () => {
    render(approval)
    const submit = paneB({ focused: true })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('does not disable Submit Active Composer either', () => {
    render(approval)
    paneB({ focused: true })
    expect(submitActiveComposer()).toBe(true)
  })

  it('still owns Enter while the user is IN the list', () => {
    render(approval)
    const submit = paneB({ focused: true })
    const list = screen.getByRole('listbox', { name: 'Approve command' })
    list.focus()
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    // The command path has no key target, so only the listbox rule stops it:
    // running Submit Active Composer while the user is in the list must not
    // send another pane's draft.
    expect(submitActiveComposer()).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })
})

function PromptInPaneA() {
  const [pane, setPane] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setPane} data-pane-id="pane-a" className="relative">
      <PaneDialogHostProvider container={pane} active restoreFocus={() => {}}>
        <ConditionPromptShell
          heading="OpenCode is asking"
          description="Answer to let the agent continue."
          actions={[{ kind: 'custom', id: 'dismiss', label: 'Dismiss', name: 'question.reject' }]}
          dispatch={async () => {}}
          isReject={action => action.label === 'Dismiss'}
        >
          <p>Which folder should I use?</p>
        </ConditionPromptShell>
      </PaneDialogHostProvider>
    </div>
  )
}

describe('Enter aimed inside a pane prompt (F3)', () => {
  it("never submits another pane's hovered draft", () => {
    render(<PromptInPaneA />)
    const dialog = screen.getByRole('dialog')
    dialog.focus()
    const submit = paneB({ hovered: true })
    // The pointer moves AFTER registration, so B's hover is the latest intent
    // (the registry orders hover against focus changes).
    fireEvent.pointerMove(document.body)
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
  })
})
