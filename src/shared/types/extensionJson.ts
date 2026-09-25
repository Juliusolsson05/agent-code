export type ExtensionJson = null | boolean | number | string | ExtensionJson[] | { [key: string]: ExtensionJson }

// Validate size/depth before a recursive schema or JSON.stringify touches an
// extension's data. IPC has already cloned it, but an iterative walk avoids a
// second unbounded allocation or a main-process stack overflow. Repeated object
// references count repeatedly, just as JSON serialization would; cycles fail the
// depth bound without needing a recursive cycle detector.
export const EXTENSION_JSON_MAX_CHARACTERS = 128 * 1024

/** `maxCharacters` exists for ONE caller: the runtime channel's net.fetch
 *  result, whose body is already capped by the broker (see runtimeService).
 *  Every other boundary uses the default; do not raise it for convenience. */
export function isExtensionJson(value: unknown, maxCharacters = EXTENSION_JSON_MAX_CHARACTERS): value is ExtensionJson {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  let characters = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 4096 || item.depth > 32) return false
    const current = item.value
    if (typeof current === 'string') characters += current.length
    else if (typeof current === 'number') { if (!Number.isFinite(current)) return false }
    else if (current !== null && typeof current !== 'boolean') {
      if (typeof current !== 'object') return false
      if (Array.isArray(current)) {
        if (current.length + nodes + pending.length > 4096) return false
        for (const child of current) pending.push({ value: child, depth: item.depth + 1 })
      } else {
        const prototype = Object.getPrototypeOf(current)
        if (prototype !== Object.prototype && prototype !== null) return false
        for (const key in current) {
          if (!Object.prototype.hasOwnProperty.call(current, key)) continue
          characters += key.length
          if (characters > maxCharacters || nodes + pending.length >= 4096) return false
          pending.push({ value: (current as Record<string, unknown>)[key], depth: item.depth + 1 })
        }
      }
    }
    if (characters > maxCharacters) return false
  }
  return true
}
