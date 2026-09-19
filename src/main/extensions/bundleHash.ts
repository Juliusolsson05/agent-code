import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, readlink } from 'fs/promises'
import { join, relative, sep } from 'path'
import { BUNDLE_MAX_BYTES, BUNDLE_MAX_DEPTH, BUNDLE_MAX_ENTRIES } from './bundleLimits.js'

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

// ── THIS FUNCTION RUNS ON EVERY FRAME OPEN, IN MAIN, SO IT MUST BE BOUNDED ──
//
// The installer's caps do not imply a bound here. MAX_TARBALL_BYTES bounds a
// COMPRESSED download on the GitHub path only; the local-folder path has no size
// limit at all; and a bundle can also grow after install by any means outside the
// app. Meanwhile every capability check re-reads the whole tree in the process
// that holds every agent session.
//
// So the limits live with the walk, not with the installer. Exceeding any of them
// THROWS, which is the correct failure: every caller already treats a throw as "no
// capabilities", so an implausible bundle degrades to Tier-0 instead of wedging the
// main process. The values are ~50x the largest plausible real extension.
const MAX_FILES = BUNDLE_MAX_ENTRIES
const MAX_TOTAL_BYTES = BUNDLE_MAX_BYTES
const MAX_DEPTH = BUNDLE_MAX_DEPTH

export class BundleTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleTooLargeError'
  }
}

type BundleFile = { absolute: string; rel: string; link: boolean }

async function collectFiles(root: string, dir: string, out: BundleFile[], budget: { entries: number }, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) throw new BundleTooLargeError(`bundle nests deeper than ${MAX_DEPTH} directories`)
  // Stream directory entries and count directories too. readdir allocates the
  // whole directory before a cap can run, and a tree of empty directories evades
  // a files-only cap while still occupying the main process with traversal.
  const directory = await opendir(dir)
  for await (const dirent of directory) {
    if (++budget.entries > MAX_FILES) throw new BundleTooLargeError(`bundle contains more than ${MAX_FILES} files or directories`)
    const absolute = join(dir, dirent.name)
    const stats = await lstat(absolute)
    if (stats.isDirectory()) {
      await collectFiles(root, absolute, out, budget, depth + 1)
    } else if (stats.isSymbolicLink() || stats.isFile()) {
      out.push({ absolute, rel: relative(root, absolute).split(sep).join('/'), link: stats.isSymbolicLink() })
    } else {
      throw new Error('extension bundles may not contain special files')
    }
  }
}

function enforceByteBudget(size: number): void {
  if (size > MAX_TOTAL_BYTES) {
    throw new BundleTooLargeError(`bundle exceeds ${Math.round(MAX_TOTAL_BYTES / 1e6)} MB of hashable content`)
  }
}

/**
 * SHA-256 over every file in `bundleDir`, path-sensitive and order-independent.
 *
 * Throws if the directory cannot be read, is empty, or exceeds the bounds above.
 * Callers MUST treat every throw as "no valid hash", never as "unchanged" — a
 * missing bundle with a passing grant check is precisely the fail-open this
 * function exists to remove.
 */
export async function computeBundleHash(bundleDir: string): Promise<string> {
  const files: BundleFile[] = []
  await collectFiles(bundleDir, bundleDir, files, { entries: 0 }, 0)
  if (files.length === 0) throw new Error(`extension bundle at ${bundleDir} contains no files`)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  const digest = createHash('sha256')
  let totalBytes = 0
  for (const { absolute, rel, link } of files) {
    digest.update(`${link ? 'l' : 'f'}${FIELD}`)
    digest.update(`${rel.length}${FIELD}${rel}${FIELD}`)
    if (link) {
      const payload = Buffer.from(await readlink(absolute), 'utf8')
      totalBytes += payload.byteLength
      enforceByteBudget(totalBytes)
      digest.update(`${payload.byteLength}${FIELD}`)
      digest.update(payload)
      continue
    }
    // Bound before allocation, then stream. readFile followed by a size check
    // had already allocated the entire hostile file. O_NOFOLLOW also refuses a
    // file swapped for a symlink since the walk; NONBLOCK avoids hanging on a
    // swapped FIFO before fstat can reject it.
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stats = await file.stat()
      if (!stats.isFile()) throw new Error('extension bundle file changed during hashing')
      enforceByteBudget(totalBytes + stats.size)
      digest.update(`${stats.size}${FIELD}`)
      let bytes = 0
      for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
        bytes += chunk.length
        enforceByteBudget(totalBytes + bytes)
        if (bytes > stats.size) throw new Error('extension bundle file grew during hashing')
        digest.update(chunk)
      }
      if (bytes !== stats.size) throw new Error('extension bundle file changed during hashing')
      totalBytes += bytes
    } finally { await file.close() }
  }
  return digest.digest('hex')
}
