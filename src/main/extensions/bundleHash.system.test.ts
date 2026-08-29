import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { computeBundleHash } from '@main/extensions/bundleHash.js'

// `.system.test.ts` because this crosses a real filesystem boundary: the whole
// point of the function is what it reads off disk, and a mocked fs would test
// the mock's traversal rather than the one that runs in production.

const temporaryRoots: string[] = []

async function makeBundle(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-bundle-hash-'))
  temporaryRoots.push(root)
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, contents, 'utf8')
  }
  return root
}

afterEach(async () => {
  // try/finally-equivalent cleanup: a failed assertion must not leak a temp tree
  // into the next run, where a leftover directory would change a later digest.
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('computeBundleHash', () => {
  it('is stable for identical content in two different directories', async () => {
    // The property the grant check depends on: the digest is a function of the
    // bundle's CONTENT, not of where it happens to live or when it was written.
    // Without this, a reinstall of identical bytes would look like a change and
    // force pointless re-consent.
    const a = await makeBundle({ 'agent-code.extension.json': '{}', 'dist/index.js': 'export {}' })
    const b = await makeBundle({ 'agent-code.extension.json': '{}', 'dist/index.js': 'export {}' })
    expect(await computeBundleHash(a)).toBe(await computeBundleHash(b))
  })

  it('changes when a NON-entry file changes', async () => {
    // ── THE REGRESSION THIS FILE EXISTS FOR ──
    // The grant used to bind to the tarball digest (unrecomputable) and, on the
    // local-folder path, to the ENTRY file's bytes alone. Both let a sibling
    // chunk be swapped while the grant still matched — and the entry can
    // `import('./util.js')` at runtime, so that sibling is executed code holding
    // capabilities the user approved for something else.
    const before = await makeBundle({ 'dist/index.js': 'export {}', 'dist/util.js': 'export const a = 1' })
    const hashBefore = await computeBundleHash(before)
    await writeFile(join(before, 'dist/util.js'), 'export const a = 2', 'utf8')
    expect(await computeBundleHash(before)).not.toBe(hashBefore)
  })

  it('changes when a file is renamed but its bytes are not', async () => {
    // Guards the length-framed encoding. Digesting bare concatenated paths and
    // contents would let ("a/b","c") collide with ("a","/bc"), so a rename could
    // be crafted to preserve the hash.
    const original = await makeBundle({ 'a/b.js': 'x', 'c.js': 'y' })
    const renamed = await makeBundle({ 'a.js': 'x', 'b/c.js': 'y' })
    expect(await computeBundleHash(original)).not.toBe(await computeBundleHash(renamed))
  })

  it('changes when a file is added or removed', async () => {
    const base = await makeBundle({ 'dist/index.js': 'export {}' })
    const hashBase = await computeBundleHash(base)
    await writeFile(join(base, 'dist/extra.js'), 'export {}', 'utf8')
    expect(await computeBundleHash(base)).not.toBe(hashBase)
  })

  it('hashes a symlink by its target string and never follows it', async () => {
    // Following would (a) make the digest depend on a file outside the bundle and
    // (b) turn this function into an arbitrary-file read for anything that can
    // commit a symlink to a repository.
    const root = await mkdtemp(join(tmpdir(), 'agent-code-bundle-hash-'))
    temporaryRoots.push(root)
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'secret', 'utf8')
    const bundle = join(root, 'bundle')
    await mkdir(bundle, { recursive: true })
    await symlink(outside, join(bundle, 'link.js'))

    const hashBefore = await computeBundleHash(bundle)
    // Changing the TARGET's contents must not move the bundle's hash: the target
    // is not part of the bundle.
    await writeFile(outside, 'different secret entirely', 'utf8')
    expect(await computeBundleHash(bundle)).toBe(hashBefore)
  })

  it('rejects a missing directory rather than returning a hash', async () => {
    // Callers treat a throw as "no capabilities". A function that returned some
    // sentinel digest for an absent bundle would let a deleted extension keep its
    // grant, which is the fail-open the whole change removes.
    await expect(computeBundleHash(join(tmpdir(), 'agent-code-bundle-hash-does-not-exist'))).rejects.toThrow()
  })
})
