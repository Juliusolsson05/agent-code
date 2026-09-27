import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// #1250 rows 6 and 13: a setup-state write that fails must leave main's
// in-memory state as it was. `saveSetupState` used to assign the new state to
// its cache before writing and never restore it, so after a failed write the
// app behaved as if the change were saved (provider enablement re-resolved
// from it, the next save persisted it) and then reverted on the next launch.
//
// Real filesystem in a scratch STATE_DIR. The failure is real too: a directory
// sits where `setup.json` goes, so the temp file's rename onto it fails.

const paths = vi.hoisted(() => ({ STATE_DIR: '' }))
vi.mock('@main/storage/paths.js', () => paths)

// The real rename, with an optional one-shot failure. The directory trick
// above fails EVERY write until it is removed, and removing it between two
// queued writes races the queue; the ordered cases below need "this write
// fails, the next one lands" exactly.
const renameFaults = vi.hoisted(() => ({ failNext: 0 }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameFaults.failNext > 0) {
        renameFaults.failNext -= 1
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return await actual.rename(from, to)
    },
  }
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setup-state-'))
  paths.STATE_DIR = dir
  renameFaults.failNext = 0
  vi.resetModules()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('restores the previous state when the write fails, and a later good save still lands', async () => {
  const setup = await import('./setupState.js')
  await setup.setCliUpdateBehavior('notify')
  expect((await setup.loadSetupState()).cliUpdateBehavior).toBe('notify')

  // Break the next write: a directory where the file must be renamed to.
  await rm(join(dir, 'setup.json'))
  await mkdir(join(dir, 'setup.json'))
  await expect(setup.setCliUpdateBehavior('off')).rejects.toThrow()
  // Not "off": nothing was written, so nothing may act as if it had been.
  expect((await setup.loadSetupState()).cliUpdateBehavior).toBe('notify')

  await rm(join(dir, 'setup.json'), { recursive: true })
  await setup.setCliUpdateBehavior('automatic')
  expect(JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')).cliUpdateBehavior).toBe('automatic')
})

it('restores provider-enablement overrides after a failed write', async () => {
  const setup = await import('./setupState.js')
  await setup.setProviderEnablementOverrides({ codex: true })
  await rm(join(dir, 'setup.json'))
  await mkdir(join(dir, 'setup.json'))
  await expect(setup.setProviderEnablementOverrides({ codex: false })).rejects.toThrow()
  expect((await setup.loadSetupState()).providerEnablementOverrides).toEqual({ codex: true })
})

const onDisk = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')) as Record<string, unknown>

// #1403 review a and c: two overlapping saves that both fail. The second used
// to "restore" the first one's unwritten state, so main kept acting on a
// value no write ever landed.
it('keeps the durable state when two queued saves both fail', async () => {
  const setup = await import('./setupState.js')
  await setup.setCliUpdateBehavior('notify')
  renameFaults.failNext = 2
  const results = await Promise.allSettled([
    setup.setCliUpdateBehavior('off'),
    setup.setOpencodeUsageSource('zai'),
  ])
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
  const state = await setup.loadSetupState()
  expect(state.cliUpdateBehavior).toBe('notify')
  expect(state.opencodeUsageSource).toBe('none')
})

// #1403 review a and b: a failed save followed by a good one. The good one's
// snapshot was built from the failed one's unwritten state and carried it to
// disk, while the renderer had just said "Nothing was changed".
it('never lets a later save carry a failed one to disk', async () => {
  const setup = await import('./setupState.js')
  await setup.setCliUpdateBehavior('notify')
  renameFaults.failNext = 1
  const first = setup.setCliUpdateBehavior('off')
  // The reviewers' sequence: the second save starts AFTER the first one's
  // change is visible (a few microtasks; its write is still on real I/O).
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  expect((await setup.loadSetupState()).cliUpdateBehavior).toBe('off')
  const second = setup.setOpencodeUsageSource('zai')
  const results = await Promise.allSettled([first, second])
  expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
  expect(await onDisk()).toMatchObject({ cliUpdateBehavior: 'notify', opencodeUsageSource: 'zai' })
  expect(await setup.loadSetupState()).toMatchObject({ cliUpdateBehavior: 'notify', opencodeUsageSource: 'zai' })
})

// The other order: a good save still pending when a later one fails keeps
// its value, in memory and on disk. (The first fix's `cache === snapshot`
// guard existed for this case and no test exercised it; review c.)
it('keeps an earlier good save when a later queued save fails', async () => {
  const setup = await import('./setupState.js')
  await setup.setCliUpdateBehavior('notify')
  const first = setup.setCliUpdateBehavior('off')
  const second = setup.setOpencodeUsageSource('zai')
  // Readers see both at once, before either write settles.
  expect(await setup.loadSetupState()).toMatchObject({ cliUpdateBehavior: 'off', opencodeUsageSource: 'zai' })
  await first
  renameFaults.failNext = 1
  await expect(second).rejects.toThrow('ENOSPC')
  expect(await onDisk()).toMatchObject({ cliUpdateBehavior: 'off', opencodeUsageSource: 'none' })
  expect(await setup.loadSetupState()).toMatchObject({ cliUpdateBehavior: 'off', opencodeUsageSource: 'none' })
})

// Per-provider overrides apply to the durable map: a failed toggle cannot
// ride along with a later toggle of another provider.
it('does not persist a failed provider toggle with a later one', async () => {
  const setup = await import('./setupState.js')
  renameFaults.failNext = 1
  const results = await Promise.allSettled([
    setup.setProviderEnablementOverride('codex', false),
    setup.setProviderEnablementOverride('claude', false),
  ])
  expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
  expect((await onDisk()).providerEnablementOverrides).toEqual({ claude: false })
  expect((await setup.loadSetupState()).providerEnablementOverrides).toEqual({ claude: false })
})
