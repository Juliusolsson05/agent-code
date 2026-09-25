import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliUpdateBehaviorRow } from './CliUpdateBehaviorRow'
import { useCliUpdateStore } from './store'

// Settings › CLI update behaviour (UI pass, G-17). The three cards were plain
// buttons: nothing announced which behaviour was on, and none showed focus.
// They are now the shared radio cards.

afterEach(() => cleanup())

describe('CliUpdateBehaviorRow', () => {
  it('announces the active behaviour and chooses on arrow (k9)', () => {
    const setBehavior = vi.fn(async () => useCliUpdateStore.getState().snapshot)
    Object.assign(window, { api: { ...window.api, cliUpdatesSetBehavior: setBehavior } })
    act(() => { useCliUpdateStore.setState({ snapshot: { ...useCliUpdateStore.getState().snapshot, behavior: 'notify' } }) })
    render(<CliUpdateBehaviorRow />)
    const group = screen.getByRole('radiogroup', { name: 'CLI Update Behavior' })
    const radios = within(group).getAllByRole('radio')
    const checked = radios.find(radio => radio.getAttribute('aria-checked') === 'true')!
    expect(radios.filter(radio => radio.tabIndex === 0)).toEqual([checked])
    checked.focus()
    fireEvent.keyDown(checked, { key: 'ArrowRight' })
    expect(setBehavior).toHaveBeenCalledTimes(1)
  })
})
