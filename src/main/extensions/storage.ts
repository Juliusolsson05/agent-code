import { mkdir, open, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { EXTENSION_STATE_DIR } from '@main/storage/paths.js'

import { isExtensionJson, type ExtensionJson } from '@shared/types/extensionJson.js'

// Durable state is independent of disposable bundles. Uninstall deliberately
// retains it: reinstalling an extension must not erase a user's work. All callers
// (views, runtimes and Settings) meet the same validation and admission boundary.
const MAX_STATE_BYTES = 1024 * 1024
const MAX_STATE_KEYS = 256
const MAX_PENDING_PER_APP = 32
const MAX_PENDING_TOTAL = 256

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

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 256 &&
    !['__proto__', 'constructor', 'prototype'].includes(key)
}

function assertKey(key: unknown): asserts key is string {
  if (!validKey(key)) throw new Error('Invalid extension storage key.')
}

function stateLimit(): Error {
  return new Error('Extension storage limit exceeded (1 MiB, 256 keys). Existing data is unchanged.')
}

async function readAll(appId: string): Promise<Record<string, ExtensionJson>> {
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(stateFileFor(appId), 'r') }
  catch (error) {
    // Only absence is an empty namespace. Treating a permission failure or corrupt
    // file as {} let the next innocent set() erase every saved key. Surface a
    // recoverable error and preserve the bytes for repair, including on delete().
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Extension storage could not be read; saved data was preserved.', { cause: error })
  }
  let raw: string
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Extension storage is not a regular file.')
    if (stat.size > MAX_STATE_BYTES) throw stateLimit()
    // A pre-read stat alone does not bound allocation if a file grows afterward.
    // Read bounded chunks through one open handle and inspect one overflow byte;
    // never readFile() an untrusted or accidentally enormous saved-state file.
    const chunks: Buffer[] = []
    let bytes = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, MAX_STATE_BYTES + 1 - bytes), null)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
      if (bytes > MAX_STATE_BYTES) throw stateLimit()
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)))
    }
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)) }
    catch (error) {
      // Buffer.toString replaces damaged UTF-8 silently. A later write would
      // persist that replacement, destroying the original bytes needed to repair.
      throw new Error('Extension storage contains invalid UTF-8; saved data was preserved.', { cause: error })
    }
  } finally { await file.close() }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (error) { throw new Error('Extension storage contains invalid JSON; saved data was preserved.', { cause: error }) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Extension storage must contain an object; saved data was preserved.')
  }
  const entries = Object.entries(parsed)
  if (entries.length > MAX_STATE_KEYS) throw stateLimit()
  if (entries.some(([key, value]) => !validKey(key) || !isExtensionJson(value))) {
    throw new Error('Extension storage contains invalid keys or bounded JSON values; saved data was preserved.')
  }
  return parsed as Record<string, ExtensionJson>
}

async function writeAll(appId: string, data: Record<string, ExtensionJson>): Promise<void> {
  if (Object.keys(data).length > MAX_STATE_KEYS) throw stateLimit()
  const encoded = `${JSON.stringify(data, null, 2)}\n`
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) throw stateLimit()
  const dir = appDirFor(appId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.json')
  // Same-directory rename publishes either the previous complete snapshot or the
  // new one. A failed write/rename must remove only its own staging file; leaving
  // one per failed request lets a full disk failure consume still more space.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${writeCounter++}`
  try {
    await writeFile(tmp, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, file)
  } finally { await rm(tmp, { force: true }) }
}

let writeCounter = 0
type Queue = { tail: Promise<void>; pending: number }
const queues = new Map<string, Queue>()
let pendingTotal = 0

function enqueue<T>(appId: string, operation: () => Promise<T>): Promise<T> {
  appDirFor(appId)
  const queue = queues.get(appId) ?? { tail: Promise.resolve(), pending: 0 }
  if (queue.pending >= MAX_PENDING_PER_APP || pendingTotal >= MAX_PENDING_TOTAL) {
    return Promise.reject(new Error('Extension storage has too many pending operations.'))
  }
  queues.set(appId, queue)
  queue.pending++
  pendingTotal++
  // Reads share the queue so a get issued after set observes that write even when
  // the caller did not await set first. Bounded admission protects legacy views as
  // well as managed runtimes, and completed namespaces do not stay in a lifetime
  // map merely because that extension wrote a value once before being removed.
  const next = queue.tail.then(operation)
  const finish = () => {
    queue.pending--
    pendingTotal--
    if (queue.pending === 0 && queues.get(appId) === queue) queues.delete(appId)
  }
  // Both outcomes resolve the private tail; one failed operation must not poison
  // later calls. The original promise retains its error for its own caller.
  queue.tail = next.then(finish, finish)
  return next
}

export async function extensionStorageGet(appId: string, key: string): Promise<unknown> {
  assertKey(key)
  return enqueue(appId, async () => {
    const data = await readAll(appId)
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined
  })
}

export class NonSerializableValueError extends Error {
  constructor(detail: string) {
    super(`extension storage value is not bounded JSON: ${detail}`)
    this.name = 'NonSerializableValueError'
  }
}

export async function extensionStorageSet(appId: string, key: string, value: unknown): Promise<void> {
  assertKey(key)
  if (!isExtensionJson(value)) throw new NonSerializableValueError('requires finite JSON within transport size/depth limits')
  // Capture before joining the async queue. Keeping a mutable caller reference
  // would let a later change bypass validation or silently change the saved value.
  const snapshot = JSON.parse(JSON.stringify(value)) as ExtensionJson
  return enqueue(appId, async () => {
    const data = await readAll(appId)
    data[key] = snapshot
    await writeAll(appId, data)
  })
}

export async function extensionStorageDelete(appId: string, key: string): Promise<void> {
  assertKey(key)
  return enqueue(appId, async () => {
    const data = await readAll(appId)
    delete data[key]
    await writeAll(appId, data)
  })
}

export async function extensionStorageKeys(appId: string): Promise<string[]> {
  return enqueue(appId, async () => Object.keys(await readAll(appId)))
}
