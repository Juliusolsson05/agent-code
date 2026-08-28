import { spawn } from 'child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  constants as fsConstants,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'path'

import { EXTENSIONS_DIR } from '@main/storage/paths.js'
import { computeBundleHash } from '@main/extensions/bundleHash.js'
import { ManifestError, parseExtensionManifest } from '@main/extensions/manifest.js'
import { readLedger, withLedgerLock, writeLedger } from '@main/extensions/ledger.js'
import { recordGrant, revokeGrant } from '@main/extensions/grants.js'
import type { ExtensionManifest, InstalledExtension } from '@shared/types/extensions.js'

/**
 * Asked to approve an extension's requested capabilities before it is installed.
 * Returns true to proceed. Injected (rather than calling an Electron dialog here)
 * so install stays a pure pipeline — the IPC layer supplies the real prompt.
 */
export type ConsentPrompt = (manifest: ExtensionManifest) => Promise<boolean>

const MANIFEST_FILENAME = 'agent-code.extension.json'

// 32 MB. An extension is a built JS bundle plus assets; anything larger is either a
// mistake (someone committed node_modules) or hostile. The cap exists because the
// download is buffered in memory to hash it — see downloadTarball.
const MAX_TARBALL_BYTES = 32 * 1024 * 1024

// How long a request may make NO progress before it is abandoned. Applied as a
// total deadline to the two small metadata calls, and as an IDLE budget to the
// download — see downloadTarball for why a total deadline is wrong there.
const NETWORK_TIMEOUT_MS = 30_000

// The EXTRACTED ceiling, which is a different quantity from MAX_TARBALL_BYTES and
// the one that actually protects the disk. 256 MB is ~8x the compressed cap and
// orders of magnitude above any real extension; anything past it is a bomb or a
// mistake, and either way is not something to unpack into the user's home
// directory.
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024

// A file-COUNT ceiling. Neither byte cap implies one — half a million empty files
// compress to nothing — and every file costs a stat at install plus a read on every
// bundle hash. See assertBundleTreeIsSafe.
const MAX_BUNDLE_FILES = 10_000

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/**
 * Accepts what a user is likely to paste and normalizes to `owner/repo`.
 *
 * Deliberately permissive about the input format and strict about the output: every
 * later step (API URL construction, ledger key) assumes `owner/repo` with no path
 * traversal or query string in it.
 */
export function normalizeRepo(input: string): string {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  // https://github.com/owner/repo, git@github.com:owner/repo, or owner/repo
  const match =
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+)$/.exec(trimmed)
  if (!match) {
    throw new InstallError(
      `"${input}" is not a GitHub repository. Use owner/repo or a github.com URL.`,
    )
  }

  // ── A SEGMENT OF ONLY DOTS IS NOT A REPOSITORY NAME, IT IS PATH TRAVERSAL ──
  // `[\w.-]+` matches `.` and `..`, so `../x` parsed happily into owner `..`. The
  // result is interpolated into `https://api.github.com/repos/${repo}` and into the
  // codeload URL, where the URL parser NORMALIZES the `..` away — so the request
  // silently addressed a different GitHub API endpoint than the one this code
  // believes it is calling, and the bogus value was then recorded in the ledger and
  // rendered in Settings. GitHub allows neither name, so nothing legitimate is lost
  // by rejecting them here rather than discovering it from a confusing 404.
  const [, owner, repo] = match
  for (const segment of [owner, repo]) {
    if (/^\.+$/.test(segment)) {
      throw new InstallError(
        `"${input}" is not a GitHub repository. Use owner/repo or a github.com URL.`,
      )
    }
  }
  return `${owner}/${repo}`
}

type ResolvedSource = { ref: string; tarballUrl: string }

/**
 * Pick which ref to install.
 *
 * Prefers the latest release, because a release is the author saying "this is
 * ready" — installing the default branch means installing whatever was pushed
 * thirty seconds ago. Falls back to the default branch so an extension without
 * releases is still installable, which matters a lot early on when the author and
 * the user are the same person.
 */
