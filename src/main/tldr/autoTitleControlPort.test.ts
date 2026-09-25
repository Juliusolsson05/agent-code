import { expect, it, vi } from 'vitest'
import { createAutoTitleControlPort } from './autoTitleControlPort.js'

it('routes a title write to the leased window without asking unrelated windows', async () => {
  const right = { kind: 'window' as const, windowId: 'right', generation: 'ready' }
  const invoke = vi.fn(async () => ({ ok: true, value: { title: 'Repair queue' } }))
  const host = {
    catalog: () => [{ descriptor: { id: 'agents.autoTitleSet' }, owner: right }],
    forCaller: () => ({ invoke }),
  }
  const port = createAutoTitleControlPort(host as never, sessionId => sessionId === 'right-agent' ? 'right' : null)

  expect(await port.set('right-agent', 'Repair queue', () => true)).toBe('Repair queue')
  expect(invoke).toHaveBeenCalledWith({
    capabilityId: 'agents.autoTitleSet', input: { sessionId: 'right-agent', title: 'Repair queue' }, owner: right,
  })
})
