import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { DeviceRegistry, PairedDevice } from '@main/remote/auth/deviceRegistry.js'

// QR pairing + device-token mint/verify for the remote mobile companion.
//
// The flow (see the 2026-07-06 spec, "DevicePairing + deviceRegistry"):
//   1. Desktop shows a QR encoding { url, code } — code comes from
//      issuePairingCode(), short-lived and single-use.
//   2. Phone POSTs the code; redeemPairingCode() creates the device in the
//      registry and mints its long-lived token.
//   3. Every WS upgrade and every mutating message carries the token;
//      verifyToken() checks signature + registry liveness.
//
// WHY HMAC tokens instead of random session ids in a table: the token is
// self-authenticating against the install secret, so verification is pure
// CPU — no async registry read on the hot per-message path (the registry
// lookup is an in-memory Map). And there is no expiry in the token ON
// PURPOSE: expiry would force phones to silently re-pair on a timer, which
// for a physical-proximity pairing flow means walking to the desktop. The
// desktop-side revocation switch (registry.revoked) is the kill mechanism,
// and it is instant.
//
// Token wire format: `v1.<deviceId>.<issuedAtMs>.<sigBase64url>` where
// sig = HMAC-SHA256(secret, `v1.<deviceId>.<issuedAtMs>`). The version
// prefix lets a future format rotate without ambiguity; issuedAt is signed
// so it can be trusted for display ("paired since …") even though it is not
// an expiry.

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

// Unambiguous code alphabet — no 0/O, 1/I/L, or lowercase. The code is
// typed by a human off a QR fallback screen; every character class that has
// ever been misread on a screen is excluded. 8 chars over 28 symbols is
// ~48 bits — unguessable within a 5-minute single-use window, especially
// since redemption is a network round-trip per attempt.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 8
const TOKEN_VERSION = 'v1'

export type RedeemResult =
  | { ok: true; token: string; device: PairedDevice }
  | { ok: false; reason: 'invalid-code' | 'expired' }

export type TokenVerdict =
  | { ok: true; deviceId: string }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'unknown-device' | 'revoked' }

export class DevicePairing {
  private readonly secret: Buffer
  private readonly registry: DeviceRegistry
  private readonly now: () => number
  /** Live one-time codes → expiry epoch ms. Codes are few and short-lived;
   *  a Map with lazy expiry checks (no timer) is all this needs. */
  private readonly liveCodes = new Map<string, number>()

  constructor(opts: {
    secret: Buffer
    registry: DeviceRegistry
    /** Injectable clock so tests can cross the TTL without sleeping. */
    now?: () => number
  }) {
    this.secret = opts.secret
    this.registry = opts.registry
    this.now = opts.now ?? Date.now
  }

  issuePairingCode(): { code: string; expiresAt: number } {
    let code = ''
    // Rejection-free sampling: 31 symbols doesn't divide 256, so byte % 31
    // would bias early alphabet letters. randomInt-per-char is fine at this
    // scale, but reading one byte and re-drawing on overflow keeps it
    // dependency-free and obviously uniform.
    while (code.length < CODE_LENGTH) {
      const byte = randomBytes(1)[0]
      const limit = 256 - (256 % CODE_ALPHABET.length)
      if (byte >= limit) continue
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS
    this.liveCodes.set(code, expiresAt)
    return { code, expiresAt }
  }

  async redeemPairingCode(code: string, deviceName: string): Promise<RedeemResult> {
    const expiresAt = this.liveCodes.get(code)
    if (expiresAt === undefined) return { ok: false, reason: 'invalid-code' }
    // Single-use: delete BEFORE the expiry check so an expired code can't be
    // retried either — any observed code is dead after one redemption attempt.
    this.liveCodes.delete(code)
    if (this.now() > expiresAt) return { ok: false, reason: 'expired' }

    const device = await this.registry.create(deviceName)
    return { ok: true, token: this.mintToken(device.deviceId), device }
  }

  mintToken(deviceId: string): string {
    const issuedAt = this.now()
    const body = `${TOKEN_VERSION}.${deviceId}.${issuedAt}`
    return `${body}.${this.sign(body)}`
  }

  verifyToken(token: string): TokenVerdict {
    const parts = token.split('.')
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) {
      return { ok: false, reason: 'malformed' }
    }
    const [version, deviceId, issuedAt, sig] = parts
    if (!deviceId || !/^\d+$/.test(issuedAt) || !sig) {
      return { ok: false, reason: 'malformed' }
    }

    const expected = this.sign(`${version}.${deviceId}.${issuedAt}`)
    const sigBuf = Buffer.from(sig, 'utf8')
    const expectedBuf = Buffer.from(expected, 'utf8')
    // timingSafeEqual throws on length mismatch, so gate on length first —
    // length itself is not secret (signatures are fixed-width).
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: false, reason: 'bad-signature' }
    }

    // Signature is valid — now the registry decides liveness. Order matters:
    // checking the registry first would let an attacker probe which device
    // ids exist using garbage signatures.
    const device = this.registry.get(deviceId)
    if (!device) return { ok: false, reason: 'unknown-device' }
    if (device.revoked) return { ok: false, reason: 'revoked' }
    return { ok: true, deviceId }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }
}
