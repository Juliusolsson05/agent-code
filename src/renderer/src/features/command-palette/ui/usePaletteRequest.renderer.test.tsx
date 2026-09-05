import { useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { usePaletteRequest } from './usePaletteRequest'
import { paletteRequests } from '../paletteRequests'
import { builtInCommandCatalog } from '../catalog'

afterEach(cleanup)

// This exercises the production rendezvous hook against React commits and the
// real catalog. It is a UI handoff contract probe, not a claim that this small
// harness reproduces CommandPalette's full contextual admission/rendering.
function Picker() {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const commands = builtInCommandCatalog.filter(command => command.description.includes(query))
  usePaletteRequest({ visible: true, mode: 'commands', query, setQuery, selectedIndex, setSelectedIndex,
    commandIds: commands.map(command => command.id) })
  return <div data-query={query} data-selected={commands[selectedIndex]?.id} />
}

it('acknowledges the already-empty picker and an explicitly selected real command without executing it', async () => {
  const view = render(<Picker />)
  let first!: ReturnType<typeof paletteRequests.open>
  act(() => { first = paletteRequests.open({ query: '' }) })
  const result = await first
  expect(result).toMatchObject({ query: '', visibleRows: builtInCommandCatalog.length, requestedSelectionFound: true })
  const command = builtInCommandCatalog.find(command => command.id === 'toggle-reader-mode')!
  let selection!: ReturnType<typeof paletteRequests.open>
  act(() => { selection = paletteRequests.open({ query: command.description, commandId: command.id }) })
  expect(await selection).toMatchObject({ query: command.description, selectedCommandId: command.id, requestedSelectionFound: true })
  expect(view.container.firstElementChild?.getAttribute('data-selected')).toBe(command.id)
})

it('reports a missing contextual selection and rejects concurrent picker requests', async () => {
  render(<Picker />)
  let first!: ReturnType<typeof paletteRequests.open>
  act(() => { first = paletteRequests.open({ query: 'no-command-has-this-description', commandId: 'new-tab' }) })
  await expect(paletteRequests.open({ query: 'another intention' })).rejects.toThrow('in progress')
  expect(await first).toEqual({ query: 'no-command-has-this-description', selectedCommandId: null, requestedSelectionFound: false, visibleRows: 0 })
})
