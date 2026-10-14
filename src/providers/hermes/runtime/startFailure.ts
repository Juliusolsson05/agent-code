// Why a Hermes pane did not start, as one curated sentence + a journal stage
// (#1495).
//
// The owner's first connection (2026-10-14) failed against a v0.20.4 server
// whose handshake answered JSON-RPC -32601, and the pane said "Session failed
// to start. Check provider setup and retry." The cause was only in main's
// stdout. Every branch below exists because a real failure mode was otherwise
// indistinguishable on screen:
//
//   cause                                   → stage           sentence
//   the app's own sign-out / missing conn    → signed-out / not-connected
//   network (refused, DNS, timeout, TLS)     → unreachable
//   HTTP upgrade refused (401/403/502…)      → ws-refused      (status journaled)
//   -32601/-32602 on the handshake           → incompatible    (code journaled)
//   handshake never completed                → handshake
//   resume/create refused after connecting   → attach          (code journaled)
//   no live Telegram lane on the server      → lane-not-found
//
// WHY sentences are fixed constants (session.ts) and never built from the
// error: IPC laundering (classifySpawnFailure) only lets a sentence through
// when it IS one of the constants, because upstream error text can carry
// server detail. Numbers (codes, statuses) go to the journal only, through
// RemoteProviderStartError.

import {
  HermesAuthError,
  HermesIncompatibleBackendError,
  HermesLaneNotFoundError,
  HermesStartError,
  INCOMPATIBLE_RPC_CODES,
  RpcError,
} from 'hermes-headless'

import { HermesConnectionMissingError } from '@main/hermes/service.js'
import { HermesUpgradeRefusedError } from '@main/hermes/openWs.js'
import { HermesSignedOutError } from '@main/hermes/tokenBroker.js'
import { RemoteProviderStartError } from '@shared/errors/remoteProviderStartError.js'
import {
  HERMES_ATTACH_FAILED_MESSAGE,
  HERMES_HANDSHAKE_FAILED_MESSAGE,
  HERMES_INCOMPATIBLE_MESSAGE,
  HERMES_LANE_NOT_FOUND_MESSAGE,
  HERMES_NOT_CONNECTED_MESSAGE,
  HERMES_SIGNED_OUT_MESSAGE,
  HERMES_UNREACHABLE_MESSAGE,
  HERMES_WS_REFUSED_MESSAGE,
  SESSION_START_FAILED_MESSAGE,
} from '@shared/types/session.js'

/** Node socket error codes that mean "the network path failed", not "Hermes said no". */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'])

function networkCode(error: unknown): string | null {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof code === 'string' && NETWORK_CODES.has(code) ? code : null
}

export function classifyHermesStartFailure(error: unknown): RemoteProviderStartError {
  const stage = error instanceof HermesStartError ? error.stage : null
  const cause = error instanceof HermesStartError ? error.cause : error

  if (cause instanceof HermesSignedOutError) return new RemoteProviderStartError(HERMES_SIGNED_OUT_MESSAGE, 'signed-out')
  if (cause instanceof HermesConnectionMissingError) return new RemoteProviderStartError(HERMES_NOT_CONNECTED_MESSAGE, 'not-connected')
  if (cause instanceof HermesLaneNotFoundError) return new RemoteProviderStartError(HERMES_LANE_NOT_FOUND_MESSAGE, 'lane-not-found')
  if (cause instanceof HermesIncompatibleBackendError) {
    return new RemoteProviderStartError(HERMES_INCOMPATIBLE_MESSAGE, 'incompatible', { rpcCode: cause.code, method: cause.method })
  }
  if (cause instanceof HermesUpgradeRefusedError) {
    return new RemoteProviderStartError(HERMES_WS_REFUSED_MESSAGE, 'ws-refused', { httpStatus: cause.status })
  }
  if (cause instanceof HermesAuthError) {
    if (cause.kind === 'transport' || cause.kind === 'unavailable') {
      return new RemoteProviderStartError(HERMES_UNREACHABLE_MESSAGE, 'unreachable', cause.status !== undefined ? { httpStatus: cause.status } : {})
    }
    // `protocol` is ANY unexpected HTTP status or a malformed body: a
    // Traefik 502/504 while Hermes restarts, a 500, a 404 from a dashboard
    // without the route. Never "sign in again" (review, #1503): that was the
    // very trap #1495 removed. Unreachable while connecting, otherwise the
    // conversation could not be opened.
    if (cause.kind === 'protocol') {
      const detail = cause.status !== undefined ? { httpStatus: cause.status } : {}
      return stage === 'attach'
        ? new RemoteProviderStartError(HERMES_ATTACH_FAILED_MESSAGE, 'attach', detail)
        : new RemoteProviderStartError(HERMES_UNREACHABLE_MESSAGE, 'unreachable', detail)
    }
    // access-expired / session-expired / auth-rejected: the broker has
    // already tried its one refresh; this sign-in is not usable.
    return new RemoteProviderStartError(HERMES_SIGNED_OUT_MESSAGE, 'signed-out', cause.status !== undefined ? { httpStatus: cause.status } : {})
  }
  if (networkCode(cause)) return new RemoteProviderStartError(HERMES_UNREACHABLE_MESSAGE, 'unreachable')
  if (stage === 'handshake') {
    // An older server can also refuse a handshake call the package does not
    // type itself (a future first-use method); same fix, update Hermes.
    if (cause instanceof RpcError && INCOMPATIBLE_RPC_CODES.has(cause.code)) {
      return new RemoteProviderStartError(HERMES_INCOMPATIBLE_MESSAGE, 'incompatible', { rpcCode: cause.code, ...(cause.method ? { method: cause.method } : {}) })
    }
    return new RemoteProviderStartError(HERMES_HANDSHAKE_FAILED_MESSAGE, 'handshake', cause instanceof RpcError ? { rpcCode: cause.code } : {})
  }
  if (stage === 'attach') {
    return new RemoteProviderStartError(HERMES_ATTACH_FAILED_MESSAGE, 'attach', cause instanceof RpcError ? { rpcCode: cause.code, ...(cause.method ? { method: cause.method } : {}) } : {})
  }
  if (stage === 'dial') return new RemoteProviderStartError(HERMES_UNREACHABLE_MESSAGE, 'unreachable')
  return new RemoteProviderStartError(SESSION_START_FAILED_MESSAGE, 'unknown')
}
