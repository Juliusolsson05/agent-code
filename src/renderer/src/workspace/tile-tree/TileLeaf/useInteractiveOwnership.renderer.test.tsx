import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { RetainedWorkspaceSurface } from '@renderer/app/shell/RetainedWorkspaceSurface'
import { GlobalEditorWorkspaceSlot } from '@renderer/features/global-editor/ui/GlobalEditorWorkspaceSlot'

import { useInteractiveOwnership } from './useInteractiveOwnership'

// #752 review: the source of truth for "may this pane own input" must be the
// composed visibility CONTEXT, scoped to the subtree — not a global store
// flag. A store flag made Spotlight's own (visible) leaf refuse Enter/y/n
// whenever the editor was fullscreen underneath.

function hook(wrapper?: (props: { children: ReactNode }) => JSX.Element) {
  return renderHook(() => useInteractiveOwnership(true), { wrapper }).result.current
}

describe('useInteractiveOwnership', () => {
  it('is interactive with no enclosing shell (Spotlight renders beside the shell)', () => {
    expect(hook()).toEqual({ interactive: true, hidden: false })
  })

  it('is not interactive under a hidden takeover surface', () => {
    expect(hook(({ children }) => <RetainedWorkspaceSurface hidden>{children}</RetainedWorkspaceSurface>))
      .toEqual({ interactive: false, hidden: true })
  })

  it('is not interactive under a fullscreen editor slot', () => {
    expect(hook(({ children }) => (
      <GlobalEditorWorkspaceSlot open editorFullscreen splitWorkspaceWidth="60%">{children}</GlobalEditorWorkspaceSlot>
    ))).toEqual({ interactive: false, hidden: true })
  })

  it('is not interactive when a visible editor slot sits inside a hidden surface', () => {
    expect(hook(({ children }) => (
      <RetainedWorkspaceSurface hidden>
        <GlobalEditorWorkspaceSlot open editorFullscreen={false} splitWorkspaceWidth="60%">{children}</GlobalEditorWorkspaceSlot>
      </RetainedWorkspaceSurface>
    ))).toEqual({ interactive: false, hidden: true })
  })

  it('is interactive when both shells are visible, and never when unfocused', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RetainedWorkspaceSurface hidden={false}>
        <GlobalEditorWorkspaceSlot open editorFullscreen={false} splitWorkspaceWidth="60%">{children}</GlobalEditorWorkspaceSlot>
      </RetainedWorkspaceSurface>
    )
    expect(renderHook(() => useInteractiveOwnership(true), { wrapper }).result.current).toEqual({ interactive: true, hidden: false })
    expect(renderHook(() => useInteractiveOwnership(false), { wrapper }).result.current).toEqual({ interactive: false, hidden: false })
  })
})
