import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Filesystem operations remain real. The only injected failure is the atomic
// publication rename, where a full disk or process death used to separate code
// from its grant. No test can write to the maintainer's application state.
const root = await mkdtemp(join(tmpdir(), 'agent-code-install-lifecycle-'))
const stateRoot = join(root, 'state')
const ledgerPath = join(stateRoot, 'extensions.json')
let rejectPublication = false
let capturePublication = false
let schemeHandler: (request: Request) => Promise<Response>

vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: stateRoot,
  EXTENSIONS_DIR: join(stateRoot, 'extensions'),
  EXTENSIONS_LOCKFILE: ledgerPath,
  EXTENSION_STATE_DIR: join(stateRoot, 'extension-state'),
}))
vi.mock('fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('fs/promises')>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const publishes = String(args[1]) === ledgerPath
      if (publishes && rejectPublication) {
        rejectPublication = false
        throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })
      }
      // Capture the real disk state on both sides of the commit boundary.
      // Restoring these snapshots models process death (no finally/rollback),
      // without adding a production crash hook or duplicating journal logic.
      if (publishes && capturePublication) await fs.cp(stateRoot, join(root, 'before-publish'), { recursive: true })
      await fs.rename(...args)
      if (publishes && capturePublication) await fs.cp(stateRoot, join(root, 'after-publish'), { recursive: true })
    },
  }
})
vi.mock('electron', () => ({
  protocol: { handle: (_scheme: string, handler: typeof schemeHandler) => { schemeHandler = handler } },
  net: { fetch: async (url: string) => new Response(await readFile(new URL(url))) },
}))

const { installExtensionFromPath, sweepAbandonedInstallDirectories } = await import('./install.js')
const { extensionBundleDirectory, readLedger, listInstalledExtensions, removeExtension, writeLedger } = await import('./ledger.js')
const { installedExtensionCapabilities, recordGrant } = await import('./grants.js')
const { computeBundleHash } = await import('./bundleHash.js')
const { handleExtensionScheme } = await import('./scheme.js')
handleExtensionScheme()

async function source(id = 'timer', permission = 'workspace.observe'): Promise<string> {
  const folder = join(root, 'sources', id)
  await mkdir(join(folder, 'dist'), { recursive: true })
  await writeFile(join(folder, 'agent-code.extension.json'), JSON.stringify({
    id, name: id, description: 'Lifecycle fixture', version: '1', apiVersion: 1,
    entry: 'dist/index.js', permissions: permission ? [permission] : [],
    contributes: { views: [{ id: `${id}.main`, title: 'Main', mount: 'panel' }] },
  }))
  await writeFile(join(folder, 'dist/index.js'), 'export function activate() {}')
  await writeFile(join(folder, 'dist/asset.json'), '{"value":1}')
  return folder
}

