import { describe, expect, it } from 'vitest'

import { MAX_NET_FETCH_RESPONSE_BYTES } from './netFetch.js'
import { netFetchRoute, netOriginsFetch } from './netOrigins.js'

// The declared-origin path carries credentials (an API key header is the
// motivating case, #1150). These tests pin the promises the consent dialog
// makes: only the listed origins, never a hop elsewhere, bounded answers, and
// no header value ever echoed back into error text the renderer displays.

const DECLARED = ['https://api.elevenlabs.io']
const SECRET = 'sk_live_do_not_echo_1234567890'

type Seen = { url: string; init: RequestInit }
function recorder(respond: () => Response | Promise<Response>): { perform: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    perform: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} })
      return respond()
    }) as typeof fetch,
  }
}

describe('net.fetch routing', () => {
  it('sends private literals to net.connect and exact declared https origins to net.origins', () => {
    expect(netFetchRoute('http://192.168.1.20:5192/api', DECLARED)).toBe('net.connect')
    expect(netFetchRoute('https://api.elevenlabs.io/v1/x', DECLARED)).toBe('net.origins')
    expect(netFetchRoute('https://api.elevenlabs.io/v1/x', [])).toBeNull()
    expect(netFetchRoute('http://api.elevenlabs.io/v1/x', DECLARED)).toBeNull()
    expect(netFetchRoute('https://api.elevenlabs.io.evil.test/', DECLARED)).toBeNull()
    expect(netFetchRoute('not a url', DECLARED)).toBeNull()
  })
})

