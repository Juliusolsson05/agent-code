import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { z } from 'zod'

import { EXTENSIONS_DIR, EXTENSIONS_LOCKFILE, STATE_DIR } from '@main/storage/paths.js'
import { isValidExtensionId } from '@shared/types/extensionId.js'
import type { ExtensionListEntry, InstalledExtension, QuarantinedExtensionEntry } from '@shared/types/extensions.js'

import { apiVersionMismatch, extensionManifestSchema } from './manifest.js'
import { removeExtensionSecrets } from './secrets.js'

// The install ledger.
//
// WHY a ledger separate from "whatever directories exist under EXTENSIONS_DIR":
// scanning the directory would make the filesystem the source of truth, and a
// half-extracted or hand-copied folder would then look installed. The ledger
// records what the app *decided* to install, with the repo, ref and hash that
// produced it — questions the directory cannot answer. The directory is the
// artifact; this is the record.

// Row shape validation. WHY re-validate a file only writeLedger writes: the
// `manifest.id` and `manifest.entry` of every row are interpolated into a path
// (`join(EXTENSIONS_DIR, id, entry)` below) and into the import() URL the host
// loads code from. A hand-edited extensions.json is the one way an unvalidated
// id/entry could reach those sinks. The manifest schema already enforces the
// path-safety refinements (id regex, entry rejects `..`/absolute/backslash), so
// running each row through it turns "trust the file" into "trust the schema".
// Invalid records fail closed. Treating corruption as an empty or partial
// ledger would let the next install overwrite lost rows and let housekeeping
// delete their bundles. Preserve the file and surface a repairable error instead.
const installedExtensionSchema = z.object({
  manifest: extensionManifestSchema,
  installation: z.object({
    id: z.string().uuid(),
    bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  // Optional, and MIGRATED BELOW rather than defaulted here.
  //
  // An earlier version defaulted this to 'github' on the reasoning that any row
  // predating the field came from the GitHub installer. That reasoning was simply
  // false: `installExtensionFromPath` shipped on this same branch and has been
  // writing rows with an absolute path in `repo` ever since. Defaulting them to
  // 'github' sent every one of them down the GitHub Update path, straight into
  // `normalizeRepo('/Users/…')` — reproducing the exact failure the `origin` field
  // was added to fix, for precisely the users who had been using Load folder.
  origin: z.enum(['github', 'local']).optional(),
  repo: z.string().min(1),
  ref: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.number().finite(),
})

/**
 * A row the current build cannot use, kept verbatim (#959).
 *
 * ── WHY QUARANTINE RATHER THAN THROW ──
 * Every one of list, install, remove, the startup sweep, the scheme handler and
 * the capability check reads the ledger first. Throwing for the whole file
 * meant ONE unusable row disabled every installed extension — and, because
 * `removeExtension` reads before it writes, it also rejected, taking away the
 * only in-app way to recover. The user's escape was to hand-edit a JSON file
 * in `~/.config`.
 *
 * ── WHY THE RAW VALUE IS CARRIED, NOT A REPAIRED ONE ──
 * A row stops validating for reasons this build cannot reason about: an
 * extension targeting a NEWER api version after a rollback, or a schema a
 * future build tightened. We do not know what the field we would drop means, so
 * the bytes are written back untouched and the owning build gets its row back
 * intact. That is also why `raw` is `unknown`: it is evidence, not data.
 *
 * ── WHAT A PRESERVED ROW MUST STILL DO ──
 * Its bundle counts as REFERENCED by the sweep. Anything else and housekeeping
 * deletes the code that the row, once valid again, points at — which is exactly
 * the "existing bundles were preserved" promise the old error message made and
 * the throw then made impossible to keep.
 */
export type PreservedLedgerRow = {
  /** The row exactly as it sits in the file. Never interpreted. */
  raw: unknown
  /** `manifest.id` IF it is a valid id, so Settings can name and remove it.
   *  Null when even that is unreadable — such a row can only be reported. */
  id: string | null
  /** Why this build rejected it, in the user's terms. */
  reason: string
}

export type LedgerContents = {
  rows: InstalledExtension[]
  preserved: PreservedLedgerRow[]
}

/** `manifest.id` off an unvalidated row, only when it is a safe id. */
function preservedId(candidate: unknown): string | null {
  const manifest = candidate && typeof candidate === 'object'
    ? (candidate as { manifest?: unknown }).manifest
    : null
  const id = manifest && typeof manifest === 'object'
    ? (manifest as { id?: unknown }).id
    : null
  return typeof id === 'string' && isValidExtensionId(id) ? id : null
}

/**
 * The whole ledger: what this build can run, and what it is holding for later.
 *
 * A file that is not JSON, or not an array, still throws. There are no rows to
 * quarantine in that case — quarantine preserves a ROW, and reading a row is
 * the thing that failed. Rewriting such a file is how the bundles get orphaned.
 */
export async function readLedgerContents(): Promise<LedgerContents> {
  let raw: string
  try {
    raw = await readFile(EXTENSIONS_LOCKFILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], preserved: [] }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The extension install record is invalid JSON. Existing bundles were preserved.')
  }
  if (!Array.isArray(parsed)) throw new Error('The extension install record must be an array.')
  const rows: InstalledExtension[] = []
  const preserved: PreservedLedgerRow[] = []
  for (const candidate of parsed) {
    const result = installedExtensionSchema.safeParse(candidate)
    if (!result.success) {
      // Never turn a bad row into permission to destroy its on-disk generation.
      preserved.push({
        raw: candidate,
        id: preservedId(candidate),
        reason: `Invalid extension install record: ${result.error.issues[0]?.message ?? 'unknown'}.`,
      })
      continue
    }
    // The ABI gate, applied at LOAD and not only at install. The schema accepts
    // any positive apiVersion (it is shared with the install path, which wants
    // to report a mismatch with a better message than a field error), so a row
    // written under a host that implemented v1 would otherwise keep loading
    // against a host that implements v2. Version skew arrives by UPGRADING
    // AGENT CODE, which involves no install — so an install-time-only check can
    // never see it.
    //
    // Quarantined rather than fatal (#959): a rollback past a future api
    // version is precisely the case where the row is still CORRECT and this
    // build is the temporary one. Setting it aside keeps the other extensions
    // running and keeps the row for the build that can use it.
    const mismatch = apiVersionMismatch(result.data.manifest.apiVersion)
    if (mismatch) {
      preserved.push({
        raw: candidate,
        id: result.data.manifest.id,
        reason: `${result.data.manifest.id}: ${mismatch}.`,
      })
      continue
    }
    // Migrate a pre-`origin` row by the one field that actually distinguishes the
    // two installers: `ref`. The local installer writes the literal 'local' there
    // (it has no git ref to record), and the GitHub installer writes a tag or a
    // branch name. A repository whose branch is literally named `local` would be
    // misread — and would then simply take the Update path it already took before
    // this field existed, so the migration is never worse than not having it.
    rows.push({
      ...result.data,
      origin: result.data.origin ?? (result.data.ref === 'local' ? 'local' : 'github'),
    })
  }
  return { rows, preserved }
}

/** The rows this build can actually run. Preserved rows are invisible here by
 *  design: discovery, activation and capability checks must never see one. */
export async function readLedger(): Promise<InstalledExtension[]> {
  return (await readLedgerContents()).rows
}

/**
 * Serialises every read-modify-write of the ledger.
 *
 * ── WHY temp+rename IS NOT ENOUGH ──
 * `writeLedger` renames a temp file into place, which makes a write ATOMIC — an
 * interrupted write leaves the previous ledger, never a truncated one. It does
 * nothing about a LOST UPDATE, and the two were being conflated.
 *
 * Both `finalizeInstall` and `removeExtension` do read → mutate → write with no
 * lock between them, so: two concurrent installs of different extensions both read
 * `[]`, both write a one-row ledger, and the first extension's row is gone while
 * its bundle sits on disk with nothing referencing it. An install racing a remove
 * of the same id resurrects the extension the user just uninstalled — with a stale
 * grant, because revokeGrant ran before the reinstall wrote a new row.
 *
 * A single module-scope chain is the right size for this: ledger writes are rare,
 * they are all in main, and the contention window is a few milliseconds. A file
 * lock would additionally guard a second Agent Code process, which the app's
 * single-instance lock already prevents.
 */
let ledgerQueue: Promise<unknown> = Promise.resolve()
const publicationListeners = new Set<(rows: InstalledExtension[]) => void>()

/** Main's window bridge subscribes once. Metadata changes must reach every
 *  window, including windows with a live frame and no Settings panel open. */
export function onExtensionPublication(listener: (rows: InstalledExtension[]) => void): () => void {
  publicationListeners.add(listener)
  return () => { publicationListeners.delete(listener) }
}

export function withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
  // `.then(op, op)` rather than `.then(op)`: a previous operation's REJECTION must
  // not skip this one. The failure still reaches its own caller through the promise
  // returned here; it just does not poison the queue.
  const next = ledgerQueue.then(operation, operation)
  ledgerQueue = next.catch(() => {})
  return next
}

