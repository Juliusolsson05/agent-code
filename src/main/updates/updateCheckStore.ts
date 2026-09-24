import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'
import { isUpdateChannel, type UpdateChannel } from '@shared/updates/updateChannel.js'

// Two values: the last automatic check time (at most one write per 4h
// window) and, since #1168, the update channel the user chose. A whole store
// abstraction for that would be heavier than the data; a hand-rolled atomic
// write is smaller and auditable. WHY atomic anyway: a crash mid-write must
// never leave a corrupt file that turns "skip one check" into "treat as never
// checked" forever, or silently drops a Preview choice back to Stable — the
// rename is the only commit point, exactly like the extension grants store.
//
// WHY the channel lives here and not in renderer Settings: main applies it
// before any window exists (the first check runs 3 minutes after launch, and
// a window may never open), and renderer Settings are localStorage. One file
// keeps "everything the updater remembers" in one place.

const FILE = () => join(STATE_DIR, 'updates.json')

type UpdateStoreShape = { lastCheckAt?: number; channel?: UpdateChannel }

/** Cached read: constructed once at startup; checkForUpdates() must stay
 *  synchronous in the service, so the file is read eagerly and the values
 *  held in memory. A missing/corrupt file reads as "never checked" and "no
 *  channel chosen". */
export class UpdateCheckStore {
  private lastCheckAt: number | undefined
  private channel: UpdateChannel | undefined
  private readonly loaded: Promise<void>

  constructor() {
    this.loaded = readFile(FILE(), 'utf8')
      .then(text => {
        const parsed = JSON.parse(text) as Partial<Record<keyof UpdateStoreShape, unknown>>
        // A value written BEFORE this read finished is newer than the file,
        // so it wins: a check clock only moves forward, and a channel the user
        // just chose must not be replaced by the one on disk.
        if (typeof parsed.lastCheckAt === 'number' && Number.isFinite(parsed.lastCheckAt)) {
          this.lastCheckAt = Math.max(this.lastCheckAt ?? parsed.lastCheckAt, parsed.lastCheckAt)
        }
        // An unknown value (a hand edit, a future channel) reads as "not
        // chosen", which falls back to the version-derived default rather
        // than guessing a channel.
        if (this.channel === undefined && isUpdateChannel(parsed.channel)) this.channel = parsed.channel
      })
      .catch(() => { /* absent or unreadable: never checked, no choice */ })
  }

  /** Resolves once the file has been read. The IPC read of the channel waits
   *  for it, so Settings never shows a default that is about to change. */
  ready(): Promise<void> {
    return this.loaded
  }

  read(): number | undefined {
    return this.lastCheckAt
  }

  readChannel(): UpdateChannel | undefined {
    return this.channel
  }

  async write(at: number): Promise<void> {
    this.lastCheckAt = at
    await this.persist()
  }

  async writeChannel(channel: UpdateChannel): Promise<void> {
    this.channel = channel
    await this.persist()
  }

  private async persist(): Promise<void> {
    // After the initial read, so a write racing startup can never be
    // overwritten by (or overwrite) values that were already on disk.
    await this.loaded
    await mkdir(STATE_DIR, { recursive: true })
    const target = FILE()
    const staging = `${target}.tmp-${process.pid}-${Date.now()}`
    const shape: UpdateStoreShape = {
      ...(this.lastCheckAt !== undefined ? { lastCheckAt: this.lastCheckAt } : {}),
      ...(this.channel !== undefined ? { channel: this.channel } : {}),
    }
    try {
      await writeFile(staging, `${JSON.stringify(shape)}\n`, 'utf8')
      await rename(staging, target)
    } finally {
      await rm(staging, { force: true }).catch(() => {})
    }
  }
}
