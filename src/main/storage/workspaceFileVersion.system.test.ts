import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #1013 review A, BLOCKER. The v3 stage document kept the OUTER file version
// at 2. Every older build, including the released v0.0.2-beta.1, therefore
// saw a v3 file as an ordinary writable v2 file. A downgrade followed by a
// two-window close then ran the old build's window handoff, whose autosave
// dropped every session it could not read, and the whole pool was deleted
// from disk (reproduced in review against the beta's code).
//
// The fix is the version gate those builds already have. Their decoder
// refuses any version other than 2 as `unreadable` and runs READ-ONLY. That
// behaviour exists exactly for a newer file (workspaceFile.ts, "a NEWER
// version written by a future build"). Writing 3 hands them that refusal.
//
// Inputs are REAL: the live v2 workspace.json the app persisted on
// 2026-09-19, sanitized (testing/fixtures/workspace-v2/README.md). The store
// runs against the real filesystem in a temp directory. Only the state path
// is redirected, the same seam the existing store tests use.

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR ?? '/tmp'}/agent-code-ws-version-${process.pid}-${Date.now()}`,
  failBackups: 0,
}))
vi.mock('@main/storage/paths.js', () => ({ STATE_DIR: h.dir, STATE_FILE: `${h.dir}/workspace.json` }))
// Only the BACKUP write can be made to fail, the way a full disk fails it:
// the file is created (`wx` succeeded), a prefix lands, then ENOSPC. The
// verification review reproduced exactly this on a real 1 MB disk image.
vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...real,
    writeFile: async (path: string, data: string, options: unknown) => {
      if (h.failBackups > 0 && String(path).endsWith('.bak')) {
        h.failBackups -= 1
        await real.writeFile(path, String(data).slice(0, 10), { flag: 'wx' })
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return real.writeFile(path, data as string, options as never)
    },
  }
})

const { WORKSPACE_FILE_VERSION, parseWorkspaceFile, serializeWorkspaceFile } = await import('@main/storage/workspaceFile.js')
const { WorkspaceFileStore } = await import('@main/storage/workspaceFileStore.js')

const fixture = resolve(__dirname, '../../../testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json')
let id = 0
const mint = () => `minted-${++id}`

beforeEach(async () => { h.failBackups = 0; await mkdir(h.dir, { recursive: true }) })
afterEach(async () => { await rm(h.dir, { recursive: true, force: true }) })

describe('workspace file version (#1013 downgrade safety)', () => {
  it('writes version 3, so every build that only understands 2 refuses the file and goes read-only', async () => {
    const parsed = parseWorkspaceFile(await readFile(fixture, 'utf8'), mint)
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    const written = JSON.parse(serializeWorkspaceFile(parsed.file)) as { version: unknown }
    expect(WORKSPACE_FILE_VERSION).toBe(3)
    // The released beta's gate is `parsed.version !== 2 → unreadable`
    // (workspaceFile.ts on v0.0.2-beta.1). Anything this build writes must
    // trip it.
    expect(written.version).not.toBe(2)
  })

  it('still reads a real v2 file with every window and session intact', async () => {
    const raw = JSON.parse(await readFile(fixture, 'utf8')) as { version: number, windows: { workspace: { sessions: Record<string, unknown> } }[] }
    expect(raw.version).toBe(2)
    const parsed = parseWorkspaceFile(JSON.stringify(raw), mint)
    expect(parsed).toMatchObject({ kind: 'ok', completeness: { kind: 'complete' } })
    if (parsed.kind !== 'ok') return
    expect(parsed.file.windows).toHaveLength(raw.windows.length)
    expect(Object.keys((parsed.file.windows[0]!.workspace as { sessions: object }).sessions))
      .toEqual(Object.keys(raw.windows[0]!.workspace.sessions))
  })

  it('refuses a version it does not know as unreadable instead of guessing', () => {
    expect(parseWorkspaceFile(JSON.stringify({ version: 4, windows: [] }), mint)).toMatchObject({ kind: 'unreadable' })
  })

  it('keeps the original v2 bytes in a one-time backup before its first v3 write', async () => {
    await copyFile(fixture, `${h.dir}/workspace.json`)
    const original = await readFile(fixture, 'utf8')
    const store = await WorkspaceFileStore.open()
    const [window] = store.windows()
    // The renderer's real save shape: a `{ workspace }` payload plus the
    // window's geometry, exactly what workspace:save sends.
    const geometry = { bounds: window!.bounds, displayId: window!.displayId, fullScreen: window!.fullScreen }
    await store.saveSlice(window!.windowId, JSON.stringify({ workspace: window!.workspace }), geometry)
    await store.saveSlice(window!.windowId, JSON.stringify({ workspace: window!.workspace }), geometry)
    const backups = (await readdir(h.dir)).filter(name => name.startsWith('workspace.json.pre-v3-') && name.endsWith('.bak'))
    // Exactly one: the conversion is one-way for older builds, so the only
    // way back is the untouched original, taken once and never overwritten.
    expect(backups).toHaveLength(1)
    expect(await readFile(`${h.dir}/${backups[0]}`, 'utf8')).toBe(original)
    expect((JSON.parse(await readFile(`${h.dir}/workspace.json`, 'utf8')) as { version: number }).version).toBe(3)
  })

  it('a backup that fails mid-write leaves no truncated file named like a backup', async () => {
    // #1013 verification review: a failed attempt left a 0-byte
    // `workspace.json.pre-v3-<ts>.bak`, and each retry used a new timestamp.
    // The EARLIEST backup, the one a user would take as "the original", was
    // then the empty one.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await copyFile(fixture, `${h.dir}/workspace.json`)
    const original = await readFile(fixture, 'utf8')
    const store = await WorkspaceFileStore.open()
    const [window] = store.windows()
    const geometry = { bounds: window!.bounds, displayId: window!.displayId, fullScreen: window!.fullScreen }
    h.failBackups = 1
    await store.saveSlice(window!.windowId, JSON.stringify({ workspace: window!.workspace }), geometry)
    await store.saveSlice(window!.windowId, JSON.stringify({ workspace: window!.workspace }), geometry)
    const backups = (await readdir(h.dir)).filter(name => name.startsWith('workspace.json.pre-v3-') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(await readFile(`${h.dir}/${backups[0]}`, 'utf8')).toBe(original)
  })
})
