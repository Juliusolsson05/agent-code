import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'

import { computeBundleHash } from './bundleHash.js'
import { extensionBundleDirectory, readLedger, withLedgerLock } from './ledger.js'
import { join } from 'path'

import { z } from 'zod'

import { STATE_DIR } from '@main/storage/paths.js'
import { EXTENSION_CAPABILITIES } from '@shared/types/extensions.js'
import type { ExtensionCapability } from '@shared/types/extensions.js'
import { extensionRevision } from '@shared/types/extensions.js'

// Legacy grants are retained for installations written before immutable bundle
// generations. New installs publish approval with the bundle identity in the
// ledger, avoiding a second independently committed file. Only the fallback in
// installedExtensionCapabilities reads this store for runtime authorization.
// Both formats compare approval against a digest freshly computed from disk;
// provenance hashes cannot detect changed installed files.

const GRANTS_FILE = join(STATE_DIR, 'extension-grants.json')

const grantSchema = z.object({
  extensionId: z.string().min(1),
  /** computeBundleHash() of the installed bundle at the moment consent was given.
   *  A different hash means the code changed, which means re-consent. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  // ── VALIDATED AGAINST THE IMPLEMENTED SET, NOT `z.array(z.string())` ──
  // The looser shape round-tripped ANY string into a Set that
  // `frameHost.requireGrant` then does `.includes()` against. Two consequences:
  // a grants file naming a capability this build does not implement was carried
  // forward verbatim rather than dropped, and — once the seven unimplemented
  // capabilities were removed from the manifest schema — every grant recorded for
  // them under an older build stayed in the file as a live-looking authorisation
  // for a power that no longer exists. Parsing against the real enum means the
  // store cannot hold a capability the host cannot perform, and the migration
  // away from the removed ones is automatic: unknown entries are dropped on read.
  // Filtered PER ELEMENT, not validated wholesale. `z.array(z.enum(...))` rejects
  // the entire array when any one member is unknown, which would turn "this grant
  // mentions a retired capability" into "this extension has no grant at all" —
  // silently revoking the capabilities the user did approve and still holds.
  capabilities: z
    .array(z.string())
    .transform(values => values.filter(isKnownCapability)),
  grantedAt: z.number().finite(),
})

function isKnownCapability(value: string): value is ExtensionCapability {
  return (EXTENSION_CAPABILITIES as readonly string[]).includes(value)
}

type Grant = z.infer<typeof grantSchema>

async function readGrants(): Promise<Grant[]> {
  let raw: string
  try {
    raw = await readFile(GRANTS_FILE, 'utf8')
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
  const rows: Grant[] = []
  for (const candidate of parsed) {
    const result = grantSchema.safeParse(candidate)
    if (result.success) rows.push(result.data)
  }
  return rows
}

async function writeGrants(rows: Grant[]): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  const tmp = `${GRANTS_FILE}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
    await rename(tmp, GRANTS_FILE)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * Record the user's approval of `capabilities` for one extension at one content
 * hash. One row per extension id — a re-grant (a new install/update) replaces the
 * previous row, so a downgrade in requested permissions cannot leave stale ones.
 */
export async function recordGrant(
  extensionId: string,
  bundleSha256: string,
  capabilities: readonly ExtensionCapability[],
): Promise<void> {
  await withLedgerLock(async () => {
    const rows = await readGrants()
    await writeGrants([
      ...rows.filter(row => row.extensionId !== extensionId),
      { extensionId, sha256: bundleSha256, capabilities: [...capabilities], grantedAt: Date.now() },
    ])
  })
}

/**
 * The capabilities currently granted to an extension, but ONLY if the grant was
 * given for exactly the bytes now installed. A grant for different bytes returns
 * nothing — the capabilities were approved for code that is no longer what is
 * running, so they must not carry over silently.
 *
 * `bundleSha256` MUST be a hash the caller just computed FROM DISK, not one read
 * back out of the ledger. Passing a stored value makes this function compare the
 * install record against itself, which is exactly how the check came to be a
 * tautology in the first place.
 */
export async function grantedCapabilities(
  extensionId: string,
  bundleSha256: string,
): Promise<Set<ExtensionCapability>> {
  const rows = await readGrants()
  const row = rows.find(candidate => candidate.extensionId === extensionId)
  if (!row || row.sha256 !== bundleSha256) return new Set()
  return new Set(row.capabilities)
}

/** Drop legacy approval. New installations carry approval in their ledger row. */
export async function revokeGrant(extensionId: string): Promise<void> {
  await withLedgerLock(async () => {
    const rows = await readGrants()
    const next = rows.filter(row => row.extensionId !== extensionId)
    if (next.length !== rows.length) await writeGrants(next)
  })
}

/**
 * Resolve consent and actual code from one committed installation snapshot.
 * New records publish their manifest permissions and content hash atomically;
 * only old records consult the legacy grants file. Re-hashing remains mandatory:
 * matching two values read from the ledger would authorize hand-modified code.
 */
export async function installedExtensionCapabilities(extensionId: string, expectedRevision?: string): Promise<ExtensionCapability[]> {
  return (await installedExtensionGrant(extensionId, expectedRevision)).capabilities
}

/** What the user approved for the committed installation, bound to verified bytes. */
export type InstalledExtensionGrant = {
  capabilities: ExtensionCapability[]
  /** The manifest's declared `networkOrigins` (net.origins, #1150). Empty
   *  unless the bundle hash verified AND net.origins is in the approved set:
   *  the list is part of what was consented to, so it follows exactly the same
   *  binding as the capabilities. Legacy grant-file rows predate the field. */
  networkOrigins: string[]
}

/**
 * The capability set AND the declared network origins, resolved from one
 * committed ledger snapshot under one lock and one bundle hash. Returning both
 * together is the point: a second lookup for the origins could read a
 * different generation than the one whose capabilities it gates.
 */
export async function installedExtensionGrant(extensionId: string, expectedRevision?: string): Promise<InstalledExtensionGrant> {
  const none: InstalledExtensionGrant = { capabilities: [], networkOrigins: [] }
  return withLedgerLock(async () => {
    const row = (await readLedger()).find(entry => entry.manifest.id === extensionId)
    if (!row) return none
    // A slow frame start may cross an update. Never give that old frame the new
    // generation's approval just because it still has the same extension ID.
    if (expectedRevision !== undefined && extensionRevision(row) !== expectedRevision) return none
    try {
      const actual = await computeBundleHash(extensionBundleDirectory(row))
      if (row.installation) {
        if (actual !== row.installation.bundleSha256) return none
        const capabilities = [...(row.manifest.permissions ?? [])]
        return {
          capabilities,
          networkOrigins: capabilities.includes('net.origins') ? [...(row.manifest.networkOrigins ?? [])] : [],
        }
      }
      return { capabilities: await legacyCapabilities(extensionId, actual, row.sha256), networkOrigins: [] }
    } catch {
      return none
    }
  })
}

async function legacyCapabilities(extensionId: string, actual: string, provenanceSha256: string): Promise<ExtensionCapability[]> {
  const granted = await grantedCapabilities(extensionId, actual)
  if (granted.size > 0) return [...granted]
  // Pre-generation builds bound the grant to the ledger's tarball provenance
  // sha256, never to a whole-bundle hash, so a real legacy grant can never
  // match `actual`. Honour that original binding: it carries over exactly the
  // trust the old build granted, instead of silently denying every capability
  // after upgrade with nothing in Settings explaining why. The next update
  // publishes an `installation` record bound to verified bytes.
  return [...await grantedCapabilities(extensionId, provenanceSha256)]
}
