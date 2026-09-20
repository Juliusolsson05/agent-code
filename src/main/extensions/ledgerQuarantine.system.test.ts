import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #959. `readLedger` threw for the WHOLE file when any row failed the schema or
// the api-version gate. List, install, remove, the startup sweep, the scheme
// handler and every capability check read the ledger first — so one unusable
// row disabled every installed extension, and because `removeExtension` reads
// before it writes, Remove rejected too. The only recovery was hand-editing
// ~/.config/agent-code/extensions.json.
//
// SYSTEM tier: a real ledger file on a real temp disk, through the real
// exported functions. The only thing redirected is the state directory.
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'agent-code-ledger-quarantine-'))
const stateRoot = join(root, 'state')
const ledgerPath = join(stateRoot, 'extensions.json')

vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: stateRoot,
  EXTENSIONS_DIR: join(stateRoot, 'extensions'),
  EXTENSIONS_LOCKFILE: ledgerPath,
  EXTENSION_STATE_DIR: join(stateRoot, 'extension-state'),
}))

const {
  listInstalledExtensions,
  listQuarantinedExtensions,
  preservedBundleDirectories,
  readLedger,
  readLedgerContents,
  removeExtension,
  writeLedger,
} = await import('./ledger.js')

/** A row the current build CAN run. Shaped like one finalizeInstall writes. */
function validRow(id: string): Record<string, unknown> {
  return {
    manifest: { id, name: id, description: 'fixture', version: '1.0.0', apiVersion: 1, entry: 'dist/index.js' },
    installation: { id: '11111111-2222-4333-8444-555555555555', bundleSha256: 'a'.repeat(64) },
    origin: 'github',
    repo: `owner/${id}`,
    ref: 'v1.0.0',
    sha256: 'b'.repeat(64),
    installedAt: 1,
  }
}

/** The issue's own reproduction: a row targeting an api version this build
 *  does not implement, which is what a ROLLBACK produces. */
function futureApiRow(id: string): Record<string, unknown> {
  const row = validRow(id)
  ;(row.manifest as Record<string, unknown>).apiVersion = 3
  return row
}

async function seed(rows: unknown[]): Promise<void> {
  await mkdir(stateRoot, { recursive: true })
  await writeFile(ledgerPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
}

async function onDisk(): Promise<unknown[]> {
  return JSON.parse(await readFile(ledgerPath, 'utf8')) as unknown[]
}

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true })
})

describe('one unusable ledger row (#959)', () => {
  it('does not stop the other extensions from loading', async () => {
    await seed([validRow('timer'), futureApiRow('from-the-future')])

    const rows = await readLedger()
    expect(rows.map(row => row.manifest.id)).toEqual(['timer'])

    // The surface the user actually looks at.
    const listed = await listInstalledExtensions()
    expect(listed.map(row => row.manifest.id)).toEqual(['timer'])
  })

  it('reports the set-aside row, with the reason, so Settings can show it', async () => {
    await seed([validRow('timer'), futureApiRow('from-the-future')])
    const quarantined = await listQuarantinedExtensions()
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]!.id).toBe('from-the-future')
    expect(quarantined[0]!.reason).toContain('API v3')
  })

  it('lets Remove work on the OTHER extension, and keeps the set-aside row', async () => {
    // This is the half that made the bug unrecoverable in-app: removeExtension
    // reads the ledger before it writes, so it rejected too.
    await seed([validRow('timer'), futureApiRow('from-the-future')])
    await removeExtension('timer')

    expect((await readLedger()).map(row => row.manifest.id)).toEqual([])
    // The row we could not read is still in the file, byte for byte.
    const remaining = await onDisk()
    expect(remaining).toEqual([futureApiRow('from-the-future')])
  })

  it('carries the set-aside row through an unrelated write', async () => {
    // writeLedger's callers only ever see runnable rows, so forgetting to
    // carry a preserved one would silently delete the row we have the least
    // right to destroy.
    await seed([validRow('timer'), futureApiRow('from-the-future')])
    const { rows } = await readLedgerContents()
    await writeLedger(rows)

    const remaining = await onDisk()
    expect(remaining).toHaveLength(2)
    expect(remaining[1]).toEqual(futureApiRow('from-the-future'))
  })

  it('lets the user remove the set-aside row itself', async () => {
    await seed([validRow('timer'), futureApiRow('from-the-future')])
    await removeExtension('from-the-future')

    expect(await onDisk()).toEqual([validRow('timer')])
    expect(await listQuarantinedExtensions()).toEqual([])
    expect((await readLedger()).map(row => row.manifest.id)).toEqual(['timer'])
  })

  it('sets aside a schema-invalid row too, naming it when the id is safe', async () => {
    const broken = validRow('broken')
    delete broken.sha256
    await seed([validRow('timer'), broken])

    expect((await readLedger()).map(row => row.manifest.id)).toEqual(['timer'])
    const quarantined = await listQuarantinedExtensions()
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]!.id).toBe('broken')
  })

  it('reports — but cannot name — a row with no usable id', async () => {
    // `id` is only carried when it independently passes isValidExtensionId, so
    // a traversal-shaped id can never reach a path or a Remove call.
    await seed([validRow('timer'), { manifest: { id: '../escape' }, repo: 'x' }])
    const quarantined = await listQuarantinedExtensions()
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]!.id).toBeNull()
  })

  it('still refuses to touch a ledger it cannot read at all', async () => {
    // Quarantine preserves a ROW. When reading rows is what failed there is
    // nothing to set aside, and rewriting the file is how bundles get orphaned.
    await mkdir(stateRoot, { recursive: true })
    await writeFile(ledgerPath, '{ not json', 'utf8')
    await expect(readLedger()).rejects.toThrow(/invalid JSON/)
    await expect(writeLedger([])).rejects.toThrow(/invalid JSON/)
    expect(await readFile(ledgerPath, 'utf8')).toBe('{ not json')

    await writeFile(ledgerPath, '{"rows":[]}', 'utf8')
    await expect(readLedger()).rejects.toThrow(/must be an array/)
  })
})

describe('a set-aside row keeps its bundle (#959)', () => {
  it('protects both possible bundle layouts, and nothing when the id is unusable', () => {
    const generation = '11111111-2222-4333-8444-555555555555'
    const paths = preservedBundleDirectories({
      raw: { manifest: { id: 'timer' }, installation: { id: generation } },
      id: 'timer',
      reason: 'fixture',
    })
    // The sweep runs at STARTUP, so under-protecting means one
    // rollback-and-relaunch deletes the extension's code for good.
    expect(paths.some(path => path.endsWith(join('extensions', 'timer')))).toBe(true)
    expect(paths.some(path => path.endsWith(join('.bundles', 'timer', generation)))).toBe(true)

    // An id we could not validate yields NO path rather than a guess.
    expect(preservedBundleDirectories({ raw: { manifest: { id: '../escape' } }, id: null, reason: 'x' })).toEqual([])
    // A generation that is not a uuid is not joined either.
    expect(
      preservedBundleDirectories({ raw: { manifest: { id: 'timer' }, installation: { id: '../..' } }, id: 'timer', reason: 'x' }),
    ).toEqual([join(stateRoot, 'extensions', 'timer')])
  })
})
