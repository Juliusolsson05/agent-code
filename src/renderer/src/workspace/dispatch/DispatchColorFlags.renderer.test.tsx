import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ColorFlagPickerModal } from '@renderer/features/workspace/ui/ColorFlagPickerModal'
import { DispatchAgentList } from '@renderer/workspace/dispatch/DispatchAgentList'
import { DispatchMiniList } from '@renderer/workspace/dispatch/DispatchMiniList'
import type {
  DispatchAgentRow,
  DispatchTabGroup,
} from '@renderer/workspace/dispatch/dispatchSelectors'

const appState = vi.hoisted(() => ({
  settings: {
    dispatchColorFlags: {} as Record<string, string>,
  },
  workspaceRuntimes: {} as Record<string, never>,
  setDispatchColorFlag: vi.fn(),
}))

vi.mock('@renderer/app-state/hooks', () => ({
  // WHY mock only the Zustand transport boundary: these are renderer-layout
  // tests, while the real store's persist middleware depends on localStorage
  // and is already outside the behavior changed here. Every component still
  // selects from ONE shared state object, so the test fails if the rich list,
  // mini list, and modal disagree about the settings shape.
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))

const FLAGGED_SESSION_ID = 'session-flagged'
const UNFLAGGED_SESSION_ID = 'session-unflagged'

function dispatchRow(sessionId: string, label: string): DispatchAgentRow {
  return {
    key: `tab-a:grid:${sessionId}`,
    label,
    globalIndex: Number(label.slice(1)),
    tabId: 'tab-a',
    tabTitle: 'Agent Code',
    tabIndex: 0,
    sessionId,
    kind: 'claude',
    title: `${label} workflow`,
    placement: 'grid',
    depth: 0,
  }
}

const rows = [
  dispatchRow(FLAGGED_SESSION_ID, 'A1'),
  dispatchRow(UNFLAGGED_SESSION_ID, 'A2'),
]

function group(): DispatchTabGroup {
  return {
    tab: {
      id: 'tab-a',
      title: 'Agent Code',
      root: { type: 'leaf', sessionId: FLAGGED_SESSION_ID },
      focusedSessionId: FLAGGED_SESSION_ID,
    },
    tabIndex: 0,
    rows,
  }
}

function setColorFlags(dispatchColorFlags: Record<string, string>): void {
  appState.settings.dispatchColorFlags = dispatchColorFlags
}

afterEach(() => {
  appState.settings.dispatchColorFlags = {}
  appState.workspaceRuntimes = {}
  appState.setDispatchColorFlag.mockClear()
})

describe('Dispatch color-flag layout', () => {
  it('gives every rich Dispatch row a real trailing column and fills only the flagged one', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'red' })
    const { container } = render(
      <DispatchAgentList
        groups={[group()]}
        pinnedRows={[]}
        activeSessionId={FLAGGED_SESSION_ID}
        dispatchScope="project"
        focusSessionInTab={vi.fn()}
        showWorktreeBadges={false}
      />,
    )

    const renderedRows = container.querySelectorAll<HTMLElement>('[data-dispatch-row="true"]')
    expect(renderedRows).toHaveLength(2)

    const flagged = renderedRows[0].querySelector<HTMLElement>('[data-dispatch-color-flag]')
    const unflagged = renderedRows[1].querySelector<HTMLElement>('[data-dispatch-color-flag]')
    expect(flagged).toHaveAttribute('data-dispatch-color-flag', 'red')
    expect(flagged).toHaveClass('w-[10px]', 'flex-none', 'self-stretch')
    expect(flagged).not.toHaveClass('absolute')
    expect(flagged).toHaveStyle({ backgroundColor: '#ef4444' })
    expect(unflagged).toHaveAttribute('data-dispatch-color-flag', 'none')
    expect(unflagged?.style.backgroundColor).toBe('')
    expect(renderedRows[0]).not.toHaveClass('pr-2.5')
  })

  it('adds the same flag column beside the original 36px label in tiled mini lists', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'blue' })
    const { container } = render(
      <DispatchMiniList
        rows={rows}
        selectedSessionId={FLAGGED_SESSION_ID}
        focused
        onSelect={vi.fn()}
      />,
    )

    // WHY assert the outer 46px contract as well as the child widths: a strip
    // can exist in the DOM yet still overflow or squeeze the old w-9 selector.
    // The flexible label keeps the old selector's inner remainder; the new
    // fixed 10px is therefore added space rather than stolen label space.
    expect(container.firstElementChild).toHaveClass('w-[46px]')
    const chips = container.querySelectorAll<HTMLElement>('[data-dispatch-row="true"]')
    expect(chips).toHaveLength(2)
    expect(chips[0].children[0]).toHaveClass('flex-1', 'min-w-0', 'justify-center')
    expect(chips[0].children[1]).toHaveAttribute('data-dispatch-color-flag', 'blue')
    expect(chips[0].children[1]).toHaveClass('w-[10px]', 'flex-none', 'self-stretch')
    expect(chips[1].children[1]).toHaveAttribute('data-dispatch-color-flag', 'none')
  })

  it('centers the modal swatches inside the same horizontal inset as its chrome', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'green' })
    render(
      <ColorFlagPickerModal
        open
        sessionId={FLAGGED_SESSION_ID}
        onClose={vi.fn()}
      />,
    )

    const swatches = document.querySelector<HTMLElement>('[data-color-flag-swatches="true"]')
    expect(swatches).toHaveClass('flex-wrap', 'justify-center', 'px-4')
    expect(screen.getByRole('button', { name: 'Green' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Purple' })).toHaveAttribute('aria-pressed', 'false')
  })
})
