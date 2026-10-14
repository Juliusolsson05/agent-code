import { connect, createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

import { HermesAuthError, HermesStartError } from 'hermes-headless'

import { describeError } from './service'

// #1498: a tailnet Hermes that cannot be reached is almost always Tailscale
// itself, not `hermes serve`. Fixture: a REAL Node socket error from a
// closed loopback port (what fetch/ws hand us), attributed to a tailnet URL.
async function realRefused(): Promise<Error> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return await new Promise<Error>((resolve) => connect(port, '127.0.0.1').on('error', resolve))
}

describe('describeError on a tailnet connection', () => {
  it('names Tailscale for a refused socket on a tailnet URL', async () => {
    const error = await realRefused()
    expect(describeError(error, 'http://100.101.102.103:4860')).toContain('Tailscale address')
    expect(describeError(new HermesStartError('dial', error), 'https://hermes.tail1234.ts.net')).toContain('hermes.tail1234.ts.net')
  })

  it('keeps the server wording for a public URL', () => {
    const refused = new HermesAuthError('transport', 'x', undefined, 'ECONNREFUSED')
    expect(describeError(refused, 'https://hermes-agent-pjlj.srv1921318.hstgr.cloud')).toBe('Hermes refused the connection. Is `hermes serve` running on the server?')
    expect(describeError(refused, 'http://100.101.102.103:4860')).toContain('Tailscale address')
  })
})
