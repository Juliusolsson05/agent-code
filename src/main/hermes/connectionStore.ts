// Hermes connections on disk: names and URLs only, no credentials (#1482).
//
// `<stateDir>/hermes/connections.json`, written atomically at mode 0600.
// Same contract as the user-MCP document (src/main/userMcp/store.ts): a
// corrupt file is moved aside (bytes recoverable) instead of being silently
// reset, and a file that exists but cannot be READ blocks writes, because a
// write would replace contents we never saw with an empty list.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isValidSshAccess, type HermesLocation, type HermesSshAccess } from '@shared/hermes/ssh.js'

export type StoredHermesConnection = {
  id: string
  name: string
  baseUrl: string
  createdAt: number
  /** Optional SSH route to the same server (#1528). Never a password or key: a destination, port and key PATH. */
  ssh?: HermesSshAccess
}

export type HermesConnectionsDocument = { version: 1; connections: StoredHermesConnection[] }

export type LoadedHermesConnections = {
  document: HermesConnectionsDocument
  problem?: string
  readFailed?: boolean
}

const EMPTY: HermesConnectionsDocument = { version: 1, connections: [] }

function coerce(raw: unknown): HermesConnectionsDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
  const list = (raw as { connections?: unknown }).connections
  if (!Array.isArray(list)) throw new Error('connections is not a list')
  const connections: StoredHermesConnection[] = []
  for (const entry of list) {
    const record = entry as Record<string, unknown>
    // A malformed row is dropped, not fatal: one hand-edited mistake must not
    // cost the user every other connection.
    if (typeof record?.id !== 'string' || typeof record.name !== 'string' || typeof record.baseUrl !== 'string') continue
    connections.push({
      id: record.id,
      name: record.name,
      baseUrl: record.baseUrl,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      ...(coerceSsh(record.ssh) ? { ssh: coerceSsh(record.ssh)! } : {}),
    })
  }
  return { version: 1, connections }
}

/**
 * A malformed `ssh` block is dropped ALONE: the connection (its URL, its
 * sign-in) is worth more than a hand-edited SSH typo, and the user re-enters
 * SSH access in Settings. Re-validated with the same rules as the form, so a
 * hand-edited `"-oProxyCommand=…"` destination never reaches a command line.
 */
function coerceSsh(raw: unknown): HermesSshAccess | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.destination !== 'string') return null
  const access: HermesSshAccess = { destination: record.destination }
  if (typeof record.port === 'number') access.port = record.port
  if (typeof record.identityFile === 'string') access.identityFile = record.identityFile
  const hermes = coerceLocation(record.hermes)
  if (hermes) access.hermes = hermes
  return isValidSshAccess(access) ? access : null
}

function coerceLocation(raw: unknown): HermesLocation | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (record.kind === 'host') return { kind: 'host' }
  if (record.kind === 'docker' && typeof record.container === 'string') {
    return { kind: 'docker', container: record.container, shell: record.shell === 'sh' ? 'sh' : 'bash', sudo: record.sudo === true }
  }
  return null
}

export async function loadHermesConnections(file: string): Promise<LoadedHermesConnections> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { document: { ...EMPTY, connections: [] } }
    return { document: { ...EMPTY, connections: [] }, problem: `Could not read ${file}: ${(error as Error).message}`, readFailed: true }
  }
  try {
    return { document: coerce(JSON.parse(text)) }
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`
    await rename(file, aside).catch(() => {})
    return {
      document: { ...EMPTY, connections: [] },
      problem: `Hermes connections were unreadable (${(error as Error).message}) and were moved to ${aside}.`,
    }
  }
}

export async function saveHermesConnections(file: string, document: HermesConnectionsDocument): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}
