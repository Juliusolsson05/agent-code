import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteController } from './RemoteController.js'
import type { RemoteSessionControl } from './RemoteServer.js'

// RemoteController is what the desktop actually drives (via remote:* IPC):
// one object owning the whole enable → pair → revoke → disable lifecycle.
// These tests run the real stack underneath (secret file, registry file,
// HTTP server on port 0) — only SessionManager is faked, same as the
// RemoteServer suite.

type FakeManager = RemoteSessionControl & EventEmitter

function makeManager(): FakeManager {
  const emitter = new EventEmitter() as FakeManager
  emitter.list = vi.fn(() => [])
  emitter.getScreenSnapshot = vi.fn(() => null)
  emitter.getConditionsSnapshot = vi.fn(() => null)
  emitter.write = vi.fn(() => true)
  emitter.resolveCondition = vi.fn(async () => ({ ok: true as const }))
  emitter.deliverPromptToAgent = vi.fn(async () => ({ ok: true as const }))
  emitter.getSessionKind = vi.fn(() => 'claude' as const)
  return emitter
}

let dir: string
let controller: RemoteController

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remote-controller-'))
  controller = new RemoteController({
    manager: makeManager() as never,
    stateDir: dir,
  })
})

afterEach(async () => {
  await controller.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
})

describe('RemoteController lifecycle', () => {
  it('starts disabled with no URL', () => {
    expect(controller.getStatus()).toMatchObject({ enabled: false, url: null })
  })

  it('enable exposes a URL; disable clears it; both are idempotent', async () => {
    const enabled = await controller.enable()
    expect(enabled.enabled).toBe(true)
    expect(enabled.url).toMatch(/^http:\/\/[\d.]+:\d+$/)
    // Second enable is a no-op returning the same URL, not a second server.
    expect((await controller.enable()).url).toBe(enabled.url)

    const disabled = await controller.disable()
    expect(disabled).toMatchObject({ enabled: false, url: null })
    await controller.disable() // idempotent
  })

  it('emits status-changed on transitions', async () => {
    const seen: Array<{ enabled: boolean }> = []
    controller.on('status-changed', status => seen.push({ enabled: status.enabled }))
    await controller.enable()
    await controller.disable()
    expect(seen).toEqual([{ enabled: true }, { enabled: false }])
  })
})

describe('pairing through the controller', () => {
  it('issues a pair URL a phone can redeem, then lists and revokes the device', async () => {
    await controller.enable()
    const issued = controller.issuePairingCode()
    expect(issued.pairUrl).toContain(`#code=${issued.code}`)

    // Simulate the phone: extract the base URL, POST the code.
    const base = issued.pairUrl.split('/#')[0].replace(/\/\/[\d.]+:/, '//127.0.0.1:')
    const res = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, deviceName: 'test phone' }),
    })
    expect(res.status).toBe(200)
    const { deviceId } = (await res.json()) as { deviceId: string }

    const devices = controller.getStatus().devices
    expect(devices.map(d => d.name)).toEqual(['test phone'])

    expect(await controller.revokeDevice(deviceId)).toBe(true)
    expect(controller.getStatus().devices[0]?.revoked).toBe(true)
  })

  it('refuses to issue a pairing code while disabled', () => {
    expect(() => controller.issuePairingCode()).toThrowError(/not enabled/)
  })

  it('tunnel mode fails loudly when cloudflared is unresolvable — and LAN still works', async () => {
    // The user-facing guarantee (spec + user request): the feature works
    // locally WITHOUT cloudflared. A missing binary must fail the tunnel
    // attempt with a clear message, leave the controller cleanly disabled,
    // and not poison the LAN path.
    await expect(controller.enable('tunnel')).rejects.toThrow(/LAN mode works without it/)
    expect(controller.getStatus()).toMatchObject({ enabled: false, tunnelAvailable: false })

    const lan = await controller.enable('lan')
    expect(lan.enabled).toBe(true)
    expect(lan.transport).toBe('lan')
  })

  it('remembers paired devices across enable cycles (registry is durable)', async () => {
    await controller.enable()
    const issued = controller.issuePairingCode()
    const base = issued.pairUrl.split('/#')[0].replace(/\/\/[\d.]+:/, '//127.0.0.1:')
    await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, deviceName: 'durable phone' }),
    })
    await controller.disable()
    await controller.enable()
    expect(controller.getStatus().devices.map(d => d.name)).toEqual(['durable phone'])
  })
})
