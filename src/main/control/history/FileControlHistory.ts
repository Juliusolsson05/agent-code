import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { ControlError, historyEventSchema, type ControlHistory, type HistoryEvent, type HistoryWrite } from '@control-sdk'

// An event's in-memory shape must be byte-identical to its durable JSON
// shape. Zod preserves explicit-`undefined` optional properties while
// JSON.stringify drops them on disk, so a writer passing `field: undefined`
// would otherwise cache events that later fail every JSON output guard
// until a restart re-loads the clean lines (#975). Load-path events cannot
// contain undefined (JSON.parse never produces it); normalizing here at the
// append boundary closes the hole for every writer at once.
function durable(event: HistoryEvent): HistoryEvent {
  for (const key of Object.keys(event)) {
    if (event[key as keyof HistoryEvent] === undefined) delete event[key as keyof HistoryEvent]
  }
  return event
}

/** What a damaged journal was recovered into (#1240). Reported once per
 *  recovery so the host can record an incident naming the preserved file. */
export type ControlHistoryRecovery = {
  kind: 'torn-tail' | 'damaged-rows'
  /** Byte-for-byte copy of the journal as it was found. */
  quarantinePath: string
  /** Digest to name in recovery-accepted.json to accept its unknown outcomes. */
  sha256: string
  keptRows: number
  damagedLines: number
  blockedPairs: number
  keyedCallsBlocked: boolean
}

type Pair = { caller: string; requestKey: string }
type Guard = { file: string; sha256: string; blockedPairs: Pair[]; keyedCallsBlocked: boolean }
type Analysis = {
  events: HistoryEvent[]
  torn: boolean
  /** Anything beyond a torn tail: bad lines, or a sequence gap/reorder
   *  (which leaves every line valid, so damagedLines alone misses it). */
  damaged: boolean
  damagedLines: number
  blockedPairs: Pair[]
  keyedCallsBlocked: boolean
}

