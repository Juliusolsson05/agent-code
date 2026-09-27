import { Storage } from 'happy-dom'

/**
 * Put a working DOM Storage on `target` wherever the existing one is not a
 * Storage (#1212).
 *
 * WHY: Node 25 ships Web Storage on by default. Without `--localstorage-file`
 * its `globalThis.localStorage` is a half-initialised object (no `clear`,
 * reads return undefined, plus the warning "`--localstorage-file` was provided
 * without a valid path"). Because the global already exists, Vitest's
 * happy-dom environment does not replace it, so renderer code and tests talk
 * to Node's broken storage instead of the DOM's. On Node 22/24, happy-dom's
 * storage is already in place and this changes nothing.
 *
 * "Working" means happy-dom's own Storage (review c of #1408). A check for
 * `clear` accepted Node 25's FILE-backed storage too: with
 * `--localstorage-file` (on the command line or in NODE_OPTIONS) Node's
 * storage is complete, so it stayed in place and a test read values another
 * process had written to that file instead of the DOM's fresh, empty
 * storage. Anything that is not a happy-dom Storage is replaced.
 */
export function installWorkingStorage(target: object): Array<'localStorage' | 'sessionStorage'> {
  const replaced: Array<'localStorage' | 'sessionStorage'> = []
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if ((target as Record<string, unknown>)[name] instanceof Storage) continue
    Object.defineProperty(target, name, { configurable: true, writable: true, value: new Storage() })
    replaced.push(name)
  }
  return replaced
}
