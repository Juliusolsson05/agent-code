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
  // Defaulted rather than required: a row written before this field existed came
  // from the GitHub installer, because that was the only installer that wrote a
  // ledger row at the time. Defaulting is the accurate migration, and it keeps an
  // upgrade from dropping every installed extension.
  origin: z.enum(['github', 'local']).default('github'),
  repo: z.string().min(1),
  ref: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Optional: rows written before the bundle hash existed simply lack it, and
  // dropping those rows would uninstall working extensions to add a field.
  // grantedCapabilities fails closed on a missing hash, so the cost of an old
  // row is re-consent, not a silently retained grant.
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
      rows.push(result.data)
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
  await rm(join(EXTENSIONS_DIR, id), { recursive: true, force: true })
  const ledger = await readLedger()
  await writeLedger(ledger.filter(row => row.manifest.id !== id))
}
