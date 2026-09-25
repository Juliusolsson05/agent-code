import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

/**
 * Keep a byte-for-byte copy of a state file whose damaged rows are about to
 * be dropped by the next save, at `<prefix>-<digest><extension>`.
 *
 * WHY stores need this at all: the fail-all class (#1245-#1249) is fixed by
 * reading every valid row and setting the damaged ones aside, and every such
 * store rewrites its whole file on the next write. Without a copy taken
 * FIRST, "set aside" silently becomes "deleted".
 *
 * WHY temp + rename and a byte comparison: a crash in a direct write leaves a
 * partial file under the final name, and treating "the name exists" as proof
 * the evidence was safe then lost it (#1257 review A). An existing copy
 * counts only if its bytes are identical; anything else gets a fresh name.
 * Named by digest, so relaunching over the same bytes adds nothing.
 */
export async function preserveInvalidBytes(prefix: string, bytes: string, extension = '.json'): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  let copy = `${prefix}-${digest}${extension}`
  const existing = await readFile(copy, 'utf8').catch(() => null)
  if (existing === bytes) return copy
  if (existing !== null) copy = `${prefix}-${digest}-${randomUUID()}${extension}`
  const temporary = `${copy}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temporary, copy)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return copy
}
