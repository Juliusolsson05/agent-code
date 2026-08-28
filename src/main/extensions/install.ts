import { spawn } from 'child_process'
import { createHash } from 'node:crypto'
import { access, constants as fsConstants, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'fs/promises'
import { join, relative, resolve as resolvePath, sep } from 'path'

import { EXTENSIONS_DIR } from '@main/storage/paths.js'
import { computeBundleHash } from '@main/extensions/bundleHash.js'
import { ManifestError, parseExtensionManifest } from '@main/extensions/manifest.js'
import { readLedger, writeLedger } from '@main/extensions/ledger.js'
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
  return `${match[1]}/${match[2]}`
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
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers })
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

  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers })
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

async function downloadTarball(url: string): Promise<{ bytes: Buffer; sha256: string }> {
  const res = await fetch(url, { headers: { 'user-agent': 'agent-code' } })
  if (!res.ok) throw new InstallError(`Download failed with HTTP ${res.status}.`)

  // Buffered rather than streamed to disk because we need the hash of the exact
  // bytes we are about to extract, and because MAX_TARBALL_BYTES keeps the ceiling
  // small. A streaming hash would avoid the buffer but complicates the cap: a
  // stream that exceeds the limit has already written part of a file we then have
  // to clean up. If extensions ever get large enough for this to matter, switch to
  // streaming with an abort-on-cap, not to a bigger buffer.
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > MAX_TARBALL_BYTES) {
    throw new InstallError(`Archive is ${Math.round(declared / 1e6)} MB; the limit is 32 MB.`)
  }

  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.byteLength > MAX_TARBALL_BYTES) {
    throw new InstallError(`Archive is ${Math.round(bytes.byteLength / 1e6)} MB; the limit is 32 MB.`)
  }

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
    const child = spawn(tar, ['-xzf', archivePath, '-C', destDir, '--strip-components=1'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveExtract()
      else reject(new InstallError(`Could not unpack the archive (tar exit ${code}): ${stderr.trim()}`))
    })
  })
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
 * The dot prefix keeps it out of the ledger's view of installed extension directories.
 */
async function makeStagingDir(): Promise<string> {
  await mkdir(EXTENSIONS_DIR, { recursive: true })
  return await mkdtemp(join(EXTENSIONS_DIR, '.staging-'))
}

async function finalizeInstall(
  manifest: ExtensionManifest,
  bundleDir: string,
  provenance: { repo: string; ref: string; sha256: string },
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

  // Remove any previous install of this id before renaming the new one in. This
  // makes install idempotent and doubles as the update path. Extension STATE is
  // untouched — it lives under EXTENSION_STATE_DIR precisely so an update cannot
  // take a user's saved data with it.
  await rm(finalDir, { recursive: true, force: true })
  await rename(bundleDir, finalDir)

  // Hashed AFTER the rename, from the FINAL location, on purpose: this value's
  // only job is to be recomputable later from exactly the directory the scheme
  // handler serves. Hashing the staging directory instead would produce the same
  // digest today and quietly stop matching the moment the two ever diverge (a
  // partial rename, a future post-install step), which is the failure mode a
  // grant check must not have.
  const bundleSha256 = await computeBundleHash(finalDir)

  const record: InstalledExtension = {
    manifest,
    repo: provenance.repo,
    ref: provenance.ref,
    sha256: provenance.sha256,
    bundleSha256,
    installedAt: Date.now(),
  }

  const ledger = await readLedger()
  await writeLedger([...ledger.filter(row => row.manifest.id !== manifest.id), record])

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

    const manifest = await readManifestFrom(staging)
    await verifyEntryInsideBundle(staging, manifest.entry)

    return await finalizeInstall(manifest, staging, { repo, ref: source.ref, sha256 }, promptConsent)
  } finally {
    await rm(work, { recursive: true, force: true })
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
      filter: src => {
        const rel = relative(sourceReal, src)
        return rel === '' || !rel.split(sep).some(part => part === 'node_modules' || part === '.git')
      },
    })

    const manifest = await readManifestFrom(staging)
    await verifyEntryInsideBundle(staging, manifest.entry)

    // No tarball to hash, so bind the grant to the built ENTRY bytes: they change
    // exactly when the code the user is consenting to changes, which is the grant's
    // whole invariant. A dev rebuild therefore correctly forces re-consent.
    const entryBytes = await readFile(join(staging, manifest.entry))
    const sha256 = createHash('sha256').update(entryBytes).digest('hex')

    return await finalizeInstall(
      manifest,
      staging,
      { repo: sourceReal, ref: 'local', sha256 },
      promptConsent,
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
