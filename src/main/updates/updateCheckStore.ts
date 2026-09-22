import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'

// One number, written at most once per auto-update check window (4h). A whole
// store abstraction for that would be heavier than the data; a hand-rolled
// atomic write is smaller and auditable. WHY atomic anyway: a crash mid-write
// must never leave a corrupt file that turns "skip one check" into "treat as
// never checked" forever — the rename is the only commit point, exactly like
// the extension grants store.

const FILE = () => join(STATE_DIR, 'updates.json')

type UpdateStoreShape = { lastCheckAt: number }

/** Cached read: constructed once at startup; checkForUpdates() must stay
 *  synchronous in the service, so the file is read eagerly and the value held
 *  in memory. A missing/corrupt file reads as "never checked". */
export class UpdateCheckStore {
  private cached: number | undefined
  private loaded: Promise<void>

  constructor() {
    this.loaded = readFile(FILE(), 'utf8')
      .then(text => {
        const parsed = JSON.parse(text) as Partial<UpdateStoreShape>
        if (typeof parsed.lastCheckAt === 'number' && Number.isFinite(parsed.lastCheckAt)) {
          this.cached = parsed.lastCheckAt
        }
      })
      .catch(() => { /* absent or unreadable: never-checked */ })
  }

  read(): number | undefined {
    return this.cached
  }

  async write(at: number): Promise<void> {
    this.cached = at
    await this.loaded
    await mkdir(STATE_DIR, { recursive: true })
    const target = FILE()
    const staging = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(staging, `${JSON.stringify({ lastCheckAt: at })}\n`, 'utf8')
      await rename(staging, target)
    } finally {
      await rm(staging, { force: true }).catch(() => {})
    }
  }
}

