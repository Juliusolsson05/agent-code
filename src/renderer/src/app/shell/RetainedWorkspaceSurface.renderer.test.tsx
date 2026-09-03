import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { GlobalEditorWorkspaceSlot } from '@renderer/features/global-editor/ui/GlobalEditorWorkspaceSlot'
import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
  useAgentTerminalDimensionActive,
  useHasAgentTerminalDimensionClaim,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'

import { RetainedWorkspaceSurface } from './RetainedWorkspaceSurface'

// #752 review: the editor slot nests INSIDE the retained surface and provides
// its own visibility value. If the two did not compose, a hidden workspace
// would keep every pane's dimension claim and the whole retention design
// would be dead in the production tree. This renders the real slot.

afterEach(() => cleanup())

function Probe() {
  const claimed = useHasAgentTerminalDimensionClaim('s1')
  const active = useAgentTerminalDimensionActive()
  return <div data-testid="probe" data-claimed={String(claimed)} data-active={String(active)} />
}

function tree(hidden: boolean) {
  return (
    <AgentTerminalOwnershipProvider>
      <RetainedWorkspaceSurface hidden={hidden}>
        <GlobalEditorWorkspaceSlot open editorFullscreen={false} splitWorkspaceWidth="60%">
          <MountedAgentTerminalOwner sessionId="s1">
            <Probe />
          </MountedAgentTerminalOwner>
        </GlobalEditorWorkspaceSlot>
      </RetainedWorkspaceSurface>
    </AgentTerminalOwnershipProvider>
  )
}

describe('RetainedWorkspaceSurface visibility composition', () => {
  it('releases the dimension claim through the editor slot while hidden and restores it on reveal', () => {
    const view = render(tree(true))
    expect(screen.getByTestId('probe').dataset.claimed).toBe('false')
    expect(screen.getByTestId('probe').dataset.active).toBe('false')

    view.rerender(tree(false))
    expect(screen.getByTestId('probe').dataset.claimed).toBe('true')
  })

  it('keeps the claim while visible even though the slot provides its own value', () => {
    render(tree(false))
    expect(screen.getByTestId('probe').dataset.claimed).toBe('true')
  })
})