async function resolveSource(repo: string): Promise<ResolvedSource> {
  const headers = {
    accept: 'application/vnd.github+json',
    // GitHub rejects API requests without a User-Agent.
    'user-agent': 'agent-code',
  }

  try {
    const res = await fetchWithDeadline(`https://api.github.com/repos/${repo}/releases/latest`, headers)
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: string; tarball_url?: string }
      if (body.tag_name && body.tarball_url) {
        return { ref: body.tag_name, tarballUrl: body.tarball_url }
      }
    }
  } catch {
    // Network failure here is not fatal — fall through to the default branch, which
    // uses a different host (codeload) and may still succeed. A hard failure will
    // surface there with a better message.
  }

  const res = await fetchWithDeadline(`https://api.github.com/repos/${repo}`, headers)
  if (res.status === 404) {
    throw new InstallError(`Repository ${repo} not found, or it is private.`)
  }
  if (!res.ok) {
    throw new InstallError(`GitHub returned ${res.status} for ${repo}.`)
  }
  const body = (await res.json()) as { default_branch?: string }
  const branch = body.default_branch
  if (!branch) throw new InstallError(`Could not determine the default branch of ${repo}.`)

  return {
    ref: branch,
    tarballUrl: `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`,
  }
}

/**
 * Every network call in this module goes through here.
 *
 * WHY A DEADLINE IS NOT OPTIONAL: these are fetches to a host the USER named, made
 * from the main process. Without one, a server that accepts the connection and then
 * never responds leaves the install promise pending forever — the Settings row stays
 * "Installing…", its button stays disabled, and there is no cancel affordance
 * anywhere in the UI. A hung install is indistinguishable from a slow one and the
 * only escape is restarting the app.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

async function fetchWithDeadline(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
  } catch (error) {
    // AbortSignal rejects with a TimeoutError/AbortError DOMException, which reaches
    // the user as "The operation was aborted" — true and useless. Name the host.
    if (isAbort(error)) {
      throw new InstallError(`${new URL(url).host} did not respond in time.`)
    }
    throw error
  }
}

async function downloadTarball(url: string): Promise<{ bytes: Buffer; sha256: string }> {
  // ── THE BODY GETS AN IDLE BUDGET, NOT A TOTAL ONE ──
  // A single AbortSignal.timeout() covering the whole request is wrong here in two
  // ways. First the arithmetic: 32 MB inside 30 s demands a sustained 8.7 Mbps, so
  // a legitimate large-but-legal extension fails on an ordinary connection. Second
  // the error handling: when that signal fires during the body read it throws out
  // of the `for await` below, which is OUTSIDE fetchWithDeadline's try/catch — so
  // the translation never ran and the user got exactly the "The operation was
  // aborted" string the translation exists to prevent.
  //
  // An idle timer measures what actually matters — the connection has stopped
  // making progress — and rearms on every chunk, so a slow but live download
  // completes however long it legitimately takes.
  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  }
  armIdleTimer()

  try {
    return await readTarball(url, controller.signal, armIdleTimer)
  } catch (error) {
    if (isAbort(error)) {
      throw new InstallError(`${new URL(url).host} stopped responding during the download.`)
    }
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}

async function readTarball(
  url: string,
  signal: AbortSignal,
  onProgress: () => void,
): Promise<{ bytes: Buffer; sha256: string }> {
  const res = await fetchWithDeadline(url, { 'user-agent': 'agent-code' }, signal)
  if (!res.ok) throw new InstallError(`Download failed with HTTP ${res.status}.`)

  // ── THE CAP IS ENFORCED WHILE READING, NOT AFTER ──
  // This used to check `content-length` and then call `res.arrayBuffer()`, which are
  // two different things. The header is supplied by the server, so it is a HINT, not
  // a bound: omit it (chunked encoding is enough) or lie about it, and arrayBuffer()
  // allocates the entire body first — the size check then runs on an allocation that
  // has already happened. A hostile or merely misconfigured host could therefore
  // drive the MAIN PROCESS, the one holding every agent session, to an
  // out-of-memory kill from a URL the user only pasted a repo name for.
  //
  // Counting while reading makes the limit real: the abort happens at the moment the
  // cap is crossed, so peak allocation is bounded by MAX_TARBALL_BYTES plus one
  // chunk no matter what the server claims.
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
    // A cheap early exit WHEN the header is present — which on the primary path it
    // usually is not, because codeload generates the tarball on the fly and responds
    // chunked. So this is a bonus, never the bound; the counter below is the bound.
    throw new InstallError(`Archive is ${Math.round(declared / 1e6)} MB; the limit is 32 MB.`)
  }
  if (!res.body) throw new InstallError('Download returned an empty response.')

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    onProgress()
    total += chunk.byteLength
    if (total > MAX_TARBALL_BYTES) throw new InstallError('Archive exceeds the 32 MB limit.')
    chunks.push(Buffer.from(chunk))
  }

  const bytes = Buffer.concat(chunks)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function resolveTarBinary(): Promise<string> {
  try {
    await access('/usr/bin/tar', fsConstants.X_OK)
    return '/usr/bin/tar'
  } catch {
    // Bare name → spawn resolves through PATH. Mirrors setup/runtimeTools.ts, which
    // is deliberately not imported: extension install must not depend on the
    // bundled-runtime-tools subsystem, and the duplication is twenty lines.
    return 'tar'
  }
}

async function extractTarball(archivePath: string, destDir: string): Promise<void> {
  const tar = await resolveTarBinary()
  await new Promise<void>((resolveExtract, reject) => {
    // --strip-components=1 removes GitHub's `<repo>-<sha>/` wrapper directory, so
    // the manifest lands at destDir/agent-code.extension.json rather than one level
    // down under a name that changes with every commit.
    //
    // --no-same-owner / --no-same-permissions: the archive is attacker-controlled,
    // and its entries carry a uid/gid and a mode. Honouring either lets the archive
    // decide what the extracted files look like on disk — a setuid bit, a
    // group-writable directory, an owner that is not the running user. Neither is
    // ever wanted for what is supposed to be a bundle of JavaScript. Both flags are
    // accepted by bsdtar (macOS /usr/bin/tar) and GNU tar.
    //
    // NOT relied upon: the extractor's own traversal defences. bsdtar refuses `..`
    // members and refuses to write THROUGH a symlink by default, and that was
    // verified empirically — but `resolveTarBinary` can fall back to whatever `tar`
    // is on PATH, which may be a different implementation with different defaults.
    // assertBundleTreeIsSafe below is what actually holds the guarantee, because it
    // does not depend on which binary ran.
    const child = spawn(
      tar,
      [
        '-xzf',
        archivePath,
        '-C',
        destDir,
        '--strip-components=1',
        '--no-same-owner',
        '--no-same-permissions',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )

    // ── THE DOWNLOAD CAP DOES NOT BOUND THE EXTRACTION ──
    // MAX_TARBALL_BYTES bounds COMPRESSED bytes. gzip on repetitive content runs
    // 1000:1 and better, so a 32 MB archive that passes every check upstream can
    // write tens of gigabytes here. EXTENSIONS_DIR is under $HOME, i.e. the boot
    // volume, so filling it degrades the whole machine rather than just this app —
    // and a Tier-0 manifest (which is what such a repository would ship) reaches
    // this point with NO dialog of any kind, from a pasted `owner/repo`.
    //
    // Polled rather than streamed through a counting transform: the polling version
    // is a dozen lines against a rewrite of the extraction path, it needs no
    // in-process gunzip, and 500 ms of overshoot on a disk write is immaterial next
    // to a cap this generous. On breach the child is SIGKILLed and the caller's
    // `finally` removes the partial tree.
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      clearInterval(sizeTimer)
      run()
    }

    const sizeTimer = setInterval(() => {
      void directorySize(destDir).then(bytes => {
        if (bytes <= MAX_EXTRACTED_BYTES) return
        child.kill('SIGKILL')
        finish(() =>
          reject(
            new InstallError(
              `Archive expands to more than ${Math.round(MAX_EXTRACTED_BYTES / 1e6)} MB; ` +
                `refusing to install it.`,
            ),
          ),
        )
      }).catch(() => {
        // A stat failure mid-extraction is not evidence of a bomb (files come and
        // go while tar writes); the next tick re-measures.
      })
    }, 500)

    // Capped: stderr is attacker-influenced (tar echoes member names), and an
    // archive with a million bad members would otherwise grow this string without
    // bound in the main process while the extraction it is reporting on fails.
    let stderr = ''
    child.stderr.on('data', chunk => {
      if (stderr.length < 4096) stderr += String(chunk)
    })
    child.once('error', error => finish(() => reject(error)))
    child.once('exit', code => {
      finish(() => {
        if (code === 0) resolveExtract()
        else
          reject(
            new InstallError(`Could not unpack the archive (tar exit ${code}): ${stderr.trim()}`),
          )
      })
    })
  })
}

/** Total size of a directory tree, following nothing. Used only as a bomb guard. */
async function directorySize(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    for (const dirent of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, dirent.name)
      const stats = await lstat(absolute)
      if (stats.isDirectory()) await walk(absolute)
      else total += stats.size
    }
  }
  await walk(dir)
  return total
}

