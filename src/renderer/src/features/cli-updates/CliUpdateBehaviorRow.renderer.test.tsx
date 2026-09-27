import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  // #1250 row 13: the write had no rejection handler at all.
  it('says a failed write did not save, and keeps showing main\'s value', async () => {
    const setBehavior = vi.fn(async () => { throw new Error("EACCES: permission denied, open '/Users/someone/setup.json'") })
    Object.assign(window, { api: { ...window.api, cliUpdatesSetBehavior: setBehavior } })
    act(() => { useCliUpdateStore.setState({ snapshot: { ...useCliUpdateStore.getState().snapshot, behavior: 'notify' } }) })
    render(<CliUpdateBehaviorRow />)
    const group = screen.getByRole('radiogroup', { name: 'CLI Update Behavior' })
    const off = within(group).getAllByRole('radio').find(radio => radio.textContent?.includes('Off'))!
    fireEvent.click(off)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save this change. Nothing was changed.")
    expect(document.body.textContent).not.toContain('EACCES')
    const checked = within(group).getAllByRole('radio').find(radio => radio.getAttribute('aria-checked') === 'true')!
    expect(checked.textContent).toContain('Notify Only')

    // A later choice that saves clears the message (#1403 review b).
    setBehavior.mockImplementation(async () => ({ ...useCliUpdateStore.getState().snapshot, behavior: 'off' }) as never)
    fireEvent.click(off)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
