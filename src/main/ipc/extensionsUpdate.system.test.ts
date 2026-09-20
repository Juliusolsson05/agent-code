import { execFile } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// SYSTEM tier: the registered `extensions:*` handlers, the REAL install
// pipeline (network stub → real tar → real containment checks → real ledger)
// and the REAL consent gate. Nothing about the decision under test is mocked:
// the dialog is recorded rather than faked away, so "did the user get asked?"
// is answered by counting actual prompts the pipeline raised.
//
// WHAT THIS PINS (#1049 round 9). The consent gate has two reasons to prompt:
// a manifest that requests capabilities, and a FIRST install — a repo string
// the user just typed, which is the only moment its name can be shown (with
// invisible characters escaped) before that repo's code runs. An Update re-runs
// a source already recorded in OUR ledger, so for a tier-0 manifest it must
// stay silent; otherwise every rebuild-and-update cycle asks again and the
// prompt becomes the thing users click through without reading.
//
// Routing Update back through `extensions:install` broke that split, because
// that handler treats its argument as unseen by construction. These tests fail
// against that shape: the tier-0 update prompts.
// ---------------------------------------------------------------------------

const run = promisify(execFile)

const root = await mkdtemp(join(tmpdir(), 'agent-code-ext-update-'))
const stateRoot = join(root, 'state')

vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: stateRoot,
  EXTENSIONS_DIR: join(stateRoot, 'extensions'),
  EXTENSIONS_LOCKFILE: join(stateRoot, 'extensions.json'),
  EXTENSION_STATE_DIR: join(stateRoot, 'extension-state'),
}))

// Every registered handler, keyed by channel — the fake ipcMain is a registry,
// not a behaviour stub, so the tests invoke the same function Electron would.
const handlers = new Map<string, (evt: unknown, ...args: unknown[]) => Promise<unknown>>()
// Every dialog the pipeline actually raised. `message` carries the source being
// approved, which is what distinguishes the two prompts.
const prompts: string[] = []
let dialogResponse = 1 // the affirmative button in both consent dialogs

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (evt: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    },
  },
  // No window: consentPromptFor falls back to the window-less dialog call,
  // which is the same decision path minus the parent.
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {
    showMessageBox: async (options: { message?: string }) => {
      prompts.push(String(options?.message ?? ''))
      return { response: dialogResponse }
    },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  protocol: { handle: () => {} },
  net: { fetch: async (url: string) => new Response(await readFile(new URL(url))) },
}))

const { registerExtensionsIpc } = await import('./extensions.js')
const { listInstalledExtensions, writeLedger, readLedger } = await import('@main/extensions/ledger.js')

registerExtensionsIpc()

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return handler({ sender: {} }, ...args)
}

type InstallResult = { ok: true; entry: { manifest: { id: string; version: string } } } | { ok: false; error: string }

/**
 * Build a real `.tar.gz` shaped like GitHub's: one wrapper directory that
 * `--strip-components=1` removes. Written with the system tar so the archive
 * the installer extracts is a real archive, not a fixture of one.
 *
 * WHY the manifest is written here rather than copied from
 * `testing/fixtures/extensions/`: the only published manifest captured there
 * (Timer 0.3.1) requests `sessions.observe`, and the case under test is the
 * TIER-0 one — an empty `permissions` array. That is manifest schema, not
 * recorded provider behaviour, so composing it is honest; the permissioned
 * half below uses the real fixture.
 */
