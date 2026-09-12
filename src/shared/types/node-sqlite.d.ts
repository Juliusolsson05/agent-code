// Minimal ambient typing for Node's built-in `node:sqlite`.
//
// WHY this exists: the app runs on Electron 43, which bundles Node 24.18 where
// `node:sqlite` is built in, but `@types/node` is pinned to the 20.x line and
// has no declaration for it. Bumping the types major would touch every file
// that relies on Node 20 typings for an unrelated reason; a read-only sqlite
// consumer needs four methods. This declares exactly what
// src/main/conversations and scripts/extract-conversation-corpus.mts use and
// nothing more, so a wider API is a deliberate edit here, not an accident.
//
// Source of truth for the shapes: https://nodejs.org/api/sqlite.html (Node 24).
declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | Uint8Array
  export type SQLOutputValue = null | number | bigint | string | Uint8Array

  export interface StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[]
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }

  export interface DatabaseSyncOptions {
    open?: boolean
    readOnly?: boolean
    enableForeignKeyConstraints?: boolean
    enableDoubleQuotedStringLiterals?: boolean
    timeout?: number
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions)
    prepare(sql: string): StatementSync
    exec(sql: string): void
    close(): void
    isOpen: boolean
  }
}
