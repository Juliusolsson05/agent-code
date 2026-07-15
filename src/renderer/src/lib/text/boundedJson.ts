const DEFAULT_MAX_CHARS = 16 * 1024
const MAX_DEPTH = 5
const MAX_CONTAINER_ENTRIES = 40
const MAX_VISITED_VALUES = 160
const MAX_STRING_CHARS = 512

type ProjectionBudget = {
  visited: number
  seen: WeakSet<object>
}

function clampString(value: string): string {
  return value.length > MAX_STRING_CHARS
    ? `${value.slice(0, MAX_STRING_CHARS)}…`
    : value
}

function projectJsonValue(
  value: unknown,
  depth: number,
  budget: ProjectionBudget,
): unknown {
  if (typeof value === 'string') return clampString(value)
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'symbol') return value.toString()
  if (typeof value !== 'object') return String(value)

  if (budget.seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[array truncated]' : '[object truncated]'
  if (budget.visited >= MAX_VISITED_VALUES) return '[preview budget exhausted]'

  budget.seen.add(value)
  budget.visited += 1

  if (Array.isArray(value)) {
    const projected: unknown[] = []
    const limit = Math.min(value.length, MAX_CONTAINER_ENTRIES)
    for (let index = 0; index < limit; index += 1) {
      projected.push(projectJsonValue(value[index], depth + 1, budget))
      if (budget.visited >= MAX_VISITED_VALUES) break
    }
    if (limit < value.length) projected.push(`[${value.length - limit} more items]`)
    return projected
  }

  const projected: Record<string, unknown> = {}
  let admitted = 0

  // WHY `for…in` with an own-property check instead of Object.entries:
  // Object.entries eagerly allocates an array for every property before we can
  // enforce a preview budget. Tool payloads can contain enormous generated
  // maps; this loop stops after a bounded prefix and never materializes the
  // undisplayed key set.
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (admitted >= MAX_CONTAINER_ENTRIES || budget.visited >= MAX_VISITED_VALUES) {
      projected['…'] = '[more properties omitted]'
      break
    }
    projected[clampString(key)] = projectJsonValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
      budget,
    )
    admitted += 1
  }
  return projected
}

/**
 * Serialize a representative JSON prefix without first walking the full value.
 *
 * WHY slicing `JSON.stringify(value)` is not a bound: JSON.stringify has already
 * traversed and allocated the complete multi-megabyte string before `.slice`
 * runs. This projector bounds depth, entries, visited nodes, and scalar length
 * before serialization. It is intentionally a preview, never durable truth.
 */
export function boundedJsonPreview(
  value: unknown,
  maxChars = DEFAULT_MAX_CHARS,
): string | null {
  try {
    const projected = projectJsonValue(value, 0, {
      visited: 0,
      seen: new WeakSet<object>(),
    })
    const json = JSON.stringify(projected, null, 2)
    return json.length > maxChars ? `${json.slice(0, maxChars)}\n…` : json
  } catch {
    return null
  }
}
