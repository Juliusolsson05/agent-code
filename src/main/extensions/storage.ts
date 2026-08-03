import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { EXTENSION_STATE_DIR } from '@main/storage/paths.js'

// Per-app JSON state, main-owned.
//
// One file per app (`extensions/<id>/state.json`) rather than one shared file
// keyed by app id: uninstalling an app becomes `rm -rf` of one directory, a
// corrupt write can only lose one app's data, and two apps writing concurrently
// never contend for the same file.

// WHY ids are validated and rejected rather than sanitized: an app id becomes a
// directory name, so a permissive id is a path-traversal primitive. Sanitizing —
// stripping or replacing bad characters — silently collapses distinct ids onto the
// same directory: `../timer` and `timer` would share state, and `a/b` and `a-b`
// would too. Rejecting is the only handling where the failure is visible to whoever
// caused it. The pattern is duplicated in the renderer's AppDefinition doc comment;
// if it changes, change both.
const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export class InvalidAppIdError extends Error {
  constructor(appId: unknown) {
    super(
      `invalid extension app id ${JSON.stringify(appId)} — must match ${String(APP_ID_PATTERN)}`,
    )
    this.name = 'InvalidAppIdError'
  }
}

function appDirFor(appId: string): string {
  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) throw new InvalidAppIdError(appId)
  return join(EXTENSION_STATE_DIR, appId)
}

function stateFileFor(appId: string): string {
  return join(appDirFor(appId), 'state.json')
}

async function readAll(appId: string): Promise<Record<string, unknown>> {
  const file = stateFileFor(appId)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    // Missing file is the normal first-run case, not an error.
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    // A corrupt or non-object file degrades to empty rather than throwing. An app
    // losing saved state is recoverable and visible; an app that throws on every
    // read can never start again, and the user has no way to clear it from the UI.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

async function writeAll(appId: string, data: Record<string, unknown>): Promise<void> {
  const dir = appDirFor(appId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.json')
  // temp+rename, matching workspace.json's discipline: rename is atomic within a
  // filesystem, so a crash mid-write leaves either the old file or the new one —
  // never a half-written one that then fails to parse forever. The temp file lives
  // in the same directory precisely so the rename cannot cross a device boundary.
  //
  // The temp name is UNIQUE per write. An earlier version used a fixed
  // `${file}.tmp`, which review reproduced as a hard failure 3/3: two concurrent
  // writers both create the same temp path, the first rename consumes it, and the
  // second rename fails ENOENT — losing one write AND rejecting. Uniqueness alone
  // still permits a lost update (both read the old state), which is why every write
  // for an app also goes through the serialization queue below.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${writeCounter++}`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

let writeCounter = 0

// One promise chain per app id, so read-modify-write cycles for the same app never
// interleave.
//
// WHY this is necessary and not paranoia: the ABI makes every storage method
// async, which invites exactly the fire-and-forget shape that breaks a naive
// implementation — `void api.storage.set('a', 1); void api.storage.set('b', 2)` from
// one click handler. Without serialization both calls read the same original state
// and the second write erases the first key. Chaining makes that sequence correct
// without the extension author having to know it needed awaiting.
//
// WHY a Map keyed by app rather than one global chain: two different extensions
// write to different files and have no reason to block each other. The map grows by
// one small entry per app that ever writes, bounded by the number of installed
// extensions.
const writeQueues = new Map<string, Promise<void>>()

function enqueueWrite(appId: string, mutate: () => Promise<void>): Promise<void> {
  // Validate BEFORE joining the queue so a bad id rejects immediately instead of
  // waiting behind unrelated work — and so an invalid id never creates a queue entry.
  appDirFor(appId)

  const previous = writeQueues.get(appId) ?? Promise.resolve()
  // `.catch(() => {})` on the tail: one failed write must not poison every
  // subsequent write for that app. The failure still propagates to ITS caller
  // through the returned promise; this only stops it propagating to the next one.
  const next = previous.catch(() => {}).then(mutate)
  writeQueues.set(
    appId,
    next.catch(() => {}),
  )
  return next
}

export async function extensionStorageGet(appId: string, key: string): Promise<unknown> {
  return (await readAll(appId))[key]
}

export class NonSerializableValueError extends Error {
  constructor(detail: string) {
    super(`extension storage value is not JSON-serializable: ${detail}`)
    this.name = 'NonSerializableValueError'
  }
}

// WHY non-finite numbers are rejected rather than stored: the ABI types values
// as JsonValue, whose `number` member is unrestricted, so TypeScript happily
// accepts NaN and ±Infinity — but JSON.stringify turns all three into `null`.
// An extension writing NaN and reading back null is a silent data corruption
// with no error anywhere, and the author has no way to discover it except by
// noticing wrong behaviour much later. Rejecting at the boundary converts a
// silent corruption into an immediate, attributable failure.
//
// Checked here rather than in the renderer because this is the last point where
// the value is still structured; after JSON.stringify the information is gone.
function assertSerializable(value: unknown, path = 'value'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new NonSerializableValueError(`${path} is ${String(value)}`)
    }
    return
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSerializable(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    assertSerializable(entry, `${path}.${key}`)
  }
}

export async function extensionStorageSet(
  appId: string,
  key: string,
  value: unknown,
): Promise<void> {
  assertSerializable(value)
  return enqueueWrite(appId, async () => {
    const data = await readAll(appId)
    data[key] = value
    await writeAll(appId, data)
  })
}

export async function extensionStorageDelete(appId: string, key: string): Promise<void> {
  return enqueueWrite(appId, async () => {
    const data = await readAll(appId)
    delete data[key]
    await writeAll(appId, data)
  })
}

export async function extensionStorageKeys(appId: string): Promise<string[]> {
  return Object.keys(await readAll(appId))
}