/**
 * Reject a staged bundle that contains anything pointing outside itself.
 *
 * ── WHY THIS EXISTS EVEN THOUGH THREE OTHER CHECKS LOOK SIMILAR ──
 * The scheme handler realpath-checks each file it SERVES, and
 * verifyEntryInsideBundle realpath-checks the ENTRY. Both are per-file checks made
 * later, and neither says anything about the rest of the tree. This one is about
 * the bundle as a whole, and it runs at the only moment where refusing is still
 * free: before the bundle is moved into place, before consent is asked, before a
 * grant exists.
 *
 * What it stops:
 * - An escaping symlink surviving into the installed directory. Serving it is
 *   already blocked, but its mere presence means `computeBundleHash` is hashing a
 *   link whose target the extension does not own, and every future reader of that
 *   directory (a backup, a sync client, a future feature that walks the bundle)
 *   inherits a pointer out of the sandbox that nobody put there deliberately.
 * - The extractor's defences differing by implementation. bsdtar blocks `..`
 *   members and symlink write-through by default; `resolveTarBinary` may fall back
 *   to a `tar` on PATH that does not. Checking the RESULT rather than trusting the
 *   tool makes the guarantee independent of which binary ran.
 * - Entry types that have no business in a JavaScript bundle at all — sockets,
 *   FIFOs, devices — which would otherwise be copied into place and then hashed.
 *
 * A dangling symlink is fine and stays allowed: it points nowhere, so it can leak
 * nothing, and rejecting it would break bundles that ship optional artefacts.
 */
