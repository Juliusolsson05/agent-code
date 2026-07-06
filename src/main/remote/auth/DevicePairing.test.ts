import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DevicePairing, PAIRING_CODE_TTL_MS } from './DevicePairing.js'
import { DeviceRegistry } from './deviceRegistry.js'

let dir: string
let registry: DeviceRegistry
let now: number
const clock = (): number => now

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remote-pairing-'))
  registry = new DeviceRegistry(join(dir, 'devices.json'))
  await registry.load()
  now = 1_000_000
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makePairing(secret = randomBytes(32)): DevicePairing {
  return new DevicePairing({ secret, registry, now: clock })
}

describe('pairing codes', () => {
  it('redeeming a live code creates a device and returns a verifiable token', async () => {
    const pairing = makePairing()
    const { code } = pairing.issuePairingCode()
    const redeemed = await pairing.redeemPairingCode(code, 'Julius iPhone')
    expect(redeemed.ok).toBe(true)
    if (!redeemed.ok) return
    expect(registry.get(redeemed.device.deviceId)?.name).toBe('Julius iPhone')

    const verdict = pairing.verifyToken(redeemed.token)
    expect(verdict).toEqual({ ok: true, deviceId: redeemed.device.deviceId })
  })

  it('codes are single-use', async () => {
    const pairing = makePairing()
    const { code } = pairing.issuePairingCode()
    expect((await pairing.redeemPairingCode(code, 'a')).ok).toBe(true)
    const second = await pairing.redeemPairingCode(code, 'b')
    expect(second).toEqual({ ok: false, reason: 'invalid-code' })
  })

  it('codes expire after the TTL', async () => {
    const pairing = makePairing()
    const { code } = pairing.issuePairingCode()
    now += PAIRING_CODE_TTL_MS + 1
    const redeemed = await pairing.redeemPairingCode(code, 'late phone')
    expect(redeemed).toEqual({ ok: false, reason: 'expired' })
  })

  it('unknown codes are rejected', async () => {
    const pairing = makePairing()
    pairing.issuePairingCode()
    const redeemed = await pairing.redeemPairingCode('WRONGCODE', 'x')
    expect(redeemed).toEqual({ ok: false, reason: 'invalid-code' })
  })
})

describe('token verification', () => {
  it('rejects tampered tokens', async () => {
    const pairing = makePairing()
    const { code } = pairing.issuePairingCode()
    const redeemed = await pairing.redeemPairingCode(code, 'phone')
    if (!redeemed.ok) throw new Error('setup failed')
    const tampered = redeemed.token.slice(0, -2) + 'zz'
    expect(pairing.verifyToken(tampered).ok).toBe(false)
  })

  it('rejects tokens signed with a different secret', async () => {
    const pairingA = makePairing(randomBytes(32))
    const { code } = pairingA.issuePairingCode()
    const redeemed = await pairingA.redeemPairingCode(code, 'phone')
    if (!redeemed.ok) throw new Error('setup failed')

    const pairingB = makePairing(randomBytes(32))
    expect(pairingB.verifyToken(redeemed.token)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('rejects tokens for revoked devices', async () => {
    const pairing = makePairing()
    const { code } = pairing.issuePairingCode()
    const redeemed = await pairing.redeemPairingCode(code, 'lost phone')
    if (!redeemed.ok) throw new Error('setup failed')
    await registry.revoke(redeemed.device.deviceId)
    expect(pairing.verifyToken(redeemed.token)).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  it('rejects malformed tokens without throwing', () => {
    const pairing = makePairing()
    for (const bad of ['', 'v1', 'v1.a.b', 'nonsense tokens everywhere', 'v2.x.1.sig']) {
      const verdict = pairing.verifyToken(bad)
      expect(verdict.ok).toBe(false)
    }
  })
})
