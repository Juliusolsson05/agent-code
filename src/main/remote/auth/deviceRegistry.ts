import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Persisted registry of paired remote devices.
//
// This file is the revocation authority: DevicePairing.verifyToken checks a
// token's signature against the install secret AND the device's liveness
// here, so revoking a device on the desktop kills its token instantly even
// though the token itself is stateless and unexpiring. That split is
// deliberate — stateless tokens mean no session table to sync to phones,
// while the registry gives the desktop a kill switch a lost phone can't
// dodge.
//
// Write discipline: full-file JSON, written to a temp file then rename()d.
// Registry mutations are rare (pair / revoke / lastSeen touch), so atomic
// whole-file writes are simpler and safer than append logs — a torn write
// can never half-apply, and load() falls back to empty on any parse failure
// (an unreadable registry means "no devices trusted", failing closed).

export type PairedDevice = {
  deviceId: string
  /** Human label chosen at pairing time, shown in the desktop device list. */
  name: string
  createdAt: number
  /** Epoch ms of the last verified message from this device; null until first use. */
  lastSeenAt: number | null
  revoked: boolean
}

type RegistryFileShape = {
  devices: PairedDevice[]
}

const TOUCH_PERSIST_INTERVAL_MS = 60_000

export class DeviceRegistry {
  private devices = new Map<string, PairedDevice>()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.devices.clear()
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as RegistryFileShape
      if (Array.isArray(parsed?.devices)) {
        for (const d of parsed.devices) {
          if (typeof d?.deviceId === 'string' && typeof d?.name === 'string') {
            this.devices.set(d.deviceId, {
              deviceId: d.deviceId,
              name: d.name,
              createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
              lastSeenAt: typeof d.lastSeenAt === 'number' ? d.lastSeenAt : null,
              revoked: d.revoked === true,
            })
          }
        }
      }
    } catch {
      // Missing or corrupt file → empty registry. Failing CLOSED here is the
      // security-relevant choice: no readable registry, no trusted devices.
    }
  }

  list(): PairedDevice[] {
    return [...this.devices.values()]
  }

  get(deviceId: string): PairedDevice | null {
    return this.devices.get(deviceId) ?? null
  }

  async create(name: string): Promise<PairedDevice> {
    const device: PairedDevice = {
      deviceId: randomUUID(),
      name,
      createdAt: Date.now(),
      lastSeenAt: null,
      revoked: false,
    }
    this.devices.set(device.deviceId, device)
    await this.persist()
    return device
  }

  /** Returns false when the id is unknown — the desktop UI treats that as
   *  already-gone rather than an error. */
  async revoke(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (!device) return false
    device.revoked = true
    await this.persist()
    return true
  }

  /** Stamp lastSeenAt. Persisted best-effort AND throttled: RemoteServer
   *  touches on every verified inbound frame, and rewriting the whole
   *  registry file per message would turn a chatty phone into a disk-write
   *  amplifier. In-memory state updates every time; the file only follows
   *  once a minute. Losing a touch on crash costs a cosmetic timestamp,
   *  not security state (revocation writes go through revoke(), which
   *  always persists). */
  async touch(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId)
    if (!device) return
    const previous = device.lastSeenAt
    device.lastSeenAt = Date.now()
    if (previous !== null && device.lastSeenAt - previous < TOUCH_PERSIST_INTERVAL_MS) return
    await this.persist().catch(() => {})
  }

  private async persist(): Promise<void> {
    const payload: RegistryFileShape = { devices: this.list() }
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    // Unique temp name per write: touch() is fire-and-forget, so two writes
    // can overlap; a shared temp path would let them corrupt each other's
    // rename. rename() itself is atomic on the same filesystem.
    const tmp = join(dirname(this.file), `.devices-${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.file)
  }
}
