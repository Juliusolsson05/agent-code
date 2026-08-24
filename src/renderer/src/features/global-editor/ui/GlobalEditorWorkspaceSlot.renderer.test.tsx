import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
  useHasAgentTerminalDimensionClaim,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { GlobalEditorWorkspaceSlot } from './GlobalEditorWorkspaceSlot'

function OwnershipProbe() {
  const ownsDimensions = useHasAgentTerminalDimensionClaim('session-1')
  return <div data-testid="ownership-probe">{ownsDimensions ? 'owned' : 'released'}</div>
}

describe('GlobalEditorWorkspaceSlot terminal dimension ownership', () => {
  afterEach(() => {
    cleanup()
  })

  it('retains but releases the hidden workspace terminal in editor fullscreen', async () => {
    const tree = (editorFullscreen: boolean) => (
      <AgentTerminalOwnershipProvider>
        <GlobalEditorWorkspaceSlot
          open
          editorFullscreen={editorFullscreen}
          splitWorkspaceWidth="42%"
        >
          <MountedAgentTerminalOwner sessionId="session-1">
            <div data-testid="retained-terminal" />
          </MountedAgentTerminalOwner>
        </GlobalEditorWorkspaceSlot>
        <OwnershipProbe />
      </AgentTerminalOwnershipProvider>
    )
    const view = render(tree(true))
    const retainedTerminal = screen.getByTestId('retained-terminal')
    const workspaceSlot = retainedTerminal.parentElement?.parentElement

    // This is the exact state the orchestration review found: the Global
    // Editor's workspace child remains mounted under display:none. The fixture
    // is the shell's real component rather than the passthrough mock that hid
    // the defect in the first ownership integration test.
    expect(workspaceSlot?.style.display).toBe('none')
    expect(retainedTerminal.parentElement?.className).toBe('hidden')
    expect(screen.getByTestId('ownership-probe').textContent).toBe('released')

    view.rerender(tree(false))
    await waitFor(() => {
      expect(screen.getByTestId('retained-terminal')).toBe(retainedTerminal)
      expect(workspaceSlot?.style.display).toBe('')
      expect(retainedTerminal.parentElement?.className).toBe('contents')
      expect(screen.getByTestId('ownership-probe').textContent).toBe('owned')
    })

    view.rerender(tree(true))
    await waitFor(() => {
      expect(screen.getByTestId('retained-terminal')).toBe(retainedTerminal)
      expect(workspaceSlot?.style.display).toBe('none')
      expect(retainedTerminal.parentElement?.className).toBe('hidden')
      expect(screen.getByTestId('ownership-probe').textContent).toBe('released')
    })
  })
})
