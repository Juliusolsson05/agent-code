import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { UserMcpDocument } from '@shared/userMcp/types.js'
import { coerceUserMcpDocument } from '@shared/userMcp/validate.js'

export type LoadedUserMcpDocument = {
  document: UserMcpDocument
  /** Human-readable notice when the file existed but could not be used. */
  problem?: string
}

/**
 * Read `mcp-servers.json`.
 *
 * WHY a corrupt file is moved aside instead of overwritten or left in place:
 * leaving it would make every later save either fail or clobber it, and
 * silently resetting would erase every server the user configured. Renaming
 * it keeps the bytes recoverable (`mcp-servers.json.corrupt-<time>`) while the
 * app continues with an empty list and says so in Settings.
 */
export async function loadUserMcpDocument(file: string): Promise<LoadedUserMcpDocument> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { document: { version: 1, servers: [] } }
    return {
      document: { version: 1, servers: [] },
      problem: `Could not read ${file}: ${(error as Error).message}`,
    }
  }
  try {
    return { document: coerceUserMcpDocument(JSON.parse(text)) }
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`
    await rename(file, aside).catch(() => {})
    return {
      document: { version: 1, servers: [] },
      problem: `MCP settings were unreadable (${(error as Error).message}) and were moved to ${aside}.`,
    }
  }
}

/** Atomic replace at mode 0600. The document holds no secret values, but it
 * does hold server URLs and commands a user may consider private. */
export async function saveUserMcpDocument(file: string, document: UserMcpDocument): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}
