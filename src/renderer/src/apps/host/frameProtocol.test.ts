import { describe, expect, it } from 'vitest'

import { frameRequestEnvelopeSchema } from './frameProtocol'

// The envelope parse is the view broker's allow-list: a request that fails it
// is dropped WITHOUT a reply (frameHost.onMessage), so the child's promise
// never settles. That is correct for foreign postMessage traffic and a silent
// hang for a real API call the schema forgot — which is what happened to
// api.net.fetch and api.services.expose from views until #1150.

const envelope = (request: unknown) => ({ kind: 'agent-code-ext:request', id: 'r1', request })

describe('view frame request allow-list', () => {
  it.each([
    ['net.fetch (private address)', { method: 'net.fetch', url: 'http://192.168.1.20:5192/api/state', httpMethod: 'POST', headers: [{ name: 'Authorization', value: 'Bearer x' }], body: '{}' }],
    ['net.fetch (declared origin, binary)', { method: 'net.fetch', url: 'https://api.elevenlabs.io/v1/text-to-speech/v', httpMethod: 'POST', body: '{}', responseType: 'base64' }],
    ['service.expose', { method: 'service.expose', serviceId: 'poker.lan-host', lan: true }],
    ['secrets.get', { method: 'secrets.get', key: 'elevenlabs.apiKey' }],
    ['secrets.set', { method: 'secrets.set', key: 'elevenlabs.apiKey', value: 'sk_x' }],
    ['secrets.delete', { method: 'secrets.delete', key: 'elevenlabs.apiKey' }],
  ])('accepts %s so the broker answers instead of hanging', (_label, request) => {
    expect(frameRequestEnvelopeSchema.safeParse(envelope(request)).success).toBe(true)
  })

  it.each([
    ['an unknown responseType', { method: 'net.fetch', url: 'https://api.elevenlabs.io/', responseType: 'blob' }],
    ['a secret key outside the grammar', { method: 'secrets.get', key: '../other-extension' }],
    ['an oversized secret value', { method: 'secrets.set', key: 'k', value: 'x'.repeat(4097) }],
    ['a child-supplied extension id', { method: 'secrets.get', key: 'k', extensionId: 'someone-else' }],
  ])('still refuses %s', (_label, request) => {
    expect(frameRequestEnvelopeSchema.safeParse(envelope(request)).success).toBe(false)
  })
})
