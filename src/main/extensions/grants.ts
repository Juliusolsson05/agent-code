import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { z } from 'zod'

import { STATE_DIR } from '@main/storage/paths.js'
import type { ExtensionCapability } from '@shared/types/extensions.js'

// The capability grant store (WS5).
//
// A grant records that the user approved a specific set of capabilities for a
// specific extension AT a specific content hash. Keying on the sha256 — not just
// the id — is the load-bearing choice, borrowed from WorkflowSourceApprovalStore:
// an extension can be updated in place (install doubles as update), so a grant that
// keyed on id alone would let an update silently inherit permissions the user
// approved for different code. When the bytes change, the grant no longer matches
// and the capabilities must be re-approved.
//
// Tier-0 capabilities (storage/ui/theme) are NOT recorded here — they are granted
// to every extension without asking, so they never appear in a manifest's
// `permissions` and never reach this store.

const GRANTS_FILE = join(STATE_DIR, 'extension-grants.json')

const grantSchema = z.object({
  extensionId: z.string().min(1),
  /** The exact bytes the grant was given for. A different sha means re-consent. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: z.array(z.string()),
  grantedAt: z.number().finite(),
})

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
  const tmp = `${GRANTS_FILE}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  await rename(tmp, GRANTS_FILE)
}

/**
 * Record the user's approval of `capabilities` for one extension at one content
 * hash. One row per extension id — a re-grant (a new install/update) replaces the
 * previous row, so a downgrade in requested permissions cannot leave stale ones.
 */
export async function recordGrant(
  extensionId: string,
  sha256: string,
  capabilities: readonly ExtensionCapability[],
): Promise<void> {
  const rows = await readGrants()
  await writeGrants([
    ...rows.filter(row => row.extensionId !== extensionId),
    { extensionId, sha256, capabilities: [...capabilities], grantedAt: Date.now() },
  ])
}

/**
 * The capabilities currently granted to an extension, but ONLY if the grant was
 * given for exactly the bytes now installed (`sha256`). A grant for different bytes
 * returns nothing — the capabilities were approved for code that is no longer what
 * is running, so they must not carry over silently.
 */
export async function grantedCapabilities(
  extensionId: string,
  sha256: string,
): Promise<Set<ExtensionCapability>> {
  const rows = await readGrants()
  const row = rows.find(candidate => candidate.extensionId === extensionId)
  if (!row || row.sha256 !== sha256) return new Set()
  return new Set(row.capabilities as ExtensionCapability[])
}

/** Drop an extension's grant. Called on uninstall so a reinstall must re-consent. */
export async function revokeGrant(extensionId: string): Promise<void> {
  const rows = await readGrants()
  const next = rows.filter(row => row.extensionId !== extensionId)
  if (next.length !== rows.length) await writeGrants(next)
}
