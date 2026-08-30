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
})
