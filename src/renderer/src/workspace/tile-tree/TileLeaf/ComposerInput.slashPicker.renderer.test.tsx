import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SlashPickerState } from '@renderer/session-runtime/state'
import { ComposerInput } from '@renderer/workspace/tile-tree/TileLeaf/ComposerInput'
import type { SessionId } from '@renderer/workspace/types'

// Claude's slash picker, as a screen reader meets it (plan k2 invariant,
// ledger N12).
//
// Focus never leaves the composer while CC's picker is open: every key goes to
// the PTY and CC moves the highlight. So the FOCUSED textarea is what has to
// point at the list and at the highlighted row. Before this the listbox was
// only a sibling, and a moving highlight was silent.
//
// Fixture provenance: hand-built in the parser's output shape
// (SlashPickerParser → SlashPickerState). No slash-picker screen recording
// exists in the repo, and this component consumes only the parsed state, so
// the shape, not the screen, is the contract here.

function picker(selected: number): SlashPickerState {
  return {
    visible: true,
    items: ['/review', '/compact', '/mcp'].map((label, index) => ({
      id: label,
      label,
      description: `${label.slice(1)} command`,
      selected: index === selected,
    })),
  }
}

function composer(pickerState: SlashPickerState | null) {
  return (
    <ComposerInput
      sessionId={'s1' as SessionId}
      inputRef={{ current: null }}
      input="/"
      focused
      slashMode
      provider="claude"
      draftImages={[]}
      pickerState={pickerState}
      historyIndex={null}
      history={[]}
      setInputText={() => {}}
      endHistoryCycle={() => {}}
      onKeyDown={() => {}}
      onPaste={() => {}}
      onFocusRequest={() => {}}
      onUserEngagement={() => {}}
      onHoverChange={() => {}}
      removeDraftImage={() => {}}
      dictation={{ enabled: false, busy: false, status: 'idle', levels: [], handleShortcut: () => false } as never}
      promptSuggestion={null}
      onApplySuggestion={() => {}}
      onDismissSuggestion={() => {}}
      promptDelivery={{ kind: 'idle' } as never}
      onResolveUncertainDelivery={() => {}}
    />
  )
}

const renderComposer = (pickerState: SlashPickerState | null) => render(composer(pickerState))

describe('ComposerInput slash picker linkage', () => {
  it('points the focused textarea at the list and at CC s highlighted row', () => {
    const view = renderComposer(picker(1))
    const textarea = screen.getByRole('textbox')
    const list = screen.getByRole('listbox', { name: 'Slash commands' })
    expect(textarea.getAttribute('aria-controls')).toBe(list.id)
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list')
    const active = document.getElementById(textarea.getAttribute('aria-activedescendant')!)
    expect(active).toBe(screen.getByRole('option', { name: /\/compact/ }))

    // CC moves the highlight; the SAME textarea's pointer follows it.
    view.rerender(composer(picker(2)))
    expect(screen.getByRole('textbox')).toBe(textarea)
    expect(document.getElementById(textarea.getAttribute('aria-activedescendant')!)?.textContent).toContain('/mcp')
  })

  it('drops the linkage when the picker is closed', () => {
    renderComposer(null)
    const textarea = screen.getByRole('textbox')
    expect(textarea.hasAttribute('aria-controls')).toBe(false)
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false)
  })
})
