import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #826. `commit()` writes `workspace.json.<pid>.<timestamp>.<nonce>.tmp` and
// renames it over the real file. Cleanup runs only in the `catch` of a thrown
// write or rename — so a process that DIES between creating the temp file and
// finishing the write leaves a zero-byte scratch file nothing ever removes.
// The ⌘Q `beforeunload` flush, which this file's own comment calls "the
// highest-collision moment in the app's life", is exactly such a moment; so is
// a crash or a `kill`.
//
// 80 of them had accumulated in one real profile, 2026-05-14 to 2026-09-04,
// growing by a few a week. No data is lost (the rename never happened), but
// the inode growth is unbounded.
//
// Real filesystem in a temp directory, only the state path redirected — the
// same seam every other store test uses. A sweep that decides whether to
// unlink a file cannot be tested against a mock that cannot be unlinked.

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR ?? '/tmp'}/agent-code-scratch-sweep-${process.pid}-${Date.now()}`,
}))
vi.mock('@main/storage/paths.js', () => ({ STATE_DIR: h.dir, STATE_FILE: `${h.dir}/workspace.json` }))

const { WorkspaceFileStore } = await import('@main/storage/workspaceFileStore.js')

// A pid that cannot be running: above every platform's pid_max, and the
// number the issue's own reproduction used.
const DEAD_PID = 999_999

const scratch = (pid: number, at: number, nonce: string, file = 'workspace.json') =>
  `${h.dir}/${file}.${pid}.${at}.${nonce}.tmp`

beforeEach(async () => {
  await mkdir(h.dir, { recursive: true })
})
afterEach(async () => {
  await rm(h.dir, { recursive: true, force: true })
})

describe('scratch files left by an interrupted save (#826)', () => {
  it('sweeps the ones whose writer is gone and keeps everything else', async () => {
    // Two dead-pid leftovers, one empty (died before the write) and one whole
    // (died between write and rename) — both are garbage, because the rename
    // is what would have made either of them count.
    await writeFile(scratch(DEAD_PID, 1_747_000_000_000, 'aaa'), '', 'utf8')
    await writeFile(scratch(DEAD_PID, 1_757_000_000_000, 'bbb'), '{"version":3}', 'utf8')
    // This process IS alive and may be mid-save. Never infer that a sibling
    // is abandoned: the whole reason `commit` refuses to scan by name is that
    // another admitted save may own it.
    const live = scratch(process.pid, Date.now(), 'ccc')
    await writeFile(live, '', 'utf8')
    // Neither of these is a scratch file, and a sweep that widened to
    // `workspace.json.*` would take the one-way pre-upgrade backup with it.
    await writeFile(`${h.dir}/workspace.json`, '{"version":3,"windows":[]}', 'utf8')
    await writeFile(`${h.dir}/workspace.json.pre-v3-1747000000000.bak`, '{"version":2}', 'utf8')

    await WorkspaceFileStore.open()

    expect((await readdir(h.dir)).sort()).toEqual([
      'workspace.json',
      'workspace.json.pre-v3-1747000000000.bak',
      live.slice(h.dir.length + 1),
    ].sort())
  })

  it('sweeps the OTHER three atomic-save writers that share this directory', async () => {
    // #1085 review, finding 5. `setup.json`, `worktree-activity-index.json`
    // and `ai-workspaces.json` are written with the identical name shape into
    // the identical directory, and all three have the same defect — two clean
    // up only in a `catch`, and AiWorkspaceRegistry not at all. The sweep
    // already pays for this `readdir`; walking past them was arbitrary.
    const siblings = ['setup.json', 'worktree-activity-index.json', 'ai-workspaces.json']
    for (const file of siblings) {
      await writeFile(scratch(DEAD_PID, 1_747_000_000_000, 'aaa', file), '', 'utf8')
      await writeFile(`${h.dir}/${file}`, '{}', 'utf8')
    }

    await WorkspaceFileStore.open()

    expect((await readdir(h.dir)).sort()).toEqual(siblings.slice().sort())
  })

  it.each([
    // The one error code that proves absence. Everything else means "we could
    // not ask", and deleting a file we cannot prove is abandoned is the only
    // harmful direction this sweep has.
    { code: 'EPERM', what: 'another user owns the process' },
    // libuv reports an access-denied `OpenProcess` as EACCES on Windows, so an
    // EPERM-only reading would sweep a live foreign writer's file there.
    { code: 'EACCES', what: 'the platform denies access' },
    { code: undefined, what: 'the error is not an errno at all' },
  ])('keeps a scratch file when $what', async ({ code }) => {
    const foreign = scratch(4242, 1_747_000_000_000, 'ddd')
    await writeFile(foreign, '', 'utf8')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw code === undefined ? new TypeError('pid out of range') : Object.assign(new Error(`kill ${code}`), { code })
    })
    try {
      await WorkspaceFileStore.open()
    } finally {
      kill.mockRestore()
    }
    expect(await readdir(h.dir)).toContain(foreign.slice(h.dir.length + 1))
  })

  it('keeps a file whose name is not the scratch shape at all', async () => {
    // Only `<file>.<pid>.<ms>.<nonce>.tmp` is ours. Anything else in the
    // config directory belongs to someone, and a sweep is not the place to
    // find out who.
    const strangers = [
      'workspace.json.tmp',
      'workspace.json.notapid.1747000000000.aaa.tmp',
      'workspace.json.999999.aaa.tmp',
      'workspace.json.999999.1747000000000.aaa.tmp.bak',
      // An empty nonce and a non-numeric millisecond field: the pattern is
      // fully specified, and each part of it is a real constraint.
      'workspace.json.999999.1747000000000..tmp',
      'workspace.json.999999.not-a-time.aaa.tmp',
      'workspace.json.999999.1747000000000.AAA.tmp',
      'extensions.json',
      // Exactly as long as `workspace.json`, so a sweep that skipped the
      // prefix check and sliced by LENGTH alone would read this as one of
      // ours and delete another feature's file.
      'otherfile.json.999999.1747000000000.aaa.tmp',
    ]
    for (const name of strangers) await writeFile(`${h.dir}/${name}`, '', 'utf8')

    await WorkspaceFileStore.open()

    expect((await readdir(h.dir)).sort()).toEqual(strangers.slice().sort())
  })

  it('opens normally when the directory cannot be scanned', async () => {
    // A fresh install has no directory at all. The sweep is hygiene; it must
    // never be the reason the app cannot read its workspace.
    await rm(h.dir, { recursive: true, force: true })
    await expect(WorkspaceFileStore.open()).resolves.toBeDefined()
  })
})
