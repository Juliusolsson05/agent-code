import { describe, expect, it } from 'vitest'

import { activeBindingContexts } from '@renderer/workspace/tile-tree/useKeybinds'

// Which binding contexts are live for one keyboard event.
//
// WHY this is worth its own file rather than being observed through the router:
// the function is a pure map from three booleans to a set, and the defect it
// exists to prevent (#697) is a MEMBERSHIP question, not a routing one. Driving
// the whole `useKeybinds` hook to assert set membership would bury the contract
// under a DOM harness and make a failure say "a keystroke did the wrong thing"
// rather than "the wrong context was live".
//
// The seam is the export itself. It could be removed if the router ever exposed
// its resolved context set for a synthetic event.

describe('activeBindingContexts', () => {
  const contexts = (input: Partial<Parameters<typeof activeBindingContexts>[0]>) =>
    activeBindingContexts({
      dispatchMode: false,
      editorOwnsTarget: false,
      feedFocused: false,
      ...input,
    })

  it('always includes global', () => {
    expect(contexts({}).has('global')).toBe(true)
  })

  it('makes exactly one of grid and dispatch live for the current layout', () => {
    // They are mutually exclusive by construction, which is what lets the
    // overlap matrix declare them disjoint and legally share chords.
    expect(contexts({ dispatchMode: false }).has('grid')).toBe(true)
    expect(contexts({ dispatchMode: false }).has('dispatch')).toBe(false)
    expect(contexts({ dispatchMode: true }).has('dispatch')).toBe(true)
    expect(contexts({ dispatchMode: true }).has('grid')).toBe(false)
  })

  it('drops the layout context entirely while a text editor owns the target', () => {
    // #697. `grid` and `dispatch` describe which WORKSPACE SURFACE owns the
    // keyboard. When Monaco owns the target it owns the keyboard, so neither is
    // live — otherwise a workspace chord is matched, preventDefault()ed, and
    // invoked while the user is typing, and the editor never sees the key.
    //
    // Concretely: Cmd+Alt+Down is Monaco's Add Cursor Below. With `dispatch`
    // live it would move Dispatch row focus instead and add no cursor.
    const inEditor = contexts({ dispatchMode: true, editorOwnsTarget: true })

    expect(inEditor.has('dispatch')).toBe(false)
    expect(inEditor.has('grid')).toBe(false)
    expect(inEditor.has('editor')).toBe(true)
  })

  it('keeps global live in the editor', () => {
    // Deliberate: top-level app commands are not workspace navigation, and a
    // user typing in a file still expects the app's own chords to work.
    expect(contexts({ editorOwnsTarget: true }).has('global')).toBe(true)
  })

  it('adds feed only when a feed is focused', () => {
    expect(contexts({ feedFocused: true }).has('feed')).toBe(true)
    expect(contexts({ feedFocused: false }).has('feed')).toBe(false)
  })
})
