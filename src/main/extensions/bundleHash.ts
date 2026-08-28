import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'fs/promises'
import { join, relative, sep } from 'path'

// The content hash of an INSTALLED extension bundle.
//
// ── WHY THIS EXISTS ──
// The capability grant is supposed to bind to the exact code the user consented
// to: "when the bytes change, the grant no longer matches and the capabilities
// must be re-approved" (grants.ts). That invariant was documented but not
// implemented. The grant recorded the ledger's `sha256` and the check read the
// ledger's `sha256` — both written by the same finalizeInstall() call, so the
// comparison could never fail. Nothing ever looked at the bundle on disk again,
// so editing a file under EXTENSIONS_DIR kept every granted capability.
//
// The tarball hash cannot fix that: the tarball is deleted after extraction, so
// it is unrecomputable by construction. It answers a real but DIFFERENT question
// ("which bytes did GitHub hand me"), which is why it is kept as provenance
// rather than repurposed. This hash answers "what am I about to run", and it is
// the only one that can be recomputed later — which is the entire requirement.
//
// ── WHY THE WHOLE BUNDLE AND NOT JUST `entry` ──
// The entry module is one file, but the scheme handler serves EVERY file under
// the bundle root and the entry can `import('./util.js')` at runtime. Hashing
// only the entry would let a swapped sibling chunk keep a matching grant, so the
// capabilities would be held by code the user never approved — the exact failure
// this is meant to close.
//
// ── WHY THIS SHAPE OF DIGEST ──
// Sorted relative paths, with an explicit length prefix on every field. Sorting
// makes the result independent of readdir order, which is filesystem- and
// platform-dependent. The length prefixes make the encoding unambiguous: without
// them the pair ("a/b", "c") and the pair ("a", "/bc") digest identically, so a
// rename could be made to collide with an edit.
//
// ── WHY SYMLINKS ARE HASHED AS THEIR TARGET STRING ──
// Following them would read files outside the bundle: a hash that changes for
// reasons unrelated to the extension, and a way to turn this function itself
// into an arbitrary-file read. The link's own target text is the part that
// belongs to the bundle, so that is what is hashed.

/** Field separator for the digest framing. Any byte works; the length prefixes
 *  are what make the encoding unambiguous, this only keeps it readable. */
const FIELD = ' '

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true })
  for (const dirent of dirents) {
    const absolute = join(dir, dirent.name)
    // lstat, never stat: a symlink must be recorded AS a symlink (see header).
    const stats = await lstat(absolute)
    if (stats.isDirectory()) {
      await collectFiles(absolute, out)
    } else if (stats.isSymbolicLink() || stats.isFile()) {
      out.push(absolute)
    }
    // Sockets, FIFOs and devices are deliberately skipped: they have no stable
    // content, and a bundle containing one is already malformed.
  }
}

/**
 * SHA-256 over every file in `bundleDir`, path-sensitive and order-independent.
 *
 * Throws if the directory cannot be read. Callers MUST treat that as "no valid
 * hash", never as "unchanged" — a missing bundle with a passing grant check is
 * precisely the fail-open this function exists to remove.
 */
export async function computeBundleHash(bundleDir: string): Promise<string> {
  const files: string[] = []
  await collectFiles(bundleDir, files)

  // Sort by the POSIX-normalized relative path so the digest is identical
  // regardless of readdir order or the platform's path separator.
  const entries = files
    .map(absolute => ({ absolute, rel: relative(bundleDir, absolute).split(sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  const digest = createHash('sha256')
  for (const { absolute, rel } of entries) {
    const stats = await lstat(absolute)
    const payload = stats.isSymbolicLink()
      ? Buffer.from(await readlink(absolute), 'utf8')
      : await readFile(absolute)
    digest.update(`${stats.isSymbolicLink() ? 'l' : 'f'}${FIELD}`)
    digest.update(`${rel.length}${FIELD}${rel}${FIELD}`)
    digest.update(`${payload.byteLength}${FIELD}`)
    digest.update(payload)
  }
  return digest.digest('hex')
}
