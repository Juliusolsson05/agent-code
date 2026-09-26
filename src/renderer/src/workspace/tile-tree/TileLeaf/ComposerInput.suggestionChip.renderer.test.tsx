import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ComposerInput } from '@renderer/workspace/tile-tree/TileLeaf/ComposerInput'
import type { SessionId } from '@renderer/workspace/types'

// The suggestion chip's "⇥ fill" hint is wired by ComposerInput, not by the
// chip itself (review C, PR #1221: flipping the `tabFills` expression survived
// every existing test, because the chip's own suite passes the flag directly).
//
// The hint must appear exactly when useComposerKeybinds' Tab branch would
// really fill the draft: an empty draft, not slash mode (Tab completes the
// picker there), and not OpenCode (Tab cycles agents). A chip shown in any
// other state promises a key that does something else (H2). If the Tab
// branch's conditions change, this table and the `tabFills` expression change
// with it.

function composer(overrides: { input?: string; slashMode?: boolean; provider?: 'claude' | 'codex' | 'opencode' }) {
  return (
    <ComposerInput
      sessionId={'s1' as SessionId}
      inputRef={{ current: null }}
      input={overrides.input ?? ''}
      focused
      slashMode={overrides.slashMode ?? false}
      provider={overrides.provider ?? 'claude'}
      draftImages={[]}
      pickerState={null}
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
      promptSuggestion="run the tests"
      onApplySuggestion={() => {}}
      onDismissSuggestion={() => {}}
      promptDelivery={{ kind: 'idle' } as never}
      onResolveUncertainDelivery={() => {}}
    />
  )
}

const tabChip = () => document.querySelector('[data-slot="kbd"]')

describe('ComposerInput suggestion chip Tab hint', () => {
  it('shows ⇥ fill on an empty Claude draft, where Tab really fills', () => {
    render(composer({}))
    expect(tabChip()?.textContent).toBe('⇥')
  })

  it.each([
    ['a non-empty draft (Tab does nothing)', { input: 'half a thought' }],
    // Slash mode sends the `/` and every later key to the PTY (the picker
    // lives in CC), so the textarea draft is EMPTY here: the empty-draft
    // check alone would wrongly show the hint.
    ['slash mode (Tab completes the picker)', { input: '', slashMode: true }],
    ['OpenCode (Tab cycles agents)', { provider: 'opencode' as const }],
  ])('hides the hint with %s', (_label, overrides) => {
    render(composer(overrides))
    expect(document.body.textContent).toContain('run the tests')
    expect(tabChip()).toBeNull()
  })
})
