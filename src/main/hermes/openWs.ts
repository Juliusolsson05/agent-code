// Open the Hermes gateway WebSocket for one dial.
//
// Split out of service.ts so the start-failure classifier
// (providers/hermes/runtime/startFailure.ts) can recognise a refused upgrade
// by TYPE without importing the whole connection service.

import WebSocket from 'ws'

import { HERMES_GATEWAY_SUBPROTOCOL, type WebSocketLike } from 'hermes-headless'

// Hermes' own client allows 15 s for the socket to open (json-rpc-gateway.ts
// DEFAULT_CONNECT_TIMEOUT_MS); a VPS over a VPN can be slow, never longer.
const OPEN_TIMEOUT_MS = 15_000
// A resume of a long conversation is one frame (S12: 120 rows); Hermes caps
// transcripts it will send far below this.
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

/**
 * The HTTP upgrade was answered with a status instead of 101.
 *
 * WHY its own type and NOT "sign in again" (r5, #1495): uvicorn turns EVERY
 * pre-accept close into a bodiless 403 (a bad or spent ticket 4401, the
 * Host/Origin check 4403, chat disabled), and a reverse proxy adds its own
 * 502/504. The old text, "Hermes refused the connection ticket. Sign in
 * again.", sent the user to Settings for failures signing in cannot fix. The
 * status is journaled; the pane gets one honest sentence.
 */
export class HermesUpgradeRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Hermes refused the WebSocket upgrade (HTTP ${status}).`)
    this.name = 'HermesUpgradeRefusedError'
  }
}

/**
 * `protocols` carries the ticket (`hermes-gateway-ticket.<t>`, see
 * hermes-headless buildWsUrl for why it left the URL). Hermes answers with
 * the gateway subprotocol ALONE; anything else means the server did not take
 * the ticket from the header (or something in between rewrote the
 * handshake), and the connection is refused here rather than half-working.
 */
export function openWs(url: string, protocols: string[]): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, { maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: OPEN_TIMEOUT_MS })
    const fail = (error: Error) => {
      socket.removeAllListeners('open')
      reject(error)
    }
    socket.once('open', () => {
      socket.removeAllListeners('error')
      // `ws` emits 'error' before 'close'; a listener must exist or Node
      // treats it as unhandled. RpcConnection reacts to the close event.
      socket.on('error', () => undefined)
      if (socket.protocol !== HERMES_GATEWAY_SUBPROTOCOL) {
        socket.close(1002, 'unexpected subprotocol')
        reject(new HermesUpgradeRefusedError(101))
        return
      }
      resolve(socket as unknown as WebSocketLike)
    })
    socket.once('error', fail)
    socket.once('unexpected-response', (request, response) => {
      // With this listener attached `ws` leaves the refused request open.
      request.destroy()
      fail(new HermesUpgradeRefusedError(response.statusCode ?? 0))
    })
  })
}
