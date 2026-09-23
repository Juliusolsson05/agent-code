import { describe, expect, it } from 'vitest'

import { MAX_NET_FETCH_RESPONSE_BYTES } from './netFetch.js'
import { netFetchRoute, netOriginsFetch } from './netOrigins.js'

// The declared-origin path carries credentials (an API key header is the
// typical case). These tests pin the promises the consent dialog
// makes: only the listed origins, never a hop elsewhere, bounded answers, and
// no header value ever echoed back into error text the renderer displays.

const DECLARED = ['https://api.example.com']
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
    expect(netFetchRoute('https://api.example.com/v1/x', DECLARED)).toBe('net.origins')
    expect(netFetchRoute('https://api.example.com/v1/x', [])).toBeNull()
    expect(netFetchRoute('http://api.example.com/v1/x', DECLARED)).toBeNull()
    expect(netFetchRoute('https://api.example.com.evil.test/', DECLARED)).toBeNull()
    expect(netFetchRoute('not a url', DECLARED)).toBeNull()
  })
})

describe('declared-origin fetch', () => {
  it('performs the request with redirects refused and returns binary bodies as base64', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff])
    const { perform, seen } = recorder(() => new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    const result = await netOriginsFetch({
      url: 'https://api.example.com/v1/render/abc?format=mp3', httpMethod: 'POST',
      headers: [{ name: 'x-api-key', value: SECRET }], body: '{"text":"hi"}', responseType: 'base64',
    }, DECLARED, perform)
    expect(result).toEqual({ status: 200, contentType: 'audio/mpeg', body: Buffer.from(audio).toString('base64'), bodyEncoding: 'base64' })
    expect(Buffer.from(result.body, 'base64')).toEqual(Buffer.from(audio))
    expect(seen).toHaveLength(1)
    expect(seen[0].init.redirect).toBe('error')
    expect(seen[0].init.method).toBe('POST')
    expect(new Headers(seen[0].init.headers).get('x-api-key')).toBe(SECRET)
  })

  it('defaults to text, like the private path', async () => {
    const { perform } = recorder(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(netOriginsFetch({ url: 'https://api.example.com/v1/user' }, DECLARED, perform))
      .resolves.toEqual({ status: 200, contentType: 'application/json', body: '{"ok":true}', bodyEncoding: 'text' })
  })

  it.each([
    ['an undeclared origin', 'https://api.other.example/v1/x'],
    ['the declared host over http', 'http://api.example.com/v1/x'],
    ['the declared host on another port', 'https://api.example.com:444/v1/x'],
    ['credentials in the URL', 'https://user:pw@api.example.com/v1/x'],
  ])('refuses %s before any request is made', async (_label, url) => {
    const { perform, seen } = recorder(() => new Response('unreachable'))
    await expect(netOriginsFetch({ url, headers: [{ name: 'x-api-key', value: SECRET }] }, DECLARED, perform)).rejects.toThrow()
    expect(seen).toEqual([])
  })

  // Redirect refusal is shared with the private route and tested once, for
  // both routes, in netFetch.test.ts.

  it('caps the response by declared length and by actual bytes', async () => {
    const declared = recorder(() => new Response('x', { headers: { 'content-length': String(MAX_NET_FETCH_RESPONSE_BYTES + 1) } }))
    await expect(netOriginsFetch({ url: 'https://api.example.com/big' }, DECLARED, declared.perform)).rejects.toThrow(/limited/)
    const chunked = recorder(() => new Response(new Uint8Array(MAX_NET_FETCH_RESPONSE_BYTES + 1)))
    await expect(netOriginsFetch({ url: 'https://api.example.com/big' }, DECLARED, chunked.perform)).rejects.toThrow(/limited/)
  })

  it('never puts a header value or the sent body into an error the renderer will show', async () => {
    const failures: Array<() => Promise<unknown>> = [
      // Transport failure whose native message embeds the secret.
      () => netOriginsFetch({ url: 'https://api.example.com/x', headers: [{ name: 'x-api-key', value: SECRET }], body: SECRET },
        DECLARED, recorder(() => { throw new TypeError(`fetch failed for ${SECRET}`) }).perform),
      // Invalid header value (a pasted key with an embedded line break; a
      // trailing one is legally trimmed by Headers and would not fail).
      () => netOriginsFetch({ url: 'https://api.example.com/x', headers: [{ name: 'x-api-key', value: `${SECRET}\nX-Injected: 1` }] },
        DECLARED, recorder(() => new Response('')).perform),
      // Undeclared target.
      () => netOriginsFetch({ url: 'https://elsewhere.example/x', headers: [{ name: 'x-api-key', value: SECRET }] },
        DECLARED, recorder(() => new Response('')).perform),
    ]
    for (const failure of failures) {
      const error = await failure().then(() => null, (reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect(String((error as Error).message)).not.toContain(SECRET)
    }
  })

  // The streamed (no Content-Length) cap is enforced by the shared reader
  // both routes use; it is tested once in netFetch.test.ts.

  it('refuses host-reserved headers on the public path too, before any request', async () => {
    const { perform, seen } = recorder(() => new Response('ok'))
    for (const name of ['x-agent-code-transport', 'Forwarded', 'X-Forwarded-For', 'x-forwarded-host']) {
      await expect(netOriginsFetch({ url: 'https://api.example.com/v1/x', headers: [{ name, value: 'lan' }] }, DECLARED, perform)).rejects.toThrow(/reserved/)
    }
    expect(seen).toHaveLength(0)
  })

  it('TRIPWIRE: the built request keeps default TLS verification (no dispatcher/agent or verification override)', async () => {
    // A TRIPWIRE, not a behavioural test: it cannot prove certificates are
    // validated (that needs a real TLS peer); it fails the moment someone adds
    // an init key or env override that COULD turn validation off. HTTPS-only
    // is the DNS-rebinding defence, and it holds only while certificate
    // validation is on — so any new key here must be reviewed against that,
    // not just added to the expected list.
    const { perform, seen } = recorder(() => new Response('ok'))
    await netOriginsFetch({ url: 'https://api.example.com/v1/x', httpMethod: 'POST', body: '{}' }, DECLARED, perform)
    const keys = Object.keys(seen[0].init).sort()
    expect(keys).toEqual(['body', 'credentials', 'headers', 'method', 'redirect', 'signal'])
    const init = seen[0].init as Record<string, unknown>
    for (const forbidden of ['dispatcher', 'agent', 'rejectUnauthorized', 'insecure']) expect(init[forbidden]).toBeUndefined()
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0')
  })
})