async function assertBundleTreeIsSafe(bundleDir: string): Promise<void> {
  const rootReal = await realpath(bundleDir)
  let seen = 0

  const walk = async (dir: string): Promise<void> => {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      // ── A FILE-COUNT CAP, BECAUSE THE BYTE CAPS DO NOT IMPLY ONE ──
      // 500,000 empty files compress to a couple of megabytes and extract to almost
      // nothing, so they pass both the download and the extraction limits. They
      // would then cost a readdir+lstat here, a readFile each in computeBundleHash
      // at install, and another full hash on every frame open — all on the main
      // process, which already has a documented saturation problem. 10,000 is ~50x
      // any real bundle.
      if (++seen > MAX_BUNDLE_FILES) {
        throw new InstallError(
          `The repository contains more than ${MAX_BUNDLE_FILES} files. An extension is a ` +
            `built bundle; this looks like an unbuilt source tree.`,
        )
      }
      const absolute = join(dir, dirent.name)
      const stats = await lstat(absolute)

      if (stats.isSymbolicLink()) {
        let targetReal: string
        try {
          targetReal = await realpath(absolute)
        } catch {
          // Dangling. Points at nothing, so it leaks nothing.
          continue
        }
        if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
          throw new InstallError(
            `The repository contains a symlink ("${relative(rootReal, absolute)}") that points ` +
              `outside the extension directory. Refusing to install it.`,
          )
        }
        continue
      }

      if (stats.isDirectory()) {
        await walk(absolute)
        continue
      }

      if (!stats.isFile()) {
        throw new InstallError(
          `The repository contains a special file ("${relative(rootReal, absolute)}") that is not ` +
            `a regular file, directory or symlink. Refusing to install it.`,
        )
      }
    }
  }

  await walk(rootReal)
}

