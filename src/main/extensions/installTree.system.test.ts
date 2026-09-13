import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Only the state LOCATION is replaced; copy, realpath and validation remain
// real filesystem operations. Denying consent is not an isolation boundary:
// tier-zero fixtures never ask for consent, and staging happens before it.
// A regression must therefore be unable to install into the user's real state.
const stateRoot = await mkdtemp(join(tmpdir(), 'agent-code-install-state-'))
vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: stateRoot,
  EXTENSIONS_DIR: join(stateRoot, 'extensions'),
  EXTENSIONS_LOCKFILE: join(stateRoot, 'extensions.json'),
  EXTENSION_STATE_DIR: join(stateRoot, 'extension-state'),
}))
const { installExtensionFromPath, InstallError } = await import('@main/extensions/install.js')

// `.system.` because the guarantee under test IS a filesystem guarantee: what the
// installer refuses to move into place after a real copy of a real directory tree.
// A mocked fs would be testing the mock's idea of a symlink.
//
// These drive the LOCAL-folder installer rather than the tarball one, because it is
// the path that needs no network and no `tar` binary while running the identical
// validation tail (assertBundleTreeIsSafe → readManifestFrom → verifyEntryInsideBundle
// → finalizeInstall). The tarball path's extra step is extraction, whose output is
// then handed to exactly these checks.

const temporaryRoots: string[] = []

async function makeSourceFolder(
  files: Record<string, string>,
  manifest?: Record<string, unknown>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-install-tree-'))
  temporaryRoots.push(root)
  const source = join(root, 'source')
  await mkdir(source, { recursive: true })
  if (manifest !== undefined) {
    await writeFile(join(source, 'agent-code.extension.json'), JSON.stringify(manifest), 'utf8')
  }
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(source, relative)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, contents, 'utf8')
  }
  return source
}

/** A manifest that is valid in every respect the tree checks do not care about. */
function validManifest(): Record<string, unknown> {
  return {
    id: 'treetest',
    name: 'Tree Test',
    description: 'Fixture extension.',
    version: '0.0.1',
    apiVersion: 1,
    entry: 'dist/index.js',
  }
}

// Some valid-tree cases deliberately reach consent. Declining distinguishes a
// successfully validated bundle from a tree rejected before that stage.
const denyConsent = async () => false

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  await rm(stateRoot, { recursive: true, force: true })
})

afterAll(async () => { await rm(stateRoot, { recursive: true, force: true }) })

describe('install refuses a bundle that points outside itself', () => {
  it('rejects a symlink whose target escapes the bundle', async () => {
    // ── THE REGRESSION THIS EXISTS FOR ──
    // A repository can commit a symlink, and `tar`/`cp` recreate it. Whether the
    // extractor blocks traversal is implementation-dependent — bsdtar refuses `..`
    // members and symlink write-through, a `tar` found on PATH may not — so the
    // guarantee has to come from checking the RESULT, not from trusting the tool.
    const source = await makeSourceFolder({ 'dist/index.js': 'export function activate() {}' }, validManifest())
    await symlink('/etc', join(source, 'escape'))

    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(InstallError)
    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(/points outside/)
  })

  it('names the offending path so the failure is diagnosable', async () => {
    const source = await makeSourceFolder({ 'dist/index.js': 'export function activate() {}' }, validManifest())
    await mkdir(join(source, 'nested'), { recursive: true })
    await symlink('/etc', join(source, 'nested/escape'))

    // Without the path, an author with a large repository has no way to find it.
    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(/nested\/escape/)
  })

  it('allows a RELATIVE symlink that stays inside the bundle', async () => {
    // Legitimate: bundles do alias files internally. Rejecting these would be a
    // blanket ban on symlinks, which is a bigger rule than the threat requires.
    // This reaches the consent prompt and is then declined, which is how the test
    // asserts it got PAST the tree check without writing to the real state dir.
    const source = await makeSourceFolder(
      { 'dist/index.js': 'export function activate() {}' },
      { ...validManifest(), permissions: ['workspace.observe'] },
    )
    await symlink('dist/index.js', join(source, 'alias.js'))

    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(/declined/)
  })

  it('rejects an ABSOLUTE symlink into the author\'s own source tree', async () => {
    // Subtle and worth pinning, because it looks like a false positive and is not.
    // The local installer SNAPSHOTS the folder: `cp` preserves symlinks verbatim, so
    // an absolute link to `<source>/dist/index.js` still points at the AUTHOR'S
    // FOLDER once the bundle has been copied under EXTENSIONS_DIR. At that moment it
    // is a genuine escape — the installed extension reaches a path outside itself,
    // the scheme handler would refuse to serve it, and computeBundleHash would be
    // hashing a link whose target the bundle does not own.
    //
    // A relative link (the case above) survives the copy intact and is allowed. So
    // the rule an author needs is "link relatively", which the message below has to
    // be good enough to convey.
    const source = await makeSourceFolder(
      { 'dist/index.js': 'export function activate() {}' },
      { ...validManifest(), permissions: ['workspace.observe'] },
    )
    await symlink(join(source, 'dist/index.js'), join(source, 'absolute-alias.js'))

    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(/points outside/)
  })

  it('allows a dangling symlink, which can leak nothing', async () => {
    const source = await makeSourceFolder(
      { 'dist/index.js': 'export function activate() {}' },
      { ...validManifest(), permissions: ['workspace.observe'] },
    )
    await symlink(join(source, 'does-not-exist'), join(source, 'dangling.js'))

    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(/declined/)
  })
})

describe('install validates the manifest before anything is moved into place', () => {
  it('refuses an oversized local source before copying its large file', async () => {
    const source = await makeSourceFolder({ 'dist/index.js': 'export {}' }, validManifest())
    const file = await open(join(source, 'large.bin'), 'w')
    try { await file.truncate(65 * 1024 * 1024) } finally { await file.close() }
    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow('Extension source exceeds 64 MiB')
  })

  it('rejects a folder with no manifest', async () => {
    const source = await makeSourceFolder({ 'dist/index.js': 'export function activate() {}' })
    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(
      /not an Agent Code extension/,
    )
  })

  it('rejects a manifest whose entry does not exist', async () => {
    const source = await makeSourceFolder({ 'other.js': 'export {}' }, validManifest())
    await expect(installExtensionFromPath(source, denyConsent)).rejects.toThrow(
      /does not exist in the repository/,
    )
  })

  it('rejects a missing source folder without creating anything', async () => {
    await expect(
      installExtensionFromPath(join(tmpdir(), 'agent-code-install-tree-absent'), denyConsent),
    ).rejects.toThrow(/does not exist/)
  })
})
