import { access, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { z } from 'zod'

import { EXTENSIONS_DIR, EXTENSIONS_LOCKFILE, STATE_DIR } from '@main/storage/paths.js'
import { isValidExtensionId } from '@shared/types/extensionId.js'
import type { ExtensionListEntry, InstalledExtension } from '@shared/types/extensions.js'

import { apiVersionMismatch, extensionManifestSchema } from './manifest.js'

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
// Rows are dropped INDIVIDUALLY, not the whole ledger — one bad hand-edit must
// not orphan every other installed extension.
const installedExtensionSchema = z.object({
  manifest: extensionManifestSchema,
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

export async function readLedger(): Promise<InstalledExtension[]> {
  let raw: string
  try {
    raw = await readFile(EXTENSIONS_LOCKFILE, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const rows: InstalledExtension[] = []
  for (const candidate of parsed) {
    const result = installedExtensionSchema.safeParse(candidate)
    if (result.success) {
      // The ABI gate, applied at LOAD and not only at install. The schema accepts
      // any positive apiVersion (it is shared with the install path, which wants
      // to report a mismatch with a better message than a field error), so a row
      // written under a host that implemented v1 would otherwise keep loading
      // against a host that implements v2. Version skew arrives by UPGRADING
      // AGENT CODE, which involves no install — so an install-time-only check can
      // never see it.
      const mismatch = apiVersionMismatch(result.data.manifest.apiVersion)
      if (mismatch) {
        console.warn(`[extensions] skipping ${result.data.manifest.id}: ${mismatch}`)
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
    } else {
      // Surfaced, not silent: a dropped row means a corrupt/hand-edited ledger,
      // and the message names the field so it is diagnosable rather than an
      // extension mysteriously vanishing from the list.
      console.warn(
        `[extensions] dropping invalid ledger row: ${result.error.issues[0]?.message ?? 'unknown'}`,
      )
    }
  }
  return rows
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

export function withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
  // `.then(op, op)` rather than `.then(op)`: a previous operation's REJECTION must
  // not skip this one. The failure still reaches its own caller through the promise
  // returned here; it just does not poison the queue.
  const next = ledgerQueue.then(operation, operation)
  ledgerQueue = next.catch(() => {})
  return next
}

export async function writeLedger(rows: InstalledExtension[]): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  // temp+rename in the same directory, matching workspace.json: an interrupted
  // write must leave the previous ledger intact rather than a truncated file that
  // reads as "nothing installed" and orphans every bundle on disk.
  const tmp = `${EXTENSIONS_LOCKFILE}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  await rename(tmp, EXTENSIONS_LOCKFILE)
}

/**
 * The ledger, annotated with whether each bundle is actually on disk and loadable.
 *
 * `present: false` is surfaced rather than filtered because the two states need
 * different user actions: a missing bundle is reinstallable from the recorded repo,
 * whereas silently hiding the row would leave the user wondering where their
 * extension went.
 */
export async function listInstalledExtensions(): Promise<ExtensionListEntry[]> {
  const rows = await readLedger()
  return Promise.all(
    rows.map(async row => {
      let present = false
      try {
        await access(join(EXTENSIONS_DIR, row.manifest.id, row.manifest.entry))
        present = true
      } catch {
        present = false
      }
      return { ...row, present }
    }),
  )
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

  // Under the lock as ONE unit, with the ledger row dropped BEFORE the bundle. An
  // interruption between the two then leaves a bundle with no row — which the
  // startup sweep reclaims — rather than a row with no bundle, which the user sees
  // as a broken "files missing" entry they have to fix by hand.
  await withLedgerLock(async () => {
    await writeLedger((await readLedger()).filter(row => row.manifest.id !== id))
    await rm(join(EXTENSIONS_DIR, id), { recursive: true, force: true })
  })
}
