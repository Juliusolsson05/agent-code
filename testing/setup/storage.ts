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
 * "Working" is judged by `clear` being a function: Node 25's placeholder lacks
 * it, and every real Storage has it.
 */
export function installWorkingStorage(target: object): Array<'localStorage' | 'sessionStorage'> {
  const replaced: Array<'localStorage' | 'sessionStorage'> = []
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const current = (target as Record<string, unknown>)[name] as { clear?: unknown } | undefined
    if (typeof current?.clear === 'function') continue
    Object.defineProperty(target, name, { configurable: true, writable: true, value: new Storage() })
    replaced.push(name)
  }
  return replaced
}
