import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { newestCodexStateDb, openReadOnlySqlite } from './sqlite.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('read-only sqlite helper', () => {
  it('picks the highest state_N file and refuses a missing required column', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sqlite-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    await writeFile(join(home, 'state_4.sqlite'), '')
    const newest = join(home, 'state_12.sqlite')
    const db = new DatabaseSync(newest)
    db.exec('create table threads (id text, cwd text);')
    db.close()
    expect(newestCodexStateDb(home)).toBe(newest)
    const missing = openReadOnlySqlite(newest, { threads: ['id', 'cwd', 'recency_at_ms'] })
    expect(missing).toMatchObject({ ok: false, reason: expect.stringContaining('recency_at_ms') })
    const ok = openReadOnlySqlite(newest, { threads: ['id', 'cwd'] })
    if (!ok.ok) throw new Error(ok.reason)
    expect(() => ok.db.exec("insert into threads values ('x','y')")).toThrow()
    ok.close()
  })

  it('reports an unreadable file as a reason, never a throw', () => {
    const result = openReadOnlySqlite('/nonexistent/state_1.sqlite', { threads: ['id'] })
    expect(result.ok).toBe(false)
    expect(newestCodexStateDb('/nonexistent')).toBeNull()
  })
})