/**
 * Verify the manifest's `entry` resolves to a real file INSIDE the bundle.
 *
 * The schema already rejects absolute paths and `..` segments, but this is the
 * check that actually matters: a symlink committed to the repository can point
 * anywhere, and tar will happily recreate it. Resolving the realpath and requiring
 * it to stay under the bundle root is the only way to catch that. Without it, a
 * manifest saying `entry: "link.js"` where `link.js` symlinks to `~/.ssh/id_rsa`
 * would hand that file to a scheme handler that serves extension code.
 */
async function verifyEntryInsideBundle(bundleDir: string, entry: string): Promise<void> {
  const bundleReal = await realpath(bundleDir)
  const target = resolvePath(bundleReal, entry)

  let targetReal: string
  try {
    targetReal = await realpath(target)
  } catch {
    throw new InstallError(`Manifest points at "${entry}", which does not exist in the repository.`)
  }

  if (targetReal !== bundleReal && !targetReal.startsWith(bundleReal + sep)) {
    throw new InstallError(`Manifest entry "${entry}" resolves outside the extension directory.`)
  }
}

async function readManifestFrom(dir: string): Promise<ExtensionManifest> {
  const manifestPath = join(dir, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new InstallError(
      `Repository has no ${MANIFEST_FILENAME} at its root — it is not an Agent Code extension.`,
    )
  }
  try {
    return parseExtensionManifest(raw)
  } catch (error) {
    // ManifestError messages are already user-facing; rewrap so callers only have
    // one error type to present.
    throw new InstallError(error instanceof ManifestError ? error.message : String(error))
  }
}

/**
 * The shared tail of every install path: consent, move the validated bundle into
 * place, write the ledger row, bind (or drop) the grant. Both the GitHub and the
 * local-folder installers converge here once they have a validated manifest in a
 * staging directory — the ONLY differences between them are how the bundle got
 * staged and what `repo`/`ref`/`sha256` describe its provenance.
 *
 * `bundleDir` is renamed into place (not copied), so it must already be a temp
 * directory the caller owns; on any failure here the caller's `finally` removes it.
 */
/**
 * A staging directory INSIDE the extensions root, not in the OS temp dir.
 *
 * finalizeInstall commits by `rename(staging, finalDir)`. rename cannot cross
 * filesystems: where /tmp is its own mount — Linux tmpfs, the common case — it fails
 * with EXDEV. And because the commit deletes the live bundle BEFORE the rename, that
 * failure mode is not "install didn't work", it is "install destroyed the version you
 * had". Staging as a sibling of the destination makes the rename same-filesystem by
 * construction, which is the only way to get atomicity out of it.
 *
 * The dot prefix is NOT "kept out of the ledger's view", as this comment used to
 * claim — nothing in the app enumerates EXTENSIONS_DIR, so there was no scan for it
 * to be excluded from. What the prefix actually buys is that `.staging-…` can never
 * be a valid extension id (ids must start with a letter), so `scheme.ts` can never
 * be tricked into serving a half-extracted tree, and the startup sweep can identify
 * these directories unambiguously.
 */
async function makeStagingDir(): Promise<string> {
  await mkdir(EXTENSIONS_DIR, { recursive: true })
  return await mkdtemp(join(EXTENSIONS_DIR, '.staging-'))
}