describe('declared-origin fetch', () => {
  it('performs the request with redirects refused and returns binary bodies as base64', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff])
    const { perform, seen } = recorder(() => new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    const result = await netOriginsFetch({
      url: 'https://api.elevenlabs.io/v1/text-to-speech/abc?output_format=mp3_22050_32', httpMethod: 'POST',
      headers: [{ name: 'xi-api-key', value: SECRET }], body: '{"text":"hi"}', responseType: 'base64',
    }, DECLARED, perform)
    expect(result).toEqual({ status: 200, contentType: 'audio/mpeg', body: Buffer.from(audio).toString('base64'), bodyEncoding: 'base64' })
    expect(Buffer.from(result.body, 'base64')).toEqual(Buffer.from(audio))
    expect(seen).toHaveLength(1)
    expect(seen[0].init.redirect).toBe('error')
    expect(seen[0].init.method).toBe('POST')
    expect(new Headers(seen[0].init.headers).get('xi-api-key')).toBe(SECRET)
  })

  it('defaults to text, like the private path', async () => {
    const { perform } = recorder(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(netOriginsFetch({ url: 'https://api.elevenlabs.io/v1/user' }, DECLARED, perform))
      .resolves.toEqual({ status: 200, contentType: 'application/json', body: '{"ok":true}', bodyEncoding: 'text' })
  })

  it.each([
    ['an undeclared origin', 'https://api.openai.com/v1/x'],
    ['the declared host over http', 'http://api.elevenlabs.io/v1/x'],
    ['the declared host on another port', 'https://api.elevenlabs.io:444/v1/x'],
    ['credentials in the URL', 'https://user:pw@api.elevenlabs.io/v1/x'],
  ])('refuses %s before any request is made', async (_label, url) => {
    const { perform, seen } = recorder(() => new Response('unreachable'))
    await expect(netOriginsFetch({ url, headers: [{ name: 'xi-api-key', value: SECRET }] }, DECLARED, perform)).rejects.toThrow()
    expect(seen).toEqual([])
  })

  it('refuses a redirect even when the runtime surfaces it as a 3xx instead of throwing', async () => {
    const { perform } = recorder(() => new Response(null, { status: 302, headers: { location: 'https://collector.example/steal' } }))
    await expect(netOriginsFetch({ url: 'https://api.elevenlabs.io/v1/x' }, DECLARED, perform)).rejects.toThrow(/redirect/)
  })

  it('caps the response by declared length and by actual bytes', async () => {
    const declared = recorder(() => new Response('x', { headers: { 'content-length': String(MAX_NET_FETCH_RESPONSE_BYTES + 1) } }))
    await expect(netOriginsFetch({ url: 'https://api.elevenlabs.io/big' }, DECLARED, declared.perform)).rejects.toThrow(/limited/)
    const chunked = recorder(() => new Response(new Uint8Array(MAX_NET_FETCH_RESPONSE_BYTES + 1)))
    await expect(netOriginsFetch({ url: 'https://api.elevenlabs.io/big' }, DECLARED, chunked.perform)).rejects.toThrow(/limited/)
  })

  it('never puts a header value or the sent body into an error the renderer will show', async () => {
    const failures: Array<() => Promise<unknown>> = [
      // Transport failure whose native message embeds the secret.
      () => netOriginsFetch({ url: 'https://api.elevenlabs.io/x', headers: [{ name: 'xi-api-key', value: SECRET }], body: SECRET },
        DECLARED, recorder(() => { throw new TypeError(`fetch failed for ${SECRET}`) }).perform),
      // Invalid header value (a pasted key with an embedded line break; a
      // trailing one is legally trimmed by Headers and would not fail).
      () => netOriginsFetch({ url: 'https://api.elevenlabs.io/x', headers: [{ name: 'xi-api-key', value: `${SECRET}\nX-Injected: 1` }] },
        DECLARED, recorder(() => new Response('')).perform),
      // Undeclared target.
      () => netOriginsFetch({ url: 'https://elsewhere.example/x', headers: [{ name: 'xi-api-key', value: SECRET }] },
        DECLARED, recorder(() => new Response('')).perform),
    ]
    for (const failure of failures) {
      const error = await failure().then(() => null, (reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect(String((error as Error).message)).not.toContain(SECRET)
    }
  })

  it('stops reading a chunked body without Content-Length the moment it passes the cap', async () => {
    // A consented origin that streams forever must not be buffered into main
    // until the timeout (#1151 review). Count what the host actually pulls.
    let pulled = 0, cancelled = false
    const chunk = new Uint8Array(64 * 1024)
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk) },
      cancel() { cancelled = true },
    })
    for (const responseType of ['text', 'base64'] as const) {
      pulled = 0; cancelled = false
      const stream = responseType === 'text' ? endless : new ReadableStream<Uint8Array>({
        pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk) }, cancel() { cancelled = true },
      })
      const { perform } = recorder(() => new Response(stream))
      await expect(netOriginsFetch({ url: 'https://api.elevenlabs.io/stream', responseType }, DECLARED, perform)).rejects.toThrow(/limited/)
      expect(cancelled).toBe(true)
      // A little read-ahead is fine; megabytes are not.
      expect(pulled).toBeLessThanOrEqual(MAX_NET_FETCH_RESPONSE_BYTES + 4 * chunk.byteLength)
    }
  })

  it('refuses host-reserved headers on the public path too, before any request', async () => {
    const { perform, seen } = recorder(() => new Response('ok'))
    for (const name of ['x-agent-code-transport', 'Forwarded', 'X-Forwarded-For', 'x-forwarded-host']) {
      await expect(netOriginsFetch({ url: 'https://api.elevenlabs.io/v1/x', headers: [{ name, value: 'lan' }] }, DECLARED, perform)).rejects.toThrow(/reserved/)
    }
    expect(seen).toHaveLength(0)
  })

  it('keeps default TLS verification: the built request has no dispatcher/agent or verification override', async () => {
    // HTTPS-only is the DNS-rebinding defence, and it holds only while
    // certificate validation is on. Pin the init the host actually builds.
    const { perform, seen } = recorder(() => new Response('ok'))
    await netOriginsFetch({ url: 'https://api.elevenlabs.io/v1/x', httpMethod: 'POST', body: '{}' }, DECLARED, perform)
    const keys = Object.keys(seen[0].init).sort()
    expect(keys).toEqual(['body', 'credentials', 'headers', 'method', 'redirect', 'signal'])
    const init = seen[0].init as Record<string, unknown>
    for (const forbidden of ['dispatcher', 'agent', 'rejectUnauthorized', 'insecure']) expect(init[forbidden]).toBeUndefined()
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0')
  })
})
