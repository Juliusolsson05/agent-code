import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// WHY node:sqlite and not a native dependency: Electron 43 bundles Node
// 24.18, where `node:sqlite` is built in (still flagged experimental, which
// prints one warning per process). better-sqlite3 would add a second native
// rebuild next to node-pty for a read-only use. The experimental flag is the
// accepted trade; the adapters degrade to a scan if the module ever breaks.
//
// WHY a column probe: Codex versions its index file (`state_5.sqlite` today)
// and adds columns between releases. A query against a column that does not
// exist throws at prepare time; probing first turns a schema bump into a
// reported downgrade instead of an empty picker.

export type SqliteOpen =
  | { ok: true; db: DatabaseSync; close(): void }
  | { ok: false; reason: string }

export function openReadOnlySqlite(
  path: string,
  required: Record<string, string[]>,
): SqliteOpen {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return { ok: false, reason: `cannot open ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    for (const [table, columns] of Object.entries(required)) {
      const present = new Set(
        (db.prepare(`pragma table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name),
      )
      if (present.size === 0) {
        db.close()
        return { ok: false, reason: `table ${table} is missing in ${path}` }
      }
      const missing = columns.filter(c => !present.has(c))
      if (missing.length > 0) {
        db.close()
        return { ok: false, reason: `table ${table} in ${path} lacks columns ${missing.join(', ')}` }
      }
    }
  } catch (error) {
    db.close()
    return { ok: false, reason: `cannot probe ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, db, close: () => db.close() }
}

/** Codex names its index `state_<N>.sqlite` and bumps N on schema changes;
 *  the highest N is the live one. Null when no index exists yet. */
export function newestCodexStateDb(codexHome: string): string | null {
  let names: string[]
  try {
    names = readdirSync(codexHome).filter(n => /^state_\d+\.sqlite$/.test(n))
  } catch {
    return null
  }
  names.sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))
  return names[0] ? join(codexHome, names[0]) : null
}