async function finalizeInstall(
  manifest: ExtensionManifest,
  bundleDir: string,
  provenance: { origin: 'github' | 'local'; repo: string; ref: string; sha256: string },
  promptConsent?: ConsentPrompt,
): Promise<InstalledExtension> {
  // Consent gate. If the extension requests capabilities beyond Tier 0, the user
  // must approve them BEFORE the bundle moves into place — declining aborts the
  // install, so nothing is left behind. A Tier-0-only extension installs with no
  // prompt, matching the "repo name is the trust decision" stance.
  const permissions = manifest.permissions ?? []
  if (permissions.length > 0) {
    const approved = promptConsent ? await promptConsent(manifest) : false
    if (!approved) {
      throw new InstallError(
        `Installation of ${manifest.name} was declined — its requested capabilities were not granted.`,
      )
    }
  }

  await mkdir(EXTENSIONS_DIR, { recursive: true })
  const finalDir = join(EXTENSIONS_DIR, manifest.id)

  // ── EVERYTHING FALLIBLE HAPPENS BEFORE ANYTHING IS DESTROYED ──
  //
  // The previous ordering was rm(finalDir) → rename(staging) → computeBundleHash
  // → writeLedger, i.e. it destroyed the installed version and committed the new
  // one BEFORE its last two fallible steps. Three ordinary failures broke it:
  //
  //  - A crash between the rm and the rename left NO bundle and a surviving
  //    ledger row: the row reads `present: false` and the only recovery is a
  //    reinstall the user has to work out for themselves.
  //  - computeBundleHash throwing (a concurrent remove deleting the directory
  //    under it, ENOSPC, EACCES) left the new bundle on disk with no ledger row.
  //    Nothing enumerates EXTENSIONS_DIR, so that directory is invisible to the
  //    UI and unreachable by extensions:remove — a ghost nothing can delete.
  //  - writeLedger throwing did the same, and is *reachable in combination with
  //    a disk-filling archive*, which is exactly when it matters most.
  //
  // So: hash in staging, then swap. The hash is identical either way — staging is
  // a sibling of the destination by construction (makeStagingDir), so the rename
  // moves the same inodes and cannot alter content. The earlier comment argued the
  // hash had to come from the final location; that was buying a property the
  // same-filesystem guarantee already provides, at the cost of putting a throwing
  // call after the point of no return.
  const bundleSha256 = await computeBundleHash(bundleDir)

  const record: InstalledExtension = {
    manifest,
    origin: provenance.origin,
    repo: provenance.repo,
    ref: provenance.ref,
    sha256: provenance.sha256,
    installedAt: Date.now(),
  }

  // The previous version is moved ASIDE rather than deleted, so a failure can put
  // it back. This is what makes a failed update a no-op instead of an uninstall —
  // the single most important property of an update path, and the one the old
  // ordering did not have. Extension STATE is untouched throughout: it lives under
  // EXTENSION_STATE_DIR precisely so neither an update nor a rollback can take a
  // user's saved data with it.
  // ── THE SWAP AND THE LEDGER WRITE ARE ONE CRITICAL SECTION ──
  // Without the lock, two concurrent installs both read the ledger, both write it,
  // and the first one's row is lost while its bundle sits on disk referenced by
  // nothing. An install racing a remove of the same id resurrects the extension the
  // user just uninstalled. See withLedgerLock for the full account.
  await withLedgerLock(async () => {
    const backupDir = `${finalDir}.replacing-${randomUUID()}`
    let hadPrevious = true
    try {
      await rename(finalDir, backupDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      hadPrevious = false
    }

    try {
      await rename(bundleDir, finalDir)
      await writeLedger(
        (await readLedger()).filter(row => row.manifest.id !== manifest.id).concat(record),
      )
    } catch (error) {
      // Roll back to exactly what the user had. Best-effort: if the restore itself
      // fails there is nothing further to try, and the original error is the one
      // worth surfacing.
      await rm(finalDir, { recursive: true, force: true }).catch(() => {})
      if (hadPrevious) await rename(backupDir, finalDir).catch(() => {})
      throw error
    }

    // Committed. The old bundle is now unreferenced; failing to delete it is not
    // worth failing the install over, so it is swept at startup instead.
    if (hadPrevious) await rm(backupDir, { recursive: true, force: true }).catch(() => {})
  })

  // Bind the grant to the INSTALLED BYTES, not to the provenance hash.
  //
  // The grant used to key on `provenance.sha256`, which is the tarball digest —
  // and the tarball is deleted moments later, so the check could only ever
  // compare the ledger row against the grant row, both written right here. It
  // could not fail, and editing a file under EXTENSIONS_DIR kept every granted
  // capability. Keying on the recomputable bundle hash is what turns the
  // documented "bytes changed, so re-consent" rule into an enforced one.
  //
  // A downgrade to Tier-0-only still drops any prior grant, so revoking
  // capabilities remains as simple as shipping a manifest that stops asking.
  if (permissions.length > 0) await recordGrant(manifest.id, bundleSha256, permissions)
  else await revokeGrant(manifest.id)

  return record
}

/**
 * Reclaim directories under EXTENSIONS_DIR that no longer belong to anything.
 *
 * ── WHY THIS IS NEEDED AND WHY IT RUNS AT STARTUP ──
 * Installs create two kinds of transient directory: `.staging-XXXX` while the
 * bundle is being validated, and `<id>.replacing-<uuid>` while the swap is in
 * flight. Both are removed on the happy path and on a handled failure — but a
 * crash, a force-quit, or a kill during an install leaves them behind forever,
 * because nothing else ever looks at this directory. Each one costs up to the
 * extracted-size cap, so they are not a rounding error.
 *
 * Startup is the only safe moment: no install can be in flight, so anything
 * matching these shapes is definitionally abandoned. Doing it opportunistically
 * during an install would race a concurrent one.
 *
 * Deliberately conservative — it removes ONLY the two transient shapes. A bundle
 * directory with no ledger row is left alone: that is a different problem with a
 * different correct answer (the user may want to recover it), and silently deleting
 * from a directory that holds installed code is not something a sweep should do.
 */
export async function sweepAbandonedInstallDirectories(): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(EXTENSIONS_DIR)
  } catch {
    // No extensions directory yet. Nothing to reclaim.
    return
  }

  for (const name of entries) {
    if (!name.startsWith('.staging-') && !/\.replacing-[0-9a-f-]{36}$/.test(name)) continue
    await rm(join(EXTENSIONS_DIR, name), { recursive: true, force: true }).catch(error => {
      // Best-effort by design: this is housekeeping on a path that must never be
      // able to prevent the app from starting.
      console.warn(`[extensions] could not remove abandoned ${name}:`, error)
    })
  }
}

