import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'

import { inboundFrames, recordingFor } from 'hermes-headless/testing/corpus'
import type { CommandsCatalogResult } from 'hermes-headless'
import { composerCommandsFromCatalog } from '@providers/hermes/runtime/composerCommands'
import { hermesComposerSubmit } from '@providers/hermes/renderer/composerSubmit'

import { useComposerCommandPicker } from './useComposerCommandPicker'

// Catalog: the REAL Hermes v0.22.0 `commands.catalog` answer (recorded S17),
// through the same mapping HermesSession uses.
const catalog = inboundFrames(recordingFor('S17', 'v0.22.0'))
  .map((frame) => frame.result as CommandsCatalogResult | undefined)
  .find((result) => result && Array.isArray(result.pairs))!
const commands = composerCommandsFromCatalog(catalog)

function Composer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [input, setInput] = useState('')
  const picker = useComposerCommandPicker({ sessionId: 's1', enabled: true, input, setInputText: setInput, load: async () => commands })
  return (
    <div>
      <textarea
        aria-label="composer"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (picker.onKeyDown(event)) return
          if (event.key === 'Enter') onSubmit(input)
        }}
      />
      <ul>{picker.state?.items.map((item) => <li key={item.id} aria-selected={item.selected}>{item.label}</li>)}</ul>
    </div>
  )
}

async function typed(text: string) {
  const onSubmit = vi.fn()
  const view = render(<Composer onSubmit={onSubmit} />)
  const box = view.getByLabelText('composer') as HTMLTextAreaElement
  await act(async () => { fireEvent.change(box, { target: { value: text } }) })
  await act(async () => {})
  return { view, box, onSubmit }
}

describe('Hermes slash picker in the composer (#1497)', () => {
  it('lists matching commands as you type, prefix matches first', async () => {
    const { view } = await typed('/comp')
    const labels = [...view.container.querySelectorAll('li')].map((li) => li.textContent)
    expect(labels[0]).toBe('/compress')
  })

  it('completes with Tab and only submits once the draft is the exact command', async () => {
    const { view, box, onSubmit } = await typed('/resta')
    expect(view.container.querySelector('li[aria-selected="true"]')?.textContent).toBe('/restart')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(box.value).toBe('/restart ')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/restart ')
  })

  it('offers subcommands after a space', async () => {
    const { view } = await typed('/skills pe')
    expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['/skills pending'])
  })

  it('closes on Escape until the draft changes', async () => {
    const { view, box } = await typed('/comp')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(view.container.querySelectorAll('li')).toHaveLength(0)
  })
})

describe('/restart asks first (plan Decision 6, UNCONFIRMED)', () => {
  it('sends nothing when the user cancels, and sends when they confirm', async () => {
    const deliverPrompt = vi.fn(async () => ({ ok: true as const, acceptance: { kind: 'transport' as const, acceptedAt: 1 } }))
    const io = { input: '/restart', deliverPrompt } as unknown as Parameters<typeof hermesComposerSubmit>[0]
    // Cancelled: nothing is sent, and the acceptance is `queue` so the
    // composer settles its optimistic "submitting" phase (review #1503).
    expect(await hermesComposerSubmit(io, async () => false)).toMatchObject({ kind: 'queue' })
    expect(deliverPrompt).not.toHaveBeenCalled()
    expect(await hermesComposerSubmit(io, async () => true)).toMatchObject({ kind: 'transport' })
    expect(deliverPrompt).toHaveBeenCalledWith('/restart')
  })
})

// Review #1503.
describe('picker review fixes', () => {
  it('Enter on an exact command runs it, even when a longer name comes first in the catalog (S17 /codex vs /codex-runtime)', async () => {
    expect(commands.findIndex((command) => command.name === 'codex-runtime')).toBeLessThan(commands.findIndex((command) => command.name === 'codex'))
    const { view, box, onSubmit } = await typed('/codex')
    expect(view.container.querySelector('li[aria-selected="true"]')?.textContent).toBe('/codex')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/codex')
  })

  it('asks again on the next / when the first answer was only the fallback list', async () => {
    const fallback = composerCommandsFromCatalog({})
    const load = vi.fn<(sessionId: string) => Promise<typeof commands>>()
      .mockResolvedValueOnce(fallback)
      .mockResolvedValue(commands)
    function Pane() {
      const [input, setInput] = useState('')
      const picker = useComposerCommandPicker({ sessionId: 's1', enabled: true, input, setInputText: setInput, load })
      return (<div><textarea aria-label="c" value={input} onChange={(event) => setInput(event.target.value)} /><ul>{picker.state?.items.map((item) => <li key={item.id}>{item.label}</li>)}</ul></div>)
    }
    const view = render(<Pane />)
    const box = view.getByLabelText('c')
    await act(async () => { fireEvent.change(box, { target: { value: '/' } }) })
    await act(async () => { fireEvent.change(box, { target: { value: '' } }) })
    await act(async () => { fireEvent.change(box, { target: { value: '/comp' } }) })
    await act(async () => {})
    expect(load).toHaveBeenCalledTimes(2)
    expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toContain('/compress')
  })
})
