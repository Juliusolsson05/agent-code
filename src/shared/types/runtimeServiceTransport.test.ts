import { describe, expect, it } from 'vitest'
import { runtimeApiRequestSchema } from './extensionRuntime.js'

// A runtime's api.services / api.net calls cross THIS transport; the view
// broker had them and this union did not, so only views could host services.
// The poker Electron harness caught the gap via a background command. This
// pins every method the runtime document's api surface promises.
describe('runtime transport accepts the full v2 service surface', () => {
  it.each([
    ['service.start', { method: 'service.start', serviceId: 'agent-code-poker.lan-host' }],
    ['service.stop', { method: 'service.stop', serviceId: 'x.y' }],
    ['service.status', { method: 'service.status', serviceId: 'x.y' }],
    ['service.invoke', { method: 'service.invoke', serviceId: 'x.y', name: 'status' }],
    ['service.expose', { method: 'service.expose', serviceId: 'x.y', lan: true }],
    ['net.fetch', { method: 'net.fetch', url: 'http://192.168.1.9:5192/api/state' }],
  ])('accepts %s from a background runtime', (_label, request) => {
    expect(() => runtimeApiRequestSchema.parse(request)).not.toThrow()
  })

  it('still rejects undeclared methods', () => {
    expect(() => runtimeApiRequestSchema.parse({ method: 'service.exfiltrate' })).toThrow()
  })
})
