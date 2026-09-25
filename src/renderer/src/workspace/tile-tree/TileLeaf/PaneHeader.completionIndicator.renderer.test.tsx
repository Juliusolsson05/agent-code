import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { PaneHeader } from './PaneHeader'

// #1172, redesigned in #1200: WHEN the header shows the Agent Completion
// Indicator (the working bar drawn hollow: surface fill, accent ring, accent
// text). Asserts the `data-completion-outlined` hook, which is driven by the
// same boolean as the outline class, so this tests what the user sees rather
// than a parallel copy.

const originalStore = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(originalStore, true) })

// The path from the owner's screenshot of the #1192 regression: long enough
// that a plate behind it covered almost the whole header row.
const LONG_PATH = '/Users/someone/Desktop/Development/projects/-Users-someone-Desktop-Development-agent-code'

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
      paneLabel="B6"
      projectDir={LONG_PATH}
      statusMode={statusMode}
      isSessionLive={isSessionLive}
      completionUnseen={completionUnseen}
      trailing={<span>TAIL</span>}
    />,
  )
  const row = container.querySelector('[data-pane-header-row="true"]') as HTMLElement
  return {
    container,
    row,
    outlined: row.dataset.completionOutlined === 'true',
    outlineClass: row.classList.contains('pane-header-completion-outline'),
  }
}

describe('PaneHeader completion indicator', () => {
  it('outlines an idle pane holding an unseen completion', () => {
    const { outlined, outlineClass } = header()
    expect({ outlined, outlineClass }).toEqual({ outlined: true, outlineClass: true })
  })

  it('outlines without Status Mode too, since the two settings are independent', () => {
    expect(header({ statusMode: false }).outlined).toBe(true)
  })

  it('shows the solid working fill instead while the agent is running again', () => {
    // The unread marker from the previous turn is still set, but a working
    // pane isn't "finished, go look".
    const { row, outlined, outlineClass } = header({ isSessionLive: true })
    expect({ outlined, outlineClass }).toEqual({ outlined: false, outlineClass: false })
    expect(row.dataset.statusLit).toBe('true')
  })

  it('never shows the lit fill and the outline together', () => {
    // The outline's CSS is unlayered and would override `bg-accent`, so the
    // two states must stay mutually exclusive (see PaneHeader).
    for (const isSessionLive of [true, false]) {
      cleanup()
      const { row } = header({ isSessionLive })
      expect(row.dataset.statusLit === 'true' && row.dataset.completionOutlined === 'true').toBe(false)
    }
  })

  it('does not outline a running pane even with Status Mode off', () => {
    // Nothing is lit here, but the agent is busy, so "finished" would be false.
    expect(header({ statusMode: false, isSessionLive: true }).outlined).toBe(false)
  })

  it('does not outline once the completion has been seen', () => {
    expect(header({ completionUnseen: false }).outlined).toBe(false)
  })

  it('does not outline when the setting is off', () => {
    const { outlined, outlineClass } = header({ enabled: false })
    expect({ outlined, outlineClass }).toEqual({ outlined: false, outlineClass: false })
  })

  it('never outlines a surface that does not opt in (shell terminals)', () => {
    useAppStore.setState(state => ({
      settings: { ...state.settings, showAgentCompletionIndicator: true },
    }))
    const { container } = render(
      <PaneHeader sessionId={'shell' as never} projectDir="/fixture" statusMode isSessionLive={false} />,
    )
    const row = container.querySelector('[data-pane-header-row="true"]') as HTMLElement
    expect(row.dataset.completionOutlined).toBe('false')
  })

  // #1200: the #1192 regression. Surface plates wrapped the label and path, so
  // a long path covered the indicator. The indicator now belongs to the ROW
  // itself, and nothing between the row and the text paints a background.
  it('paints the indicator on the row itself, with no plate between it and the text', () => {
    const { container, row } = header()
    const path = container.querySelector(`[title="${LONG_PATH}"]`) as HTMLElement
    const label = [...container.querySelectorAll('span')].find(span => span.textContent === 'B6')!
    const tail = [...container.querySelectorAll('span')].find(span => span.textContent === 'TAIL')!
    for (const text of [path, label, tail]) {
      for (let node = text.parentElement; node && node !== row; node = node.parentElement) {
        expect(node.hasAttribute('data-completion-plate'), 'a completion plate wraps the text').toBe(false)
        expect([...node.classList].some(name => name.startsWith('bg-') || name.includes('plate'))).toBe(false)
      }
    }
    expect(row.classList.contains('pane-header-completion-outline')).toBe(true)
  })

  it('keeps the identical markup whether or not the outline is showing', () => {
    // The ring is an inset box-shadow, so the indicator appearing or clearing
    // must not add, remove or re-pad anything inside the row, which would shift
    // the text or resize a terminal pane beneath it.
    const inner = (completionUnseen: boolean) => {
      cleanup()
      const { row } = header({ completionUnseen })
      return row.innerHTML
    }
    expect(inner(true)).toBe(inner(false))
  })
})
