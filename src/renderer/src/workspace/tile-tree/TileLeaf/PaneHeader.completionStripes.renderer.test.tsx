import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { PaneHeader } from './PaneHeader'

// #1172: WHEN the header shows the Agent Completion Indicator stripes. Asserts
// the `data-completion-striped` hook, which is driven by the same boolean as the
// stripe class, so this tests what the user sees rather than a parallel copy.

const originalStore = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(originalStore, true) })

function header({
  enabled = true,
  completionUnseen = true,
  statusMode = true,
  isSessionLive = false,
}: {
  enabled?: boolean
  completionUnseen?: boolean
  statusMode?: boolean
  isSessionLive?: boolean
} = {}) {
  useAppStore.setState(state => ({
    settings: { ...state.settings, showAgentCompletionIndicator: enabled },
  }))
  const { container } = render(
    <PaneHeader
      sessionId={'pane' as never}
      projectDir="/fixture"
      statusMode={statusMode}
      isSessionLive={isSessionLive}
      completionUnseen={completionUnseen}
    />,
  )
  const row = container.querySelector('[data-pane-header-row="true"]') as HTMLElement
  return {
    striped: row.dataset.completionStriped === 'true',
    stripeClass: row.classList.contains('pane-header-completion-stripes'),
  }
}

/** The identity plate around the label and path (#1191). */
function identityPlate(container: HTMLElement): HTMLElement {
  return container.querySelector('[title="/fixture"]')!.closest('[data-completion-plate]') as HTMLElement
}

describe('PaneHeader completion stripes', () => {
  it('stripes an idle pane holding an unseen completion', () => {
    expect(header()).toEqual({ striped: true, stripeClass: true })
  })

  it('stripes without Status Mode too, since the two settings are independent', () => {
    expect(header({ statusMode: false }).striped).toBe(true)
  })

  it('shows the solid working fill instead while the agent is running again', () => {
    // The unread marker from the previous turn is still set, but a working
    // pane isn't "finished, go look".
    expect(header({ isSessionLive: true })).toEqual({ striped: false, stripeClass: false })
  })

  it('does not stripe a running pane even with Status Mode off', () => {
    // Nothing is lit here, but the agent is busy, so "finished" would be false.
    expect(header({ statusMode: false, isSessionLive: true }).striped).toBe(false)
  })

  it('does not stripe once the completion has been seen', () => {
    expect(header({ completionUnseen: false }).striped).toBe(false)
  })

  it('does not stripe when the setting is off', () => {
    expect(header({ enabled: false })).toEqual({ striped: false, stripeClass: false })
  })

  it('never stripes a surface that does not opt in (shell terminals)', () => {
    useAppStore.setState(state => ({
      settings: { ...state.settings, showAgentCompletionIndicator: true },
    }))
    const { container } = render(
      <PaneHeader sessionId={'shell' as never} projectDir="/fixture" statusMode isSessionLive={false} />,
    )
    const row = container.querySelector('[data-pane-header-row="true"]') as HTMLElement
    expect(row.dataset.completionStriped).toBe('false')
  })

  // #1191: full-strength stripes would put half of every glyph on an accent
  // band. The label and path sit on a surface plate instead, only while
  // striped, and the plate never moves the text.
  it('puts the label and path on a surface plate only while striped', () => {
    for (const striped of [true, false]) {
      cleanup()
      useAppStore.setState(state => ({
        settings: { ...state.settings, showAgentCompletionIndicator: true },
      }))
      const { container } = render(
        <PaneHeader
          sessionId={'pane' as never}
          paneLabel="A3"
          projectDir="/fixture"
          statusMode
          isSessionLive={false}
          completionUnseen={striped}
          trailing={<span>TAIL</span>}
        />,
      )
      const plates = [...container.querySelectorAll<HTMLElement>('[data-completion-plate]')]
      // Identity (label + path) and the trailing slot each get one.
      expect(plates).toHaveLength(2)
      expect(identityPlate(container).textContent).toContain('A3')
      for (const plate of plates) {
        expect(plate.classList.contains('pane-header-completion-plate')).toBe(striped)
        // Always padded AND offset by the same amount, so turning the
        // stripes on or off never shifts the text.
        expect(plate.classList.contains('px-1.5')).toBe(true)
        expect(plate.classList.contains('-mx-1.5')).toBe(true)
      }
    }
  })
})
