import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
import { createEmptyOpencodeSession } from './opencodeCliSessions.js'
import { OpencodeTerminalSession } from './opencodeTerminalSession.js'

// A real child process is necessary: a promise mock cannot establish that
// cancellation kills the import process or releases its private export file.
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'oc-import-cancel-'))
  const binary = join(dir, 'fake-cli')
  const statusFile = join(dir, 'status.json')
  try {
    await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.IMPORT_STATUS_FILE + '.tmp', JSON.stringify({ pid: process.pid, file: process.argv[3] }));\nfs.renameSync(process.env.IMPORT_STATUS_FILE + '.tmp', process.env.IMPORT_STATUS_FILE);\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 })
    return { dir, binary, statusFile }
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

it.each(['stop', 'timeout'] as const)('bounds a hung import on %s and removes its payload', async mode => {
  const { dir, binary, statusFile } = await fixture()
  const spawnPty = vi.fn()
  const prepareLaunch = vi.fn()
  const session = new OpencodeTerminalSession({ cwd: dir, binary, env: { IMPORT_STATUS_FILE: statusFile } }, { spawnPty, prepareLaunch })
  let status: { pid: number; file: string } | undefined
  let starting: Promise<unknown> | undefined
  try {
    starting = mode === 'stop' ? session.start() : createEmptyOpencodeSession({ cwd: dir, binary, env: { IMPORT_STATUS_FILE: statusFile }, timeoutMs: 1000 })
    // Attach the rejection observer before waiting for startup so a timeout is
    // never reported as an unhandled rejection while the fixture is inspected.
    const outcome = starting.then(() => 'resolved', () => 'rejected')
    await waitUntil(() => existsSync(statusFile), 2000, 'import child status')
    status = JSON.parse(readFileSync(statusFile, 'utf8'))
    expect(existsSync(status!.file)).toBe(true)
    const stoppedAt = performance.now()
    if (mode === 'stop') await session.stop()
    await waitUntil(() => !alive(status!.pid), 2000, 'import child exit')
    expect(performance.now() - stoppedAt).toBeLessThan(2000)
    expect(await outcome).toBe(mode === 'stop' ? 'resolved' : 'rejected')
    expect(existsSync(dirname(status!.file))).toBe(false)
    expect(spawnPty).not.toHaveBeenCalled()
    expect(prepareLaunch).not.toHaveBeenCalled()
  } finally {
    if (status && alive(status.pid)) process.kill(status.pid, 'SIGKILL')
    await session.stop()
    await starting?.catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}
