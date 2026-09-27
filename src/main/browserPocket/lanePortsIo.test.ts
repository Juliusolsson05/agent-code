import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { LANE_PORT_PROBE_USER_AGENT, listenersFromLsofError, probe } from './lanePortsIo'

// #1409: the probe names itself, so a developer who finds it in a server log
// can tell what sent it, and a long-lived test that counts requests can
// excuse exactly this request instead of "any GET /" or "any node fetch".
// A real loopback socket, because the header is what reaches the server.
let server: Server | null = null
afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
})

it('sends GET / with the lane port probe User-Agent', async () => {
  const seen: Array<{ method?: string; url?: string; ua?: string }> = []
  server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, ua: request.headers['user-agent'] })
    response.setHeader('content-type', 'text/html')
    response.end('<p>ok</p>')
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  expect(await probe(port)).toEqual({ status: 200, contentType: 'text/html' })
  expect(seen).toEqual([{ method: 'GET', url: '/', ua: LANE_PORT_PROBE_USER_AGENT }])
  expect(LANE_PORT_PROBE_USER_AGENT).toMatch(/^AgentCode-LanePortProbe\//)
})

// #1452 review A: only lsof's "nothing matched" (exit 1) is an answer. A
// timeout or missing binary must not read as "every server stopped".
describe('listenersFromLsofError', () => {
  it('exit status 1 is an answer: its stdout is parsed', () => {
    expect(listenersFromLsofError({ code: 1, killed: false, signal: null, stdout: '' })).toEqual([])
  })
  it.each([
    ['a timeout (execFile kills the child)', { code: null, killed: true, signal: 'SIGTERM', stdout: '' }],
    ['a signal', { code: null, killed: false, signal: 'SIGKILL', stdout: '' }],
    ['a missing binary', { code: 'ENOENT', stdout: undefined }],
    ['any other exit status', { code: 2, killed: false, signal: null, stdout: '' }],
  ])('%s throws', (_label, error) => {
    expect(() => listenersFromLsofError(error)).toThrow()
  })
})