/**
 * Commit `rows` as the runnable ledger, carrying every preserved row through.
 *
 * ── WHY THE PRESERVED ROWS ARE RE-READ HERE INSTEAD OF PASSED IN ──
 * They are invisible to every caller: `readLedger` deliberately hides them, so
 * `finalizeInstall` and `removeExtension` both do read → mutate → write over
 * the runnable rows ALONE. If carrying them were the caller's job, forgetting
 * would silently delete a row this build could not read — the one row we have
 * the least right to destroy. Re-reading makes losing one impossible rather
 * than merely unlikely, and every caller already holds the ledger lock, so the
 * extra read sees exactly the file this write is about to replace.
 *
 * `dropPreservedId` is the single deliberate exception: uninstalling a
 * quarantined extension. It is an id, never a row, so a caller cannot ask for
 * anything except "the preserved row that calls itself this".
 */
export async function writeLedger(
  rows: InstalledExtension[],
  options?: { dropPreservedId?: string },
): Promise<void> {
  // A ledger that cannot be READ must not be overwritten: that is how bundles
  // get orphaned. readLedgerContents throws for unparseable JSON, and letting
  // that throw propagate is the correct outcome for every caller.
  const preserved = (await readLedgerContents()).preserved
    .filter(row => options?.dropPreservedId === undefined || row.id !== options.dropPreservedId)
    .map(row => row.raw)

  await mkdir(STATE_DIR, { recursive: true })
  // temp+rename in the same directory, matching workspace.json: an interrupted
  // write must leave the previous ledger intact rather than a truncated file that
  // reads as "nothing installed" and orphans every bundle on disk.
  const tmp = `${EXTENSIONS_LOCKFILE}.tmp-${randomUUID()}`
  try {
    // Preserved rows go LAST so the runnable ledger stays in its own order and
    // a quarantined row cannot change the meaning of the rows before it.
    await writeFile(tmp, `${JSON.stringify([...rows, ...preserved], null, 2)}\n`, 'utf8')
    await rename(tmp, EXTENSIONS_LOCKFILE)
    // The rename already committed. A closed window's send failure must never
    // turn this into a reported install failure or delete the published bundle.
    for (const listener of publicationListeners) {
      try { listener(rows) } catch (error) { console.warn('[extensions] publication listener failed:', error) }
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * The ledger, annotated with whether each bundle is actually on disk and loadable.
 *
 * `present: false` is surfaced rather than filtered because the two states need
 * different user actions: a missing bundle is reinstallable from the recorded repo,
 * whereas silently hiding the row would leave the user wondering where their
 * extension went.
 */
export async function listQuarantinedExtensions(): Promise<QuarantinedExtensionEntry[]> {
  return withLedgerLock(async () => {
    // The manifest is deliberately NOT carried across: the row failed
    // validation, so none of its fields may be shown as a name or a version.
    // The id survives only because it passed `isValidExtensionId` on its own.
    const { preserved } = await readLedgerContents()
    return preserved.map(row => ({ id: row.id, reason: row.reason }))
  })
}

export async function listInstalledExtensions(): Promise<ExtensionListEntry[]> {
  return withLedgerLock(async () => {
    const rows = await readLedger()
    return Promise.all(
      rows.map(async row => {
        let present = false
        try {
          await access(join(extensionBundleDirectory(row), row.manifest.entry))
          present = true
        } catch {
          present = false
        }
        return { ...row, present }
      }),
    )
  })
}

/**
 * Remove an extension's bundle and ledger row.
 *
 * Deliberately does NOT delete the extension's state under EXTENSION_STATE_DIR.
 * Uninstall-then-reinstall is a normal troubleshooting move, and silently
 * destroying saved data as a side effect of it would be hostile. Orphaned state is
 * a few KB of JSON; lost state is the user's data.
 */
export async function removeExtension(id: string): Promise<void> {
  // VALIDATE BEFORE THE RECURSIVE DELETE. `id` arrives from IPC, and this is a
  // `rm(..., { recursive: true })` — a value like `../../something` would escape
  // EXTENSIONS_DIR entirely and delete an unrelated tree. Every other path-handling
  // site in this subsystem validates; this one did not, which is the whole reason the
  // shared validator now exists rather than a fifth copy of the regex.
  if (!isValidExtensionId(id)) throw new Error(`invalid extension id: ${id}`)

  // Removing the row revokes authority and discovery in the same commit. A
  // failed file deletion after that point is garbage collection, not a failed
  // uninstall: reporting failure would encourage retrying an already-removed
  // extension. Saved extension state lives elsewhere and is never touched.
  //
  // ── THIS TOUCHES ONLY RUNNABLE ROWS (review finding 1) ──
  // An earlier version also dropped a PRESERVED row with the same id, because
  // it computed the two independently and let both act. A ledger can hold both
  // — a rollback writes a preserved row beside an id this build still runs —
  // and a single Remove then did both things in both directions: clearing the
  // set-aside row uninstalled the working extension and deleted its bundle,
  // and uninstalling the working extension silently destroyed the row we have
  // the least right to destroy. Ambiguity between two different objects is not
  // resolvable by a precedence rule, so the two are separate operations:
  // `removeQuarantinedExtension` is the other one.
  await withLedgerLock(async () => {
    const rows = await readLedger()
    const previous = rows.find(row => row.manifest.id === id)
    // Credentials go FIRST, unlike saved state (kept on purpose, above): a
    // crash after this line leaves an installed extension that has to ask for
    // its key again, never an uninstalled id whose key a later install from
    // another source could inherit. finalizeInstall also clears stale secrets
    // on any first install, so an interrupted removal cannot leak either way.
    if (previous) await removeExtensionSecrets(id)
    await writeLedger(rows.filter(row => row.manifest.id !== id))
    if (previous) await discardExtensionBundle(previous)
  })
}

/**
 * Drop a PRESERVED row, and nothing else.
 *
 * This is the in-app recovery path #959 exists for: a user can clear a row this
 * build cannot run instead of editing JSON in `~/.config`. It never removes a
 * runnable row and never deletes a bundle — the path would have to be built
 * from fields that failed validation, and once the row is gone the sweep stops
 * protecting the id and collects the directory on its own.
 */
export async function removeQuarantinedExtension(id: string): Promise<void> {
  if (!isValidExtensionId(id)) throw new Error(`invalid extension id: ${id}`)
  await withLedgerLock(async () => {
    const { rows, preserved } = await readLedgerContents()
    if (!preserved.some(row => row.id === id)) return
    // A preserved row may share its id with a WORKING installation (rollback).
    // Its secrets are that working extension's secrets then: keep them. With
    // no runnable row left, the credentials belong to nothing and go.
    if (!rows.some(row => row.manifest.id === id)) await removeExtensionSecrets(id)
    await writeLedger(rows, { dropPreservedId: id })
  })
}

/**
 * The extension ids that PRESERVED rows claim (#959).
 *
 * ── WHY IDS AND NOT PATHS (review finding 3) ──
 * The first version returned exact bundle directories, built from the raw
 * row's `installation.id`. That protected nothing in the one case the feature
 * exists for: a future build that RESHAPES `installation` — renames it, nests
 * it, adds a layout — writes rows this build both rejects AND cannot locate,
 * so the sweep deleted the newer build's bundles on the first launch after a
 * rollback. Protection that depends on parsing the very field that failed to
 * parse is protection that evaporates exactly when it is needed.
 *
 * An id is different: it is validated independently by `isValidExtensionId`,
 * and it is the ONE level of the `.bundles/<id>/<generation>` layout the sweep
 * itself walks. Protecting the whole `<id>` subtree needs no guess about what a
 * future generation looks like. (The earlier flat `EXTENSIONS_DIR/<id>` path
 * was dead weight besides: the sweep never considers that level, so it could
 * not have protected anything.)
 *
 * ── WHAT THIS COSTS ──
 * If an id is both preserved and runnable, that extension's SUPERSEDED
 * generations stop being collected until the preserved row is removed. That is
 * a stale directory, against deleting code a rolled-forward build still needs.
 * The trade is deliberate and one-directional.
 *
 * ── THE LIMIT, STATED ──
 * A row whose id does not validate protects NOTHING: we cannot name a
 * directory we have no trustworthy name for, and guessing is how the sweep
 * would delete an unrelated tree. Such a row survives in the ledger while its
 * bundle is collected. Settings says so rather than offering a button that
 * cannot work.
 */
export function preservedBundleExtensionIds(preserved: readonly PreservedLedgerRow[]): Set<string> {
  const ids = new Set<string>()
  for (const row of preserved) if (row.id !== null) ids.add(row.id)
  return ids
}

/** Construct paths only from validated ledger fields, never a caller's path. */
export function extensionBundleDirectory(row: InstalledExtension): string {
  return row.installation
    ? join(EXTENSIONS_DIR, '.bundles', row.manifest.id, row.installation.id)
    : join(EXTENSIONS_DIR, row.manifest.id)
}

/** Call only after a ledger commit has made this generation unreachable. */
export async function discardExtensionBundle(row: InstalledExtension): Promise<void> {
  await rm(extensionBundleDirectory(row), { recursive: true, force: true }).catch(error => {
    console.warn(`[extensions] could not reclaim ${row.manifest.id} bundle:`, error)
  })
}