const JOURNAL = 'events.jsonl'
const RECOVERY = 'recovery.json'
const ACCEPTED = 'recovery-accepted.json'
const QUARANTINE = /^events\.quarantined-.+\.jsonl$/
// The rows the executor writes, each stamped with the call's request key (or
// none). Other writers (task `step`s, `transport`) are not keyed consistently.
const EXECUTOR_KINDS = new Set<string>(['received', 'dispatched', 'result', 'duplicate'])
// A malformed recovery.json preserved aside when a new recovery must rewrite
// the marker: its block cannot be read, so it stays a global block of its own.
const INVALID_MARKER = /^recovery\.invalid-.+\.json$/
const recoveryFileSchema = z.object({
  quarantines: z.array(z.object({
    file: z.string().refine(name => QUARANTINE.test(name) || INVALID_MARKER.test(name)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    blockedPairs: z.array(z.object({ caller: z.string(), requestKey: z.string() }).strict()),
    keyedCallsBlocked: z.boolean(),
  }).strict()),
}).strict()

// WHY recovery is shaped around idempotency and not just availability
// (#1240, steering q12/q13). The journal is also the executor's dedupe
// ledger: a keyed retry finds its earlier `received` row and replays the
// stored result or answers `interrupted`, never re-running the effect. The
// old code protected that by refusing to load ANY damaged journal, which
// blocked every control call, reads included, forever. "Move the file aside
// and start fresh" would have fixed availability by deleting the dedupe
// evidence, turning a retried key into a second real effect.
//
// So a damaged journal is classified:
// - TORN TAIL ONLY (a crash mid-append): the verified prefix is complete
//   evidence. The executor awaits a durable `received` before dispatching
//   and a durable `dispatched` before the effect, and appends are serialized,
//   so the torn row is the last write and every earlier row of its call is
//   in the prefix. A torn `received` never dispatched; anything else still
//   has its `received`. Full service resumes.
// - ANY OTHER DAMAGE: every valid row is kept, and new keyed intents are
//   refused wherever the lost rows could have held their key. Only a row that
//   is valid except for an unknown `kind` (a newer build's event after a
//   downgrade) proves its exact (caller, requestKey); everything else, from a
//   missing key field to a corrupted value that still looks like a key,
//   blocks every new keyed intent. Unkeyed calls never consult the ledger for
//   dedupe, so they keep working, and so do reads.
//
// The block's source of truth is the preserved evidence, not a flag that a
// restart or a deleted file could lift: recovery.json records each
// quarantine, and any quarantine file it does not list is re-analyzed on
// load. Only naming the evidence digest in recovery-accepted.json, a
// deliberate acceptance of unknown outcomes, clears it.
//
// This journal deliberately does not use the diagnostic incident recorder:
// diagnostics are bounded and summarized, whereas operation history must keep
// exact prompts/results and survive restarts. Only the process holding the
// application's state-directory lock may write this directory.
export class FileControlHistory implements ControlHistory {
  private loaded?: Promise<HistoryEvent[]>
  private tail: Promise<unknown> = Promise.resolve()
  private guards: Guard[] = []
  constructor(
    private readonly directory: string,
    private readonly options: { onRecovered?: (recovery: ControlHistoryRecovery) => void } = {},
  ) {}

  private load(): Promise<HistoryEvent[]> {
    // A failed load is not cached: the next call re-reads the disk.
    return this.loaded ??= this.open().catch(error => { this.loaded = undefined; throw error })
  }

  private async open(): Promise<HistoryEvent[]> {
    await mkdir(join(this.directory, 'payloads'), { recursive: true, mode: 0o700 })
    let bytes: Buffer | null = null
    try { bytes = await readFile(join(this.directory, JOURNAL)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let events: HistoryEvent[] = []
    if (bytes) {
      const analysis = analyze(bytes.toString('utf8'))
      events = analysis.events
      if (analysis.torn || analysis.damaged) await this.recover(bytes, analysis)
    }
    this.guards = await this.readGuards()
    return events
  }

  private async recover(bytes: Buffer, analysis: Analysis): Promise<void> {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let quarantinePath = join(this.directory, `events.quarantined-${stamp}.jsonl`)
    // 1. Preserve the original bytes first. A copy, not a rename: until the
    //    rewrite below lands, events.jsonl must keep existing, or a crash
    //    here would reopen as an EMPTY ledger and lose every dedupe row.
    try { await copyFile(join(this.directory, JOURNAL), quarantinePath, constants.COPYFILE_EXCL) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      quarantinePath = join(this.directory, `events.quarantined-${stamp}-${randomUUID()}.jsonl`)
      await copyFile(join(this.directory, JOURNAL), quarantinePath, constants.COPYFILE_EXCL)
    }
    await this.syncFile(quarantinePath)
    // 2. Record the block before the ledger changes, so no window exists in
    //    which the rewritten ledger is live without it. A torn tail blocks
    //    nothing but is still recorded, for the audit trail.
    const { records, invalid } = await this.readRecords()
    if (invalid) {
      // Rewriting a marker we could not read would drop whatever it blocked.
      // Keep its bytes as evidence and carry its global block forward.
      const preserved = `recovery.invalid-${stamp}-${randomUUID()}.json`
      await copyFile(join(this.directory, RECOVERY), join(this.directory, preserved), constants.COPYFILE_EXCL)
      await this.syncFile(join(this.directory, preserved))
      records.push({ ...invalid, file: preserved })
    }
    records.push({ file: basename(quarantinePath), sha256, blockedPairs: analysis.blockedPairs, keyedCallsBlocked: analysis.keyedCallsBlocked })
    await this.writeAtomic(join(this.directory, RECOVERY), `${JSON.stringify({ quarantines: records }, null, 2)}\n`)
    // 3. The rewritten ledger: every trusted row, renumbered. Sequences are
    //    process-local paging cursors (history.list snapshots); nothing
    //    durable refers to them.
    analysis.events.forEach((event, index) => { event.sequence = index + 1 })
    await this.writeAtomic(join(this.directory, JOURNAL), analysis.events.map(event => `${JSON.stringify(event)}\n`).join(''))
    this.options.onRecovered?.({
      kind: analysis.damaged ? 'damaged-rows' : 'torn-tail',
      quarantinePath, sha256, keptRows: analysis.events.length, damagedLines: analysis.damagedLines,
      blockedPairs: analysis.blockedPairs.length, keyedCallsBlocked: analysis.keyedCallsBlocked,
    })
  }

  // The marker's own contents, validated. WHY validation and not a type
  // assertion (steering q14): a parseable but malformed record, such as one
  // with a `file` and no flags, would otherwise both hide its quarantine from
  // the rescan and read as "no block". Anything that does not validate is
  // itself treated as a global keyed block, acceptable only by naming the
  // marker's own digest, so a damaged marker can never lift a block.
  private async readRecords(): Promise<{ records: Guard[]; invalid: Guard | null }> {
    let bytes: Buffer
    try { bytes = await readFile(join(this.directory, RECOVERY)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], invalid: null }
      throw error
    }
    let parsed: z.infer<typeof recoveryFileSchema> | null = null
    try { parsed = recoveryFileSchema.parse(JSON.parse(bytes.toString('utf8'))) } catch { parsed = null }
    if (parsed) return { records: parsed.quarantines, invalid: null }
    return { records: [], invalid: { file: RECOVERY, sha256: createHash('sha256').update(bytes).digest('hex'), blockedPairs: [], keyedCallsBlocked: true } }
  }

  // Active guards, minus accepted digests: every validated record, plus a
  // fresh analysis of every quarantine file present (which covers a deleted
  // or unreadable recovery.json). Deleting or shortening the evidence
  // therefore never lifts a recorded block.
  private async readGuards(): Promise<Guard[]> {
    const { records, invalid } = await this.readRecords()
    const guards: Guard[] = invalid ? [invalid] : []
    const present = new Set((await readdir(this.directory)).filter(name => QUARANTINE.test(name) || INVALID_MARKER.test(name)))
    for (const name of present) {
      const bytes = await readFile(join(this.directory, name))
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (INVALID_MARKER.test(name)) { guards.push({ file: name, sha256, blockedPairs: [], keyedCallsBlocked: true }); continue }
      const analysis = analyze(bytes.toString('utf8'))
      guards.push({ file: name, sha256, blockedPairs: analysis.blockedPairs, keyedCallsBlocked: analysis.keyedCallsBlocked })
    }
    // Every record applies, present file or not: re-analysis may ADD blocks
    // but never lift one. A quarantine truncated so its damaged line became
    // a "torn tail" re-analyzes as harmless, and replacing the record with
    // that analysis lifted a block nobody accepted (#1254 review A). The
    // record's own digest is what accepts it.
    guards.push(...records)
    let accepted = new Set<string>()
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, ACCEPTED), 'utf8')) as { accepted?: unknown }
      if (Array.isArray(parsed.accepted)) accepted = new Set(parsed.accepted.filter((id): id is string => typeof id === 'string'))
    } catch { /* absent or unreadable: nothing accepted, the conservative reading */ }
    return guards.filter(guard => (guard.keyedCallsBlocked || guard.blockedPairs.length > 0) && !accepted.has(guard.sha256))
  }

  private refusal(write: HistoryWrite): string | null {
    // Only a NEW keyed intent can be a duplicate of a lost one. A retry whose
    // `received` survived writes `duplicate` instead and is answered from it.
    if (write.kind !== 'received' || write.requestKey === undefined) return null
    const guard = this.guards.find(record => record.keyedCallsBlocked
      || record.blockedPairs.some(pair => pair.caller === write.caller && pair.requestKey === write.requestKey))
    return guard
      ? `Control history was recovered from damage (${guard.file}); a keyed call could repeat an action whose record was lost. `
        + `Reconcile it, then add its sha256 ${guard.sha256} to ${ACCEPTED} to accept the unknown outcomes.`
      : null
  }

  /**
   * Wait for every queued append to finish writing (#943).
   *
   * `append` returns the caller's own promise but installs `this.tail` as the
   * serialization point, so a caller that has its result does NOT mean the
   * file is quiet: later appends from other callers are still chained behind
   * it. Committed shutdown has to await the tail itself, or the process exits
   * with a result recorded in memory and absent from disk.
   *
   * Swallows a failure deliberately: `this.tail` already absorbs rejections
   * (by dropping the cached load), and a write that failed is reported to the caller that
   * issued it. Re-throwing here would turn one caller's failed append into a
   * blocked application exit for everyone.
   */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined)
  }

  async events(): Promise<HistoryEvent[]> {
    await this.tail
    return (await this.load()).map(event => ({ ...event }))
  }

  append(write: HistoryWrite, payload?: unknown): Promise<HistoryEvent> {
    const next = this.tail.then(async () => {
      const events = await this.load()
      const refused = this.refusal(write)
      if (refused) throw new ControlError('history_unavailable', refused)
      const payloadId = payload === undefined ? undefined : await this.putPayload(payload)
      const event = durable(historyEventSchema.parse({ ...write, sequence: events.length + 1,
        ...(payloadId ? { payload: payloadId } : {}) }))
      const file = await open(join(this.directory, 'events.jsonl'), 'a', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(event)}\n`)
        await file.sync()
      } finally { await file.close() }
      // Directory sync makes the first journal entry durable too. A successful
      // file fsync alone does not promise that its newly created name survives.
      await this.syncDirectory(this.directory)
      events.push(event)
      return { ...event }
    })
    // WHY a failure drops the cached load instead of poisoning the process
    // (#1240): after a failed write the disk, not memory, knows what landed
    // (nothing, a torn row, or a whole row whose fsync failed). The next
    // append re-reads it, and a torn row is recovered like any crash. A
    // persistent disk error simply fails again.
    this.tail = next.catch(() => { this.loaded = undefined })
    return next
  }

  private async syncFile(path: string): Promise<void> {
    const file = await open(path, 'r+')
    try { await file.sync() } finally { await file.close() }
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(text); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
      await this.syncDirectory(this.directory)
    } finally { await rm(temporary, { force: true }) }
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid history payload digest')
    return join(this.directory, 'payloads', `${id}.json`)
  }

  private async putPayload(payload: unknown): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
    const id = createHash('sha256').update(bytes).digest('hex')
    const destination = this.path(id)
    try {
      const existing = await readFile(destination)
      if (!existing.equals(bytes)) throw new Error('Control payload digest mismatch')
      return id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await rename(temporary, destination)
      await this.syncDirectory(join(this.directory, 'payloads'))
      return id
    } finally { await rm(temporary, { force: true }) }
  }

  async payload(id: string): Promise<unknown> {
    const bytes = await readFile(this.path(id))
    if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Control payload failed integrity check')
    return JSON.parse(bytes.toString('utf8'))
  }

  async chunk(id: string, offset: number, limit: number) {
    const path = this.path(id)
    const totalBytes = (await stat(path)).size
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes
      || !Number.isSafeInteger(limit) || limit < 4 || limit > 262144) throw new Error('Invalid history payload range')
    const file = await open(path, 'r')
    try {
      // Offsets are bytes, not JS string positions. Read one lookahead byte to
      // avoid splitting a UTF-8 codepoint and reject hand-authored mid-codepoint
      // cursors. Returned continuation offsets always round-trip losslessly.
      const buffer = Buffer.alloc(Math.min(limit + 1, totalBytes - offset))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (bytesRead && (buffer[0] & 0xc0) === 0x80) throw new Error('Offset splits a UTF-8 codepoint')
      let end = Math.min(limit, bytesRead)
      while (end > 0 && end < bytesRead && (buffer[end] & 0xc0) === 0x80) end--
      return { text: buffer.subarray(0, end).toString('utf8'), offset,
        nextOffset: offset + end < totalBytes ? offset + end : null, totalBytes, sha256: id }
    } finally { await file.close() }
  }
}

// Classify a journal's text. See the class comment for why each kind of
// damage maps to the block it does.
function analyze(text: string): Analysis {
  const torn = text.length > 0 && !text.endsWith('\n')
  const complete = torn ? text.slice(0, text.lastIndexOf('\n') + 1) : text
  const events: HistoryEvent[] = []
  const blockedPairs: Pair[] = []
  let damagedLines = 0
  let keyedCallsBlocked = false
  let gap = false
  // Calls with a damaged row whose callId is still readable: their kept
  // sibling rows name the key the damaged row may have lost (review A).
  const damagedCallIds = new Set<string>()
  complete.split('\n').filter(Boolean).forEach((line, index) => {
    let raw: unknown
    try { raw = JSON.parse(line) } catch {
      damagedLines++
      keyedCallsBlocked = true
      return
    }
    const parsed = historyEventSchema.safeParse(raw)
    if (parsed.success) {
      // A gap or reorder means rows are missing, and a missing row could
      // have held any key.
      if (parsed.data.sequence !== index + 1) { gap = true; keyedCallsBlocked = true }
      events.push(parsed.data)
      return
    }
    damagedLines++
    // Exact-pair evidence only when every field but `kind` is proven valid:
    // the downgrade shape. A corrupted key value can still look like a key,
    // so any other schema failure is unknown-key evidence (steering q13).
    // The kind must be PRESENT and a string: a newer build writes a new kind
    // value, never a missing one. A missing or mistyped kind is corruption,
    // and a second corruption in the same row (a truncated key) would then be
    // trusted as an exact pair while the real key dispatched again (#1254
    // review B).
    const record = raw as { kind?: unknown; caller?: unknown; requestKey?: unknown; callId?: unknown }
    const onlyKind = typeof record.kind === 'string'
      && parsed.error.issues.every(issue => issue.path.length === 1 && issue.path[0] === 'kind')
    if (!onlyKind) { keyedCallsBlocked = true; return }
    if (typeof record.callId === 'string') damagedCallIds.add(record.callId)
    if (typeof record.caller === 'string' && typeof record.requestKey === 'string') {
      blockedPairs.push({ caller: record.caller, requestKey: record.requestKey })
    }
  })
  // WHY sibling rows decide too (#1254 review A): the executor stamps every
  // row of a call with the same `requestKey` (or none); all 1,846 calls in
  // the owner's real journal agree. A downgrade-shaped row whose key STRING
  // was corrupted names the wrong pair, while its kept `dispatched`/`result`
  // rows still name the real one, and the real key would then dispatch a
  // second time because the lookup only reads `received` rows. So:
  // - every key a damaged call's kept rows name is blocked too;
  // - a call whose kept rows DISAGREE about the key is damage in its own
  //   right, even when every row is schema-valid (a deleted or rewritten key
  //   on a `received` row), and every key it names is blocked.
  //
  // ONLY executor-stamped kinds are compared (#1254 round 2, both reviewers):
  // the task writer (tasks.ts) appends `step` rows on the same callId with no
  // key, so a healthy keyed `startControlTask` call read as "damage", its
  // rows were dropped, and accepting that digest then let the key run twice.
  // In the owner's journal 660 step rows carry no key; among executor kinds
  // all 1,846 calls agree.
  //
  // And a keyed call must still have its intent row: every executor call
  // begins with a durable `received` (or `duplicate`, for a retry). A keyed
  // call left with only dispatched/result rows lost its intent, possibly
  // rewritten into another valid-looking call, so the lookup cannot find it
  // (0 such calls in the real journal).
  const keysByCall = new Map<string, Set<string | undefined>>()
  const hasIntent = new Set<string>()
  for (const event of events) {
    if (!EXECUTOR_KINDS.has(event.kind)) continue
    const keys = keysByCall.get(event.callId) ?? new Set<string | undefined>()
    keys.add(event.requestKey)
    keysByCall.set(event.callId, keys)
    if (event.kind === 'received' || event.kind === 'duplicate') hasIntent.add(event.callId)
  }
  const inconsistentCallIds = new Set<string>()
  for (const event of events) {
    const keys = keysByCall.get(event.callId)
    const disagrees = (keys?.size ?? 0) > 1
      || (!hasIntent.has(event.callId) && [...(keys ?? [])].some(key => key !== undefined))
    if (disagrees) inconsistentCallIds.add(event.callId)
    if ((disagrees || damagedCallIds.has(event.callId)) && event.requestKey !== undefined
      && !blockedPairs.some(pair => pair.caller === event.caller && pair.requestKey === event.requestKey)) {
      blockedPairs.push({ caller: event.caller, requestKey: event.requestKey })
    }
  }
  // An inconsistent call's rows leave the ACTIVE ledger (steering q17).
  // Rewriting them unchanged could never make the ledger clean, so every
  // launch re-quarantined the same bytes and filed another incident. Their
  // bytes stay in the quarantine copy, and the pairs pushed above, recorded
  // in recovery.json, keep every key they named blocked; the next launch
  // then finds a consistent ledger and the recorded block.
  const kept = inconsistentCallIds.size > 0 ? events.filter(event => !inconsistentCallIds.has(event.callId)) : events
  return {
    events: kept, torn, damaged: damagedLines > 0 || gap || inconsistentCallIds.size > 0,
    damagedLines, blockedPairs, keyedCallsBlocked,
  }
}
