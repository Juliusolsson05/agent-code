import { describe, expect, it } from 'vitest'

import { buildRequestHeaders, netFetch, type NetFetchRequest } from './netFetch.js'
import { netOriginsFetch } from './netOrigins.js'

// THE CONTRACT (#1151 design review, blocker 2): no error either net.fetch
// route throws may contain a header value. Headers routinely carry API keys;
// the error text reaches the extension and renderer. The reviewer reproduced
// the private route echoing `Authorization: Bearer <token>\n...` through
// undici's Headers.set message on Node 24. Every case here uses a dummy token
// and asserts the token is absent from the thrown message, on BOTH routes.
const TOKEN = 'dummy-token-7f3c2a9e-not-a-real-secret'
const DECLARED = ['https://api.example.com']

type Route = { name: string; run(request: Omit<NetFetchRequest, 'url'>, perform: typeof fetch): Promise<unknown> }
const routes: Route[] = [
  { name: 'private (net.connect)', run: (request, perform) => netFetch({ url: 'http://192.168.1.20:5192/x', ...request }, perform) },
  { name: 'declared origin (net.origins)', run: (request, perform) => netOriginsFetch({ url: 'https://api.example.com/x', ...request }, DECLARED, perform) },
]

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return error instanceof Error ? `${error.name}: ${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error) }
  throw new Error('expected a rejection')
}

const neverCalled = (async () => { throw new Error('the request must be refused before dialing') }) as unknown as typeof fetch

describe.each(routes)('net.fetch credential-safe errors: $name', route => {
  it.each([
    ['newline injection', `Bearer ${TOKEN}\r\nX-Evil: 1`],
    ['bare LF', `Bearer ${TOKEN}\nX-Evil: 1`],
    ['NUL', `Bearer ${TOKEN}\u0000`],
    ['non-byte character', `Bearer ${TOKEN} `],
  ])('refuses a header value with %s without echoing it', async (_label, value) => {
    const message = await messageOf(route.run({ headers: [{ name: 'Authorization', value }] }, neverCalled))
    expect(message).toMatch(/header "Authorization" has an invalid value/)
    expect(message).not.toContain(TOKEN)
  })

  it('refuses an invalid header NAME without echoing it (a name can be a pasted key too)', async () => {
    const message = await messageOf(route.run({ headers: [{ name: `x ${TOKEN}`, value: 'v' }] }, neverCalled))
    expect(message).toMatch(/invalid header name/)
    expect(message).not.toContain(TOKEN)
  })

  it('turns a transport failure whose text contains the token into fixed copy', async () => {
    const perform = (async () => { throw new TypeError(`fetch failed: header authorization=Bearer ${TOKEN}`) }) as unknown as typeof fetch
    const message = await messageOf(route.run({ headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] }, perform))
    expect(message).toMatch(/failed \(network error or refused redirect\)/)
    expect(message).not.toContain(TOKEN)
  })

  it('turns a body-read failure whose text contains the token into fixed copy', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')) },
      pull(controller) { controller.error(new Error(`socket reset while sending Bearer ${TOKEN}`)) },
    })
    const perform = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const message = await messageOf(route.run({ headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }], responseType: 'base64' }, perform))
    expect(message).toMatch(/failed while reading the response/)
    expect(message).not.toContain(TOKEN)
  })

  it('still sends a valid credential header unchanged', async () => {
    let seen: string | null = null
    const perform = (async (_url: string, init?: RequestInit) => { seen = new Headers(init?.headers).get('authorization'); return new Response('ok') }) as unknown as typeof fetch
    await route.run({ headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] }, perform)
    expect(seen).toBe(`Bearer ${TOKEN}`)
  })
})

describe('buildRequestHeaders', () => {
  it('accepts HTAB and obs-text, which HTTP allows in field values', () => {
    expect(buildRequestHeaders([{ name: 'X-A', value: 'a\tb' }, { name: 'X-B', value: 'café' }]).get('x-a')).toBe('a\tb')
  })
})
