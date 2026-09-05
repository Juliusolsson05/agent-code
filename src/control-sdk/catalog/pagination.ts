import { z } from 'zod'
import { ControlError } from '../contracts'

export const pageInput = {
  cursor: z.string().optional().describe('Opaque nextCursor from the previous page. Keep the same filters and window; restart without it if the reference changed.'), limit: z.number().int().min(1).max(200).default(40).describe('Maximum entries per page. Continue with nextCursor until complete is true.'),
}
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: z.number().int(), revision: z.string(), nextCursor: z.string().nullable(), complete: z.boolean() })
}

// This is an accidental-change fingerprint, not an authorization token. A
// portable 64-bit FNV revision keeps the neutral SDK free of Node/browser crypto
// dependencies. Scope includes the query, so a cursor cannot silently continue
// a differently filtered list. Callers may page all records; none are sampled.
function revisionOf(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 14695981039346656037n
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  return hash.toString(16).padStart(16, '0')
}

export function paginate<T>(items: readonly T[], input: { cursor?: string; limit: number }, scope: string) {
  const revision = revisionOf([scope, items])
  let offset = 0
  if (input.cursor) {
    const match = /^([a-f0-9]{16})\.(\d+)$/.exec(input.cursor)
    if (!match) throw new ControlError('invalid_cursor', 'Use the nextCursor from the preceding page')
    if (match[1] !== revision) throw new ControlError('stale_cursor', 'The reference changed; restart without a cursor')
    offset = Number(match[2])
    if (!Number.isSafeInteger(offset) || offset > items.length) throw new ControlError('invalid_cursor', 'Cursor is outside this reference')
  }
  const end = Math.min(offset + input.limit, items.length)
  return { items: items.slice(offset, end), total: items.length, revision, nextCursor: end < items.length ? `${revision}.${end}` : null, complete: end === items.length }
}
