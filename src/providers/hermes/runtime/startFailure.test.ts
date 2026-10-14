import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

import { HermesAuthError, HermesIncompatibleBackendError, HermesLaneNotFoundError, HermesStartError, RpcError, ConnectionClosedError } from 'hermes-headless'

import { HermesUpgradeRefusedError } from '@main/hermes/openWs'
import { HermesSignedOutError } from '@main/hermes/tokenBroker'
import { classifySpawnFailure } from '@main/ipc/session'
import * as session from '@shared/types/session'

import { classifyHermesStartFailure } from './startFailure'

// #1495: every Hermes start failure used to reach the pane as "Session failed
// to start". Each case below is a failure mode the owner can hit, and the
// assertion is the sentence they would see AFTER the IPC laundering
// (classifySpawnFailure), which is the only text that reaches the renderer.
//
// Fixture provenance: the error OBJECTS are the real classes the package and
// main throw (no hand-written message strings), plus one REAL Node socket
// error from connecting to a closed loopback port. The v0.20.4 handshake
// reply itself is recorded as S25 in hermes-headless and is exercised there
// (RpcConnection maps it to HermesIncompatibleBackendError).

async function realConnectionRefused(): Promise<Error> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return await new Promise<Error>((resolve) => {
    const socket = require('node:net').connect(port, '127.0.0.1')
    socket.on('error', (error: Error) => resolve(error))
  })
}

function shown(error: unknown): string {
  const classified = classifyHermesStartFailure(error)
  return classifySpawnFailure(classified, false).message
}

describe('what a Hermes pane says when it cannot start (#1495)', () => {
  it('says Hermes is too old when the handshake method does not exist (v0.20.4, S25)', () => {
    const error = new HermesStartError('handshake', new HermesIncompatibleBackendError('client.capabilities', -32601))
    expect(shown(error)).toBe(session.HERMES_INCOMPATIBLE_MESSAGE)
    expect(classifyHermesStartFailure(error).detail).toEqual({ rpcCode: -32601, method: 'client.capabilities' })
  })

  it('treats an untyped -32601 during the handshake the same way', () => {
    expect(shown(new HermesStartError('handshake', new RpcError(-32601, 'Method not found', undefined, 'client.capabilities')))).toBe(session.HERMES_INCOMPATIBLE_MESSAGE)
  })

  it('names a refused WebSocket upgrade instead of sending the user to sign in', () => {
    const error = new HermesStartError('dial', new HermesUpgradeRefusedError(403))
    expect(shown(error)).toBe(session.HERMES_WS_REFUSED_MESSAGE)
    expect(classifyHermesStartFailure(error).detail).toEqual({ httpStatus: 403 })
  })

  it('says unreachable for a real refused TCP connection', async () => {
    expect(shown(new HermesStartError('dial', await realConnectionRefused()))).toBe(session.HERMES_UNREACHABLE_MESSAGE)
  })

  it('says unreachable when the ticket mint cannot reach the server', () => {
    expect(shown(new HermesStartError('dial', new HermesAuthError('transport', 'x', undefined, 'ENOTFOUND')))).toBe(session.HERMES_UNREACHABLE_MESSAGE)
  })

  // Review #1503: an unexpected HTTP status is not a sign-in problem.
  it('says unreachable for a 502 from the proxy while minting the ticket, and journals the status', () => {
    const error = new HermesStartError('dial', new HermesAuthError('protocol', 'Connecting: unexpected HTTP 502.', 502))
    expect(shown(error)).toBe(session.HERMES_UNREACHABLE_MESSAGE)
    expect(classifyHermesStartFailure(error).detail).toEqual({ httpStatus: 502 })
  })

  it('says the conversation could not be opened for a 500 from the thread lookup', () => {
    expect(shown(new HermesStartError('attach', new HermesAuthError('protocol', 'Listing: unexpected HTTP 500.', 500)))).toBe(session.HERMES_ATTACH_FAILED_MESSAGE)
  })

  it('says signed out for a dead sign-in', () => {
    expect(shown(new HermesStartError('dial', new HermesSignedOutError('c1')))).toBe(session.HERMES_SIGNED_OUT_MESSAGE)
  })

  it('says the handshake did not finish when the socket closes before ready', () => {
    expect(shown(new HermesStartError('handshake', new ConnectionClosedError(null, 1006, '')))).toBe(session.HERMES_HANDSHAKE_FAILED_MESSAGE)
  })

  it('says the conversation could not be opened when resume is refused after connecting', () => {
    const error = new HermesStartError('attach', new RpcError(5000, 'boom', undefined, 'session.resume'))
    expect(shown(error)).toBe(session.HERMES_ATTACH_FAILED_MESSAGE)
    expect(classifyHermesStartFailure(error).detail).toEqual({ rpcCode: 5000, method: 'session.resume' })
  })

  it('says there is no Telegram thread when the lane has no live conversation', () => {
    expect(shown(new HermesStartError('attach', new HermesLaneNotFoundError('agent:main:telegram:dm:1')))).toBe(session.HERMES_LANE_NOT_FOUND_MESSAGE)
  })

  it('never lets server text through for something it cannot name', () => {
    expect(shown(new Error('Traceback … token=sk-secret'))).toBe(session.SESSION_START_FAILED_MESSAGE)
  })
})
