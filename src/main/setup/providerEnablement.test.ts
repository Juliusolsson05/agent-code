import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// #1403 review a and b: what the Providers settings row hears must match what
// is on disk. The row shows "Couldn't save this change. Nothing was changed."
// on ANY rejection, so a rejection must mean the change was not saved.
//
// Real setup-state persistence in a scratch STATE_DIR. Only the edges are
// replaced: the login-shell provider probe (`checkPrerequisites`), the z.ai
// credential probe and the usage cache, none of which this contract is about.

const paths = vi.hoisted(() => ({ STATE_DIR: '' }))
vi.mock('@main/storage/paths.js', () => paths)
const probe = vi.hoisted(() => ({ checkPrerequisites: vi.fn() }))
vi.mock('@main/setup/prerequisites.js', () => probe)
const zai = vi.hoisted(() => ({ probeZaiCredential: vi.fn(async () => false) }))
vi.mock('@main/usage/zaiUsage.js', () => zai)
vi.mock('@main/usage/usageService.js', () => ({ invalidateUsageSnapshotCache: () => {} }))
// The real rename, with an optional hook per call (in order): a test can hold
// one write open and then fail it.
const renames = vi.hoisted(() => ({ hooks: [] as Array<(() => Promise<void>) | null> }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const hook = renames.hooks.shift()
      if (hook) await hook()
      return await actual.rename(from, to)
    },
  }
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'provider-enablement-'))
  paths.STATE_DIR = dir
  probe.checkPrerequisites.mockReset()
  probe.checkPrerequisites.mockResolvedValue({ usableProviders: ['claude', 'codex'] })
  zai.probeZaiCredential.mockReset()
  zai.probeZaiCredential.mockResolvedValue(false)
  renames.hooks = []
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const overridesOnDisk = async (): Promise<unknown> =>
  (JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')) as { providerEnablementOverrides: unknown })
    .providerEnablementOverrides

// A reset clears detection first, then writes. When the re-probe failed after
// the write had landed, the reset rejected: the row said "Nothing was
// changed" about an override already removed on disk.
it('resolves a reset whose write landed even when re-detection then fails', async () => {
  const enablement = await import('./providerEnablement.js')
  await enablement.setProviderEnabled('codex', false)
  expect(await overridesOnDisk()).toEqual({ codex: false })

  probe.checkPrerequisites.mockRejectedValue(new Error('login shell timed out'))
  const snapshot = await enablement.resetProviderEnablement('codex')
  expect(await overridesOnDisk()).toEqual({})
  // Shown against the last detection that succeeded: codex was installed.
  expect(snapshot.entries.find(entry => entry.kind === 'codex')).toMatchObject({
    enabled: true,
    because: 'detected',
  })

  // A failed probe must not stay "in flight" for the process lifetime: the
  // next resolve probes again and sees the real answer.
  probe.checkPrerequisites.mockResolvedValue({ usableProviders: ['claude'] })
  await enablement.resetProviderEnablement('codex')
  const after = await enablement.getProviderEnablementSnapshot()
  expect(after.entries.find(entry => entry.kind === 'codex')).toMatchObject({ enabled: false, installed: false })
})

// The rejection path is kept for what it means: nothing was saved.
it('rejects a toggle whose write fails, and changes nothing', async () => {
  const enablement = await import('./providerEnablement.js')
  await enablement.setProviderEnabled('codex', true)
  await rm(join(dir, 'setup.json'))
  await mkdir(join(dir, 'setup.json'))
  await expect(enablement.setProviderEnabled('codex', false)).rejects.toThrow()
  const snapshot = await enablement.getProviderEnablementSnapshot()
  expect(snapshot.entries.find(entry => entry.kind === 'codex')).toMatchObject({ enabled: true, because: 'user' })
})

// #1403 verification a (survivor): the fallback is the last detection that
// SUCCEEDED, not "everything installed". Only Claude was detected here, so a
// reset Codex whose re-probe fails is shown as not installed, and so off.
it('shows a reset against the last good detection, not against everything', async () => {
  probe.checkPrerequisites.mockResolvedValue({ usableProviders: ['claude'] })
  const enablement = await import('./providerEnablement.js')
  await enablement.setProviderEnabled('codex', true)
  probe.checkPrerequisites.mockRejectedValue(new Error('login shell timed out'))
  const snapshot = await enablement.resetProviderEnablement('codex')
  expect(snapshot.entries.find(entry => entry.kind === 'codex')).toMatchObject({ enabled: false, installed: false })
})

// #1403 verification a: two rows write at once. The first row's refresh
// pauses in the credential probe; the second row's refresh finishes first.
// The first must not then overwrite, and broadcast, a snapshot read before
// the second write: the disk says Claude is off, so every reader must too.
it('never lets an older refresh overwrite a newer one', async () => {
  const enablement = await import('./providerEnablement.js')
  await enablement.getProviderEnablementSnapshot()
  let releaseFirst!: () => void
  zai.probeZaiCredential.mockImplementationOnce(() => new Promise<boolean>(resolve => { releaseFirst = () => resolve(false) }))
  const broadcasts: boolean[] = []
  enablement.onProviderEnablementChanged(snapshot => {
    broadcasts.push(snapshot.entries.find(entry => entry.kind === 'claude')!.enabled)
  })
  const first = enablement.setProviderEnabled('codex', false)
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
  await enablement.setProviderEnabled('claude', false)
  releaseFirst()
  await first
  expect(await overridesOnDisk()).toEqual({ codex: false, claude: false })
  expect(enablement.getCachedProviderEnablement()!.entries.find(entry => entry.kind === 'claude')!.enabled).toBe(false)
  // The last broadcast is what subscribers keep.
  expect(broadcasts.at(-1)).toBe(false)
})

// #1403 recheck b: two toggles in flight. The first saves and refreshes while
// the second's write is still open; that write then fails. The refresh read
// the optimistic state, which already held the second toggle, so it broadcast
// Claude as off while the second row said "Nothing was changed" and the disk
// never had it. Published snapshots come from what is on disk.
it('never publishes a toggle whose own write then fails', async () => {
  const enablement = await import('./providerEnablement.js')
  await enablement.getProviderEnablementSnapshot()
  let failSecond!: () => void
  const secondHeld = new Promise<void>((_resolve, reject) => {
    failSecond = () => reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
  })
  // Handled here too: it may reject before the held rename awaits it.
  secondHeld.catch(() => {})
  renames.hooks = [null, () => secondHeld]
  const first = enablement.setProviderEnabled('codex', false)
  const second = enablement.setProviderEnabled('claude', false)
  const snapshot = await first
  failSecond()
  await expect(second).rejects.toThrow('ENOSPC')
  expect(await overridesOnDisk()).toEqual({ codex: false })
  expect(snapshot.entries.find(entry => entry.kind === 'claude')!.enabled).toBe(true)
  expect(enablement.getCachedProviderEnablement()!.entries.find(entry => entry.kind === 'claude')!.enabled).toBe(true)
})

// #1403 recheck a: the same leak through an overlapping READ. A `get` (or a
// usage refresh) while a toggle's write is pending must not publish that
// toggle; the write then fails and the disk never had it.
it('never publishes a pending toggle through an overlapping read', async () => {
  const enablement = await import('./providerEnablement.js')
  await enablement.getProviderEnablementSnapshot()
  let failWrite!: () => void
  const held = new Promise<void>((_resolve, reject) => {
    failWrite = () => reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
  })
  held.catch(() => {})
  renames.hooks = [() => held]
  const toggle = enablement.setProviderEnabled('claude', false)
  const read = enablement.getProviderEnablementSnapshot()
  const snapshot = await read
  failWrite()
  await expect(toggle).rejects.toThrow('ENOSPC')
  expect(snapshot.entries.find(entry => entry.kind === 'claude')!.enabled).toBe(true)
  expect(enablement.getCachedProviderEnablement()!.entries.find(entry => entry.kind === 'claude')!.enabled).toBe(true)
})
