import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { GlobalToastProvider, useGlobalToast } from '@renderer/ui/GlobalToast'
import { PaneToast } from './PaneToast'

function GlobalToastHarness(): JSX.Element {
  const { showToast } = useGlobalToast()
  return <button onClick={() => showToast('global status')}>Show global toast</button>
}

describe('toast radius ownership', () => {
  it('keeps pane status modest while reserving float radius for detached toasts', () => {
    render(
      <>
        <PaneToast message="pane status" />
        <GlobalToastProvider>
          <GlobalToastHarness />
        </GlobalToastProvider>
      </>,
    )

    const paneToast = screen.getByText('pane status')
    // WHY the two assertions travel together: `float` is not merely a larger
    // radius; it says a surface is detached from the workspace grid. This
    // toast sits inside a pane between bordered regions, and at its 17px-ish
    // line height the 14px float value clamps into the pill shape that exposed
    // the misclassification. The smaller chrome radius preserves context.
    expect(paneToast.className).toContain('rounded-control')
    expect(paneToast.className).not.toContain('rounded-float')
    expect(paneToast.className).toContain('min-w-0')
    expect(paneToast.className).toContain('max-w-full')
    expect(paneToast.className).toContain('[overflow-wrap:anywhere]')

    fireEvent.click(screen.getByRole('button', { name: 'Show global toast' }))
    const globalToast = screen.getByText('global status')
    expect(globalToast.className).toContain('rounded-float')
    expect(globalToast.className).not.toContain('rounded-control')
  })

  it('bounds pathological feedback without discarding the complete message', () => {
    const message = `Backend error: ${'A'.repeat(2048)}`
    render(<PaneToast message={message} />)

    const paneToast = screen.getByText(message)
    // WHY this is a joint visual/content contract: emergency wrapping fixes
    // horizontal overflow, but without a line cap the non-shrinking toast can
    // consume the pane vertically and clip the composer. The text must stay in
    // the DOM and title even when CSS clamps its paint, because backend errors
    // and resume commands contain details the user may still need to inspect.
    expect(paneToast.className).toContain('[overflow-wrap:anywhere]')
    expect(paneToast.className).toContain('line-clamp-3')
    expect(paneToast).toHaveAttribute('title', message)
    expect(paneToast).toHaveTextContent(message)
  })
})