async function buildTarball(name: string, manifest: Record<string, unknown>): Promise<Buffer> {
  const stage = join(root, 'sources', name)
  const wrapper = join(stage, `${name}-abcdef0`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(join(wrapper, 'dist'), { recursive: true })
  await writeFile(join(wrapper, 'agent-code.extension.json'), JSON.stringify(manifest))
  await writeFile(join(wrapper, 'dist/index.js'), 'export function activate() {}')
  const archive = join(stage, 'bundle.tar.gz')
  await run('tar', ['-czf', archive, '-C', stage, `${name}-abcdef0`])
  return readFile(archive)
}

/** Serve the release probe and the tarball; everything else 404s. */
function stubNetwork(tarball: Buffer, tag = 'v1.0.0'): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const target = String(url)
    if (target.includes('/releases/latest')) {
      return new Response(
        JSON.stringify({ tag_name: tag, tarball_url: 'https://fixture.invalid/bundle.tar.gz' }),
        { status: 200 },
      )
    }
    if (target.includes('fixture.invalid')) {
      return new Response(new Uint8Array(tarball), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
}

const TIER0 = {
  id: 'quiet', name: 'Quiet', description: 'Tier-0 fixture', version: '1.0.0',
  apiVersion: 1, entry: 'dist/index.js', permissions: [],
  contributes: { views: [{ id: 'quiet.main', title: 'Main', mount: 'panel' }] },
}

beforeEach(() => {
  prompts.length = 0
  dialogResponse = 1
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(stateRoot, { recursive: true, force: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('extension update routing (#1049)', () => {
  it('prompts on a typed tier-0 install and stays silent on the update that follows', async () => {
    stubNetwork(await buildTarball('quiet', TIER0))

    // 1. The user types `owner/repo`. Tier 0 or not, this asks: it is the only
    //    place the repo name is rendered before its code runs.
    const installed = (await invoke('extensions:install', 'owner/quiet', false)) as InstallResult
    expect(installed.ok).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('owner/quiet')

    // 2. Update. Same extension, same recorded repo, nothing new to disclose.
    prompts.length = 0
    stubNetwork(await buildTarball('quiet', { ...TIER0, version: '1.1.0' }), 'v1.1.0')
    const updated = (await invoke('extensions:update-github', 'quiet', false)) as InstallResult
    expect(updated.ok).toBe(true)
    if (updated.ok) expect(updated.entry.manifest.version).toBe('1.1.0')
    expect(prompts).toEqual([])

    // The ledger holds one row, at the new generation, still pointing at the
    // repo the user approved — the update re-ran the recorded source.
    const rows = await listInstalledExtensions()
    expect(rows).toHaveLength(1)
    expect(rows[0].repo).toBe('owner/quiet')
    expect(rows[0].manifest.version).toBe('1.1.0')
  })

  it('still prompts on update when the manifest requests capabilities', async () => {
    // The real published Timer manifest — it asks for `sessions.observe`, so
    // this half is pinned against something that actually shipped.
    const timer = JSON.parse(
      await readFile(
        join(import.meta.dirname, '../../../testing/fixtures/extensions/timer-0.3.1.agent-code.extension.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    expect((timer.permissions as string[]).length).toBeGreaterThan(0)

    stubNetwork(await buildTarball('timer', timer))
    expect(((await invoke('extensions:install', 'owner/timer', false)) as InstallResult).ok).toBe(true)

    prompts.length = 0
    stubNetwork(await buildTarball('timer', timer))
    expect(((await invoke('extensions:update-github', timer.id as string, false)) as InstallResult).ok).toBe(true)
    // A capability grant is re-asked on every install of any kind: the grant is
    // bound to the bytes being published, and this call is publishing new ones.
    expect(prompts).toHaveLength(1)
  })

  it('declining the update leaves the installed generation untouched', async () => {
    stubNetwork(await buildTarball('quiet', TIER0))
    await invoke('extensions:install', 'owner/quiet', false)
    const before = await readLedger()

    // A tier-0 update never prompts, so make the manifest request a capability
    // to reach the dialog, then refuse it.
    prompts.length = 0
    dialogResponse = 0
    stubNetwork(await buildTarball('quiet', { ...TIER0, version: '2.0.0', permissions: ['sessions.observe'] }), 'v2.0.0')
    const declined = (await invoke('extensions:update-github', 'quiet', false)) as InstallResult
    expect(declined.ok).toBe(false)
    expect(prompts).toHaveLength(1)
    expect(await readLedger()).toEqual(before)
  })

  it('refuses an id that is not installed, or was loaded from a folder', async () => {
    expect(await invoke('extensions:update-github', 'nothing-here', false)).toEqual({
      ok: false,
      error: 'Extension is no longer installed.',
    })

    // A local row's `repo` is an absolute folder path; handing it to the GitHub
    // installer would fail normalizeRepo. The handlers are a matched pair and
    // each refuses the other's origin by name, so the UI can say which button.
    stubNetwork(await buildTarball('quiet', TIER0))
    await invoke('extensions:install', 'owner/quiet', false)
    const rows = await readLedger()
    await writeLedger(rows.map(row => ({ ...row, origin: 'local' as const, repo: '/tmp/quiet' })))

    expect(await invoke('extensions:update-github', 'quiet', false)).toEqual({
      ok: false,
      error: 'This extension was loaded from a folder; use Reload.',
    })
  })
})
