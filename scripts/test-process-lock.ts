import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { acquireStateProcessLock } from '../src/main/storage/processLock'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-process-lock-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await withTempDir(async dir => {
  const first = await acquireStateProcessLock({
    stateDir: dir,
    pid: 111,
    argv0: 'first',
    isLockOwnerActive: owner => owner.pid === 111,
  })
  assert.equal(first.acquired, true)

  const blocked = await acquireStateProcessLock({
    stateDir: dir,
    pid: 222,
    argv0: 'second',
    isLockOwnerActive: owner => owner.pid === 111,
  })
  assert.equal(blocked.acquired, false)
  assert.equal(blocked.reason, 'active-owner')
  assert.equal(blocked.owner?.pid, 111)

  await first.release()

  const second = await acquireStateProcessLock({
    stateDir: dir,
    pid: 222,
    argv0: 'second',
    isLockOwnerActive: owner => owner.pid === 222,
  })
  assert.equal(second.acquired, true)

  const lockText = await readFile(second.path, 'utf8')
  assert.match(lockText, /"pid": 222/)

  await second.release()
})

await withTempDir(async dir => {
  const lockPath = join(dir, 'agent-code.process-lock.json')
  await writeFile(
    lockPath,
    JSON.stringify({
      token: 'reused-pid',
      pid: 555,
      startedAt: new Date(0).toISOString(),
      argv0: 'old-agent-code',
    }),
    'utf8',
  )

  const acquired = await acquireStateProcessLock({
    stateDir: dir,
    pid: 666,
    argv0: 'replacement',
    // Models PID reuse: something exists at pid 555, but the owner-level
    // identity check says it is not the Agent Code process that wrote the lock.
    isLockOwnerActive: () => false,
  })
  assert.equal(acquired.acquired, true)
  const lockText = await readFile(acquired.path, 'utf8')
  assert.match(lockText, /"pid": 666/)
  acquired.releaseSync()
})

await withTempDir(async dir => {
  const lockPath = join(dir, 'agent-code.process-lock.json')
  await writeFile(
    lockPath,
    JSON.stringify({
      token: 'stale',
      pid: 333,
      startedAt: new Date(0).toISOString(),
      argv0: 'stale',
    }),
    'utf8',
  )

  const acquired = await acquireStateProcessLock({
    stateDir: dir,
    pid: 444,
    argv0: 'replacement',
    isLockOwnerActive: () => false,
  })
  assert.equal(acquired.acquired, true)
  const lockText = await readFile(acquired.path, 'utf8')
  assert.match(lockText, /"pid": 444/)
  await acquired.release()
})

await withTempDir(async dir => {
  const lockPath = join(dir, 'agent-code.process-lock.json')
  const now = new Date('2026-05-18T10:00:00.000Z')
  await writeFile(
    lockPath,
    JSON.stringify({
      token: 'fresh-inconclusive',
      pid: 777,
      startedAt: new Date(now.getTime() - 30_000).toISOString(),
      argv0: 'agent-code',
    }),
    'utf8',
  )

  const blocked = await acquireStateProcessLock({
    stateDir: dir,
    pid: 888,
    argv0: 'replacement',
    now: () => now,
    isLockOwnerActive: () => 'inconclusive',
  })
  assert.equal(blocked.acquired, false)
  assert.equal(blocked.reason, 'active-owner')
})

await withTempDir(async dir => {
  const lockPath = join(dir, 'agent-code.process-lock.json')
  const now = new Date('2026-05-18T10:00:00.000Z')
  await writeFile(
    lockPath,
    JSON.stringify({
      token: 'old-inconclusive',
      pid: 777,
      startedAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      argv0: 'agent-code',
    }),
    'utf8',
  )

  const acquired = await acquireStateProcessLock({
    stateDir: dir,
    pid: 888,
    argv0: 'replacement',
    now: () => now,
    isLockOwnerActive: () => 'inconclusive',
  })
  assert.equal(acquired.acquired, true)
  const lockText = await readFile(acquired.path, 'utf8')
  assert.match(lockText, /"pid": 888/)
  acquired.releaseSync()
})

console.log('process lock tests passed')