/**
 * Install (or reinstall) an extension from a GitHub repository.
 *
 * Sequence matters: everything that can fail happens in a temp directory, and the
 * bundle only moves into place once the manifest has validated and the entry has
 * been proven to exist inside it. A failed install therefore leaves no partial
 * directory for the loader to find — the failure mode the runtime-tools extractor
 * documents at length, reached here by the same route.
 */
export async function installExtension(
  repoInput: string,
  promptConsent?: ConsentPrompt,
): Promise<InstalledExtension> {
  const repo = normalizeRepo(repoInput)
  const source = await resolveSource(repo)
  const { bytes, sha256 } = await downloadTarball(source.tarballUrl)

  const work = await makeStagingDir()
  try {
    const archivePath = join(work, 'bundle.tar.gz')
    const staging = join(work, 'unpacked')
    await writeFile(archivePath, bytes)
    await mkdir(staging, { recursive: true })
    await extractTarball(archivePath, staging)
    await assertBundleTreeIsSafe(staging)

    const manifest = await readManifestFrom(staging)
    await verifyEntryInsideBundle(staging, manifest.entry)

    return await finalizeInstall(
      manifest,
      staging,
      { origin: 'github', repo, ref: source.ref, sha256 },
      promptConsent,
    )
  } finally {
    // .catch: `force` only suppresses ENOENT. A staging tree containing a
    // mode-0000 directory (reachable through Load folder…) makes this throw
    // EACCES, and a throw in a `finally` REPLACES whatever the try threw — so a
    // precise InstallError became a raw errno string and the real cause was lost.
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Install an extension from a LOCAL folder — the "load unpacked" path.
 *
 * WHY this exists: the GitHub installer resolves `releases/latest`, so iterating on
 * an unpublished extension otherwise means cutting a release for every change. This
 * lets an author point at their built folder and reinstall in one click. It is a
 * SNAPSHOT (a copy), not a live mount: a rebuild + reinstall is the loop, which is
 * still vastly cheaper than a release. A live-reference mode (serve straight from
 * the folder) is a larger change to the scheme handler and is deliberately left for
 * later — a copy reuses the exact same containment guarantees as the tarball path.
 */
export async function installExtensionFromPath(
  sourceDir: string,
  promptConsent?: ConsentPrompt,
): Promise<InstalledExtension> {
  let sourceReal: string
  try {
    sourceReal = await realpath(sourceDir)
  } catch {
    throw new InstallError(`Folder "${sourceDir}" does not exist.`)
  }

  const work = await makeStagingDir()
  try {
    const staging = join(work, 'unpacked')
    await mkdir(staging, { recursive: true })

    // Copy the folder, skipping node_modules and .git: the built bundle plus assets
    // is what ships; a dev folder's dependencies and history are neither needed nor
    // small (node_modules would blow past the mental model of "an extension is a JS
    // bundle"). This is the tarball path minus the download + strip-components.
    await cp(sourceReal, staging, {
      recursive: true,
      // ── verbatimSymlinks: COPY THE LINK TEXT, DO NOT RESOLVE IT ──
      // Node's default is `verbatimSymlinks: false`, which RESOLVES each symlink's
      // target to an absolute path while copying. That silently rewrites a bundle's
      // internal relative link (`alias.js -> dist/index.js`) into an absolute link
      // into the AUTHOR'S source folder — so a perfectly ordinary bundle came out of
      // the snapshot pointing at a directory outside itself, which the containment
      // check below then correctly refuses. The install failed and the message
      // blamed the author for a link they had written correctly.
      //
      // Copying verbatim is also the safer default, not just the working one: an
      // escaping link stays exactly as escaping as the author wrote it, so
      // assertBundleTreeIsSafe judges what the repository actually contains rather
      // than an absolutised rewrite of it.
      verbatimSymlinks: true,
      filter: src => {
        const rel = relative(sourceReal, src)
        return rel === '' || !rel.split(sep).some(part => part === 'node_modules' || part === '.git')
      },
    })
    await assertBundleTreeIsSafe(staging)

    const manifest = await readManifestFrom(staging)
    await verifyEntryInsideBundle(staging, manifest.entry)

    // PROVENANCE ONLY. There is no tarball, so the entry digest answers "which
    // bytes did the source hand me" for a local install. It does NOT bind the
    // grant — finalizeInstall binds that to computeBundleHash over the whole
    // installed directory, identically on both paths. An earlier comment here said
    // the opposite, describing entry-scoped binding as the design; entry-scoped
    // hashing was in fact half of the original defect, because it let a sibling
    // chunk be swapped while the grant still matched.
    const entryBytes = await readFile(join(staging, manifest.entry))
    const sha256 = createHash('sha256').update(entryBytes).digest('hex')

    return await finalizeInstall(
      manifest,
      staging,
      { origin: 'local', repo: sourceReal, ref: 'local', sha256 },
      promptConsent,
    )
  } finally {
    // .catch: `force` only suppresses ENOENT. A staging tree containing a
    // mode-0000 directory (reachable through Load folder…) makes this throw
    // EACCES, and a throw in a `finally` REPLACES whatever the try threw — so a
    // precise InstallError became a raw errno string and the real cause was lost.
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
