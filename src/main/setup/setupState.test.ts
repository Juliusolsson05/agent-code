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

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setup-state-'))
  paths.STATE_DIR = dir
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
