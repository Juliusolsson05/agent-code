import { createRequire } from 'node:module'

// The app's Node type package predates node:sqlite, while deterministic system
// tests run on Node 24. Keep a narrow description of the built-in writer here:
// importing the headless package's private SQLite loader would couple host
// tests to its internals, and production readers must stay read-only.
export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...params: Array<string | number | null>): unknown }
    close(): void
  }
}
