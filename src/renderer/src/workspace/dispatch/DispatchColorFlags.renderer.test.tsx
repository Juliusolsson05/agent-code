import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ColorFlagPickerModal } from '@renderer/features/workspace/ui/ColorFlagPickerModal'
import { DispatchAgentList } from '@renderer/workspace/dispatch/DispatchAgentList'
import { DispatchMiniList } from '@renderer/workspace/dispatch/DispatchMiniList'
import type {
  DispatchAgentRow,
  DispatchTabGroup,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'

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

// WHY the pane-header cases live in this file rather than a new one: this file
// is the color-flag feature's coverage, not the Dispatch list's. The flag is
// one piece of state with several renderers, and keeping every renderer's
// contract in one place is what caught the tiled-lane gap that #605 had to fix.
describe('Session header color flag', () => {
  function renderHeader(sessionId: string, statusMode: boolean) {
    return render(
      <PaneHeader
        sessionId={sessionId}
        paneLabel="A2"
        projectDir="/Users/dev/agent-code"
        statusMode={statusMode}
        isSessionLive
      />,
    )
  }

  it('paints a trailing chunk of the flag color over the status strip', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'red' })
    const { container } = renderHeader(FLAGGED_SESSION_ID, true)

    const chunk = container.querySelector<HTMLElement>('[data-pane-color-flag]')
    expect(chunk).toHaveAttribute('data-pane-color-flag', 'red')
    expect(chunk).toHaveClass('w-1/4', 'flex-none', 'self-stretch')
    expect(chunk).not.toHaveClass('absolute')
    expect(chunk).toHaveStyle({ backgroundColor: '#ef4444' })
    // The seam that keeps the chunk legible when the user's accent shares a hue
    // with their flag color — without it a live pane can swallow the flag whole.
    expect(chunk).toHaveClass('border-l', 'border-canvas')
    // Hoverable on purpose: the tooltip is the only way to tell red from green
    // apart for a colorblind user, and `pointer-events-none` would kill it.
    expect(chunk).toHaveAttribute('title', 'Red flag')
    expect(chunk).not.toHaveClass('pointer-events-none')
  })

  it('puts the chunk at the far right of the header, not beside the label', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'red' })
    const { container } = renderHeader(FLAGGED_SESSION_ID, true)

    // WHY assert `justify-between` explicitly: it is the ONLY thing placing the
    // chunk at the right edge. Every other assertion in this block passes with
    // the chunk sitting in the middle of the header, immediately after the
    // label group — which is the single most likely way to break this feature
    // while keeping it looking implemented.
    const row = container.querySelector<HTMLElement>('[data-pane-header-row="true"]')
    expect(row).toHaveClass('justify-between')
    expect(row?.lastElementChild).toHaveAttribute('data-pane-color-flag', 'red')
  })

  it('renders no chunk at all for an unflagged session', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'red' })
    const { container } = renderHeader(UNFLAGGED_SESSION_ID, true)

    // WHY absence rather than a transparent placeholder — the deliberate
    // difference from the Dispatch column. Nothing sits to the right of this
    // chunk, so there is no cross-row alignment to preserve, and reserving a
    // quarter of every header would permanently squeeze the project dir for a
    // signal that is switched off.
    //
    // Note this renders the UNFLAGGED session while a different session is
    // flagged, so it also proves the chunk is keyed by session id rather than
    // rendering for whatever flag happens to exist in settings.
    expect(container.querySelector('[data-pane-color-flag]')).toBeNull()
  })

  it('drops a stale persisted flag id instead of rendering a broken chunk', () => {
    // The headline justification for routing both surfaces through
    // `useColorFlag`: a palette entry removed in a future version leaves this
    // id behind in persisted settings, and every reader must degrade to "no
    // flag" rather than throwing or painting `undefined`.
    setColorFlags({ [FLAGGED_SESSION_ID]: 'chartreuse' })
    const { container } = renderHeader(FLAGGED_SESSION_ID, true)

    expect(container.querySelector('[data-pane-color-flag]')).toBeNull()
  })

  it('carries all header padding on the label group so the chunk can bleed to every edge', () => {
    setColorFlags({ [FLAGGED_SESSION_ID]: 'purple' })
    const { container } = renderHeader(FLAGGED_SESSION_ID, false)

    // The row must stay bare: `self-stretch` fills the row's CONTENT box, so
    // any padding here becomes a gap the chunk cannot cross. `pl-3` in
    // particular also shrinks the chunk, since `w-1/4` resolves against the
    // content box.
    const row = container.querySelector<HTMLElement>('[data-pane-header-row="true"]')
    expect(row).not.toHaveClass('px-3')
    expect(row).not.toHaveClass('pl-3')
    expect(row).not.toHaveClass('py-1')
    // ...and the padding must still exist one level down, so the header's
    // rendered height and the label's insets are unchanged from before the
    // chunk existed. `px-3` is what keeps the project dir off the pane edge on
    // UNFLAGGED panes, where no chunk mounts to stand in for it.
    expect(row?.firstElementChild).toHaveClass('px-3', 'py-1')
  })

  it('keeps Status Mode compact by dropping the label group to zero vertical padding', () => {
    // Status Mode's whole point is a ~5px glance strip. An unconditional `py-1`
    // on the group silently grows it to a 24px bar, which no other assertion in
    // this block would catch — the padding case above runs with statusMode off,
    // where `py-1` is correct.
    setColorFlags({ [FLAGGED_SESSION_ID]: 'purple' })
    const { container } = renderHeader(FLAGGED_SESSION_ID, true)

    const row = container.querySelector<HTMLElement>('[data-pane-header-row="true"]')
    expect(row).toHaveClass('min-h-[5px]')
    expect(row?.firstElementChild).toHaveClass('py-0')
    expect(row?.firstElementChild).not.toHaveClass('py-1')
  })
})
