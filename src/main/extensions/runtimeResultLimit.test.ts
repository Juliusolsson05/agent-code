import { describe, expect, it } from 'vitest'

import { MAX_NET_FETCH_RESPONSE_BYTES, netFetch } from './netFetch.js'
import { assertRuntimeApiResult } from './runtimeResultLimit.js'

// A runtime and a view must receive the same net.fetch responses (#1151 design
// review, finding 3). These build REAL broker results (netFetch with an
// injected upstream) and feed them to the runtime channel's admission check.
function upstream(bytes: number, contentType = 'application/octet-stream'): typeof fetch {
  return (async () => new Response(new Uint8Array(bytes).map((_, i) => i * 31), { status: 200, headers: { 'content-type': contentType } })) as unknown as typeof fetch
}
const fetchBinary = (bytes: number, contentType?: string) =>
  netFetch({ url: 'http://192.168.1.20:5192/blob', responseType: 'base64' }, upstream(bytes, contentType))

describe('runtime result admission for net.fetch', () => {
  it.each([
    ['100 KiB (the reported case)', 100 * 1024],
    ['exactly 96 KiB (failed before, after base64 + metadata)', 96 * 1024],
    ['~250 KiB', 250 * 1024],
    ['exactly the broker cap', MAX_NET_FETCH_RESPONSE_BYTES],
  ])('admits a %s binary body the broker returned', async (_label, bytes) => {
    const result = await fetchBinary(bytes)
    expect(result.bodyEncoding).toBe('base64')
    expect(() => assertRuntimeApiResult('net.fetch', result)).not.toThrow()
  })

  it('admits a capped body with a hostile, huge Content-Type (metadata is clamped)', async () => {
    const result = await fetchBinary(MAX_NET_FETCH_RESPONSE_BYTES, `application/x-${'a'.repeat(8000)}`)
    expect(() => assertRuntimeApiResult('net.fetch', result)).not.toThrow()
  })

  it('refuses a body past the broker cap, and the broker never produces one', async () => {
    await expect(fetchBinary(MAX_NET_FETCH_RESPONSE_BYTES + 1)).rejects.toThrow(/limited/)
    const forged = { status: 200, contentType: 'x', bodyEncoding: 'base64', body: 'A'.repeat(Math.ceil((MAX_NET_FETCH_RESPONSE_BYTES + 3) / 3) * 4 + 2048) }
    expect(() => assertRuntimeApiResult('net.fetch', forged)).toThrow(/JSON limits/)
  })

  it('keeps the generic bound for every other method', () => {
    const big = { text: 'x'.repeat(130 * 1024) }
    expect(() => assertRuntimeApiResult('fs.readText', big)).toThrow(/JSON limits/)
    expect(() => assertRuntimeApiResult('service.invoke', big)).toThrow(/JSON limits/)
    expect(() => assertRuntimeApiResult('secrets.get', undefined)).not.toThrow()
  })
})
