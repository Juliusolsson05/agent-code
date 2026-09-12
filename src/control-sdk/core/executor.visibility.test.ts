import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineCapability, type ControlCaller } from '../index'
import { createControlExecutor, createControlRegistry } from '../host'
import type { ControlHistory, HistoryEvent, HistoryWrite } from '../history'

// A throwaway journal so this test exercises the executor's admission rule
// without a filesystem. It records what a real history would, so the caller
// label written for an agent grant can be asserted as audit evidence.
function memoryHistory(): ControlHistory & { events(): Promise<HistoryEvent[]> } {
  const events: HistoryEvent[] = []
  return {
    async append(event: HistoryWrite) {
      const stored = { ...event, sequence: events.length + 1 }
      events.push(stored)
      return stored
    },
    async events() { return events },
    async payload() { return undefined },
    async chunk() { return { text: '', offset: 0, nextOffset: null, totalBytes: 0, sha256: '' } },
  }
}

describe('application-only capability admission by caller kind', () => {
  async function invokeAs(caller: ControlCaller) {
    const history = memoryHistory()
    const registry = createControlRegistry()
    registry.register({ kind: 'main', generation: 'main' }, [defineCapability({
      id: 'settings.private', title: 'Private settings action', description: 'Reserved for the app itself.',
      visibility: 'application', execution: 'main', effect: 'mutation',
      input: z.object({}).strict(), output: z.object({ changed: z.literal(true) }), handler: () => ({ changed: true as const }),
    })])
    const executor = createControlExecutor({ history, instanceId: 'trial', id: () => `call-${caller.kind}`, now: () => '2026-09-11T00:00:00.000Z',
      catalog: () => registry.list(), dispatch: (request, context) => registry.invoke(request, context) })
    const result = await executor.invoke({ capabilityId: 'settings.private', input: {} }, caller)
    return { result, events: await history.events() }
  }

  it('lets only the application reach its own settings actions', async () => {
    expect((await invokeAs({ kind: 'application', id: 'settings-window' })).result).toMatchObject({ ok: true, value: { changed: true } })
    expect((await invokeAs({ kind: 'external', id: 'operator' })).result)
      .toMatchObject({ ok: false, error: { code: 'unavailable', outcome: 'not_started' } })
    // The failure scenario this protects: an agent granted Root Agent Code
    // Management enumerates the catalog and tries the external-server switch
    // or the task journal. Neither may work for an in-app agent, regardless of
    // which projection hid the tool.
    const agent = await invokeAs({ kind: 'agent', id: 'session-7' })
    expect(agent.result).toMatchObject({ ok: false, error: { code: 'unavailable', outcome: 'not_started' } })
    expect(agent.events.map(event => event.caller)).toContain('agent:session-7')
  })
})
