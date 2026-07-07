import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadOrCreateRemoteSecret, REMOTE_SECRET_BYTES } from './secret.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remote-secret-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadOrCreateRemoteSecret', () => {
  it('creates a new secret with owner-only permissions on first call', async () => {
    const secret = await loadOrCreateRemoteSecret(dir)
    expect(secret.length).toBe(REMOTE_SECRET_BYTES)
    const s = await stat(join(dir, 'secret'))
    // 0o600 — the secret signs device tokens; any wider mode leaks the
    // ability to mint valid remote-control tokens to other local users.
    expect(s.mode & 0o777).toBe(0o600)
  })

  it('returns the same secret on subsequent calls', async () => {
    const first = await loadOrCreateRemoteSecret(dir)
    const second = await loadOrCreateRemoteSecret(dir)
    expect(second.equals(first)).toBe(true)
  })

  it('regenerates when the stored secret is corrupt', async () => {
    await loadOrCreateRemoteSecret(dir)
    await writeFile(join(dir, 'secret'), 'not-hex-garbage', 'utf8')
    const regenerated = await loadOrCreateRemoteSecret(dir)
    expect(regenerated.length).toBe(REMOTE_SECRET_BYTES)
    // The rewritten file must be valid for the NEXT boot too.
    const onDisk = (await readFile(join(dir, 'secret'), 'utf8')).trim()
    expect(Buffer.from(onDisk, 'hex').equals(regenerated)).toBe(true)
  })
})