afterEach(async () => {
  rejectPublication = capturePublication = false
  for (const entry of await readdir(root)) await rm(join(root, entry), { recursive: true, force: true })
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('atomic extension publication', () => {
  it('updates asset-only changes and binds consent to the whole installed bundle', async () => {
    const folder = await source()
    const first = await installExtensionFromPath(folder, async () => true)
    await writeFile(join(folder, 'dist/asset.json'), '{"value":2}')
    const second = await installExtensionFromPath(folder, async () => true)
    expect(second.sha256).toBe(first.sha256) // the entry module did not change
    expect(second.installation!.id).not.toBe(first.installation!.id)
    expect(second.installation!.bundleSha256).not.toBe(first.installation!.bundleSha256)
    expect(await installedExtensionCapabilities('timer', first.installation!.id)).toEqual([])
    expect(await installedExtensionCapabilities('timer')).toEqual(['workspace.observe'])
    await writeFile(join(extensionBundleDirectory(second), 'dist/asset.json'), '{"value":3}')
    expect(await installedExtensionCapabilities('timer')).toEqual([])
  })

  it('keeps the old bundle and grant when publication fails', async () => {
    const folder = await source()
    const first = await installExtensionFromPath(folder, async () => true)
    await source('timer', 'panes.observe')
    rejectPublication = true
    await expect(installExtensionFromPath(folder, async () => true)).rejects.toThrow('fixture disk full')
    expect(await readLedger()).toEqual([first])
    expect(await installedExtensionCapabilities('timer')).toEqual(['workspace.observe'])
    expect(await computeBundleHash(extensionBundleDirectory(first))).toBe(first.installation!.bundleSha256)
  })

  it.each(['before-publish', 'after-publish'])('recovers a process crash %s', async boundary => {
    const folder = await source()
    const first = await installExtensionFromPath(folder, async () => true)
    await source('timer', 'panes.observe')
    capturePublication = true
    const second = await installExtensionFromPath(folder, async () => true)
    capturePublication = false
    await rm(stateRoot, { recursive: true, force: true })
    await cp(join(root, boundary), stateRoot, { recursive: true })
    await sweepAbandonedInstallDirectories()
    const expected = boundary === 'before-publish' ? first : second
    expect(await readLedger()).toEqual([expected])
    expect(await listInstalledExtensions()).toEqual([{ ...expected, present: true }])
    expect(await installedExtensionCapabilities('timer')).toEqual(expected.manifest.permissions)
    expect(await readdir(join(stateRoot, 'extensions/.bundles/timer'))).toEqual([expected.installation!.id])
  })

  it('retains both concurrent installations and their independent permissions', async () => {
    const folders = await Promise.all([source('timer'), source('notes', 'panes.observe')])
    await Promise.all(folders.map(folder => installExtensionFromPath(folder, async () => true)))
    expect((await readLedger()).map(row => row.manifest.id).sort()).toEqual(['notes', 'timer'])
    expect(await installedExtensionCapabilities('timer')).toEqual(['workspace.observe'])
    expect(await installedExtensionCapabilities('notes')).toEqual(['panes.observe'])
  })

  it('never sweeps staging owned by an install waiting for consent', async () => {
    const folder = await source()
    let release!: (approved: boolean) => void
    let entered!: () => void
    const pending = new Promise<void>(resolve => { entered = resolve })
    const install = installExtensionFromPath(folder, () => {
      entered()
      return new Promise<boolean>(resolve => { release = resolve })
    })
    await pending
    await sweepAbandonedInstallDirectories()
    release(true)
    await expect(install).resolves.toMatchObject({ manifest: { id: 'timer' } })
  })

  it('drops permissions on a tier-zero update, even when a legacy grant exists', async () => {
    const folder = await source()
    const first = await installExtensionFromPath(folder, async () => true)
    await recordGrant('timer', first.installation!.bundleSha256, ['workspace.observe'])
    await source('timer', '')
    await installExtensionFromPath(folder)
    expect(await installedExtensionCapabilities('timer')).toEqual([])
  })

  it('uninstalls authority and bundles while preserving saved extension data', async () => {
    const installed = await installExtensionFromPath(await source(), async () => true)
    const saved = join(stateRoot, 'extension-state/timer.json')
    await mkdir(join(saved, '..'), { recursive: true })
    await writeFile(saved, '{"saved":true}')
    await removeExtension('timer')
    expect(await readLedger()).toEqual([])
    expect(await installedExtensionCapabilities('timer')).toEqual([])
    await expect(readFile(join(extensionBundleDirectory(installed), 'dist/index.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(saved, 'utf8')).toBe('{"saved":true}')
  })

  it('preserves legacy bytes and consent until the first generation update', async () => {
    const folder = await source()
    const installed = await installExtensionFromPath(folder, async () => true)
    const { installation: _, ...legacy } = installed
    await cp(extensionBundleDirectory(installed), extensionBundleDirectory(legacy), { recursive: true })
    await writeLedger([legacy])
    await recordGrant('timer', await computeBundleHash(extensionBundleDirectory(legacy)), ['workspace.observe'])
    expect(await installedExtensionCapabilities('timer')).toEqual(['workspace.observe'])
    await sweepAbandonedInstallDirectories()
    expect(await listInstalledExtensions()).toEqual([{ ...legacy, present: true }])
    const next = await installExtensionFromPath(folder, async () => true)
    expect(next.installation).toBeDefined()
    expect(await installedExtensionCapabilities('timer')).toEqual(['workspace.observe'])
  })

  it('preserves all bundle copies when the ledger is corrupt', async () => {
    const installed = await installExtensionFromPath(await source(), async () => true)
    await writeFile(ledgerPath, '{invalid')
    await expect(sweepAbandonedInstallDirectories()).rejects.toThrow('invalid JSON')
    expect(await computeBundleHash(extensionBundleDirectory(installed))).toBe(installed.installation!.bundleSha256)
    expect(await readFile(ledgerPath, 'utf8')).toBe('{invalid')
  })

  it('preserves ambiguous backups from the old in-place installer', async () => {
    const backup = join(stateRoot, 'extensions/timer.replacing-00000000-0000-0000-0000-000000000000')
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'recovery.txt'), 'last copy')
    await sweepAbandonedInstallDirectories()
    expect(await readFile(join(backup, 'recovery.txt'), 'utf8')).toBe('last copy')
  })
})

describe('scheme serves only the committed generation', () => {
  it('rejects superseded generation URLs instead of mixing old and new modules', async () => {
    const folder = await source()
    const first = await installExtensionFromPath(folder, async () => true)
    const assetUrl = (id: string) => `agent-code-ext://timer/__bundle/${id}/dist/asset.json`
    const firstResponse = await schemeHandler(new Request(assetUrl(first.installation!.id)))
    expect(firstResponse.status).toBe(200)
    expect(await firstResponse.json()).toEqual({ value: 1 })
    const second = await installExtensionFromPath(folder, async () => true)
    expect((await schemeHandler(new Request(assetUrl(first.installation!.id)))).status).toBe(404)
    expect((await schemeHandler(new Request(assetUrl(second.installation!.id)))).status).toBe(200)
    expect((await schemeHandler(new Request(`agent-code-ext://timer/__bundle/${first.installation!.id}/__agent-code-frame__.html?view=timer.main&rev=${first.installation!.id}`))).status).toBe(404)
    const frame = await schemeHandler(new Request(`agent-code-ext://timer/__bundle/${second.installation!.id}/__agent-code-frame__.html?view=timer.main&rev=${second.installation!.id}`))
    expect(frame.status).toBe(200)
    expect(await frame.text()).toContain('dist/index.js')
    await removeExtension('timer')
    expect((await schemeHandler(new Request(assetUrl(second.installation!.id)))).status).toBe(404)
  })
})

it('refuses a missing v2 view module before replacing an installed generation', async () => {
  const folder = await source('timer', '')
  const previous = await installExtensionFromPath(folder)
  const manifestPath = join(folder, 'agent-code.extension.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.apiVersion = 2
  manifest.contributes.views[0].entry = 'dist/view.js'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await expect(installExtensionFromPath(folder)).rejects.toThrow()
  expect((await readLedger())[0]?.installation?.id).toBe(previous.installation?.id)
  await writeFile(join(folder, 'dist/view.js'), 'export function mount(element) { element.textContent = "ready" }')
  const replacement = await installExtensionFromPath(folder)
  expect(replacement.manifest.apiVersion).toBe(2)
  expect(replacement.installation?.id).not.toBe(previous.installation?.id)
  expect(await readFile(join(extensionBundleDirectory(replacement), 'dist/view.js'), 'utf8')).toContain('ready')
})
