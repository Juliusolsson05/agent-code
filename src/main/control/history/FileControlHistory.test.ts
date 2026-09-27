import { mkdtemp, readFile, readdir, appendFile, writeFile, rm, stat, chmod, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createControlExecutor, createControlRegistry } from '../../../control-sdk/host'
import { defineCapability, type ControlHistory, type ControlResult } from '@control-sdk'
import { CONTROL_HISTORY_RETENTION_MS, FileControlHistory } from './FileControlHistory'
import { taskHistoryCapabilities } from './tasks'
import { historyCapabilities } from './control'

// The recorded rows in real-rows-2026-09.json were written on 2026-09-05. The
// history's retention clock (#1274) is pinned there, so a recorded unkeyed
// call is "recent" as it was when recorded, not pruned for being weeks old by
// the wall clock. Rows these tests append are stamped with the wall clock,
// which is later still, so they are recent too. Retention itself is tested
// against its own clock at the end of the file.
const RECORDED_AT = () => new Date('2026-09-05T09:00:00.000Z')
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ac-control-history-'))
  directories.push(directory)
  return { directory, history: new FileControlHistory(directory, { now: RECORDED_AT }) }
}
const caller = { kind: 'external' as const, id: 'trial-client' }
function executor(history: ControlHistory, handler: () => Promise<unknown> = async () => 'done') {
  const registry = createControlRegistry()
  registry.register({ kind: 'main', generation: 'trial' }, [defineCapability({
    id: 'trial.act', title: 'Harmless trial', description: 'Exercise durable admission',
    execution: 'main', effect: 'mutation', input: z.object({ text: z.string() }), output: z.unknown(), handler,
  }), ...historyCapabilities(history)])
  return createControlExecutor({ history, instanceId: randomUUID(), id: randomUUID, now: () => new Date().toISOString(),
    catalog: () => registry.list(), dispatch: (request, context) => registry.invoke(request, context) })
}
const request = { capabilityId: 'trial.act', input: { text: 'first prompt' }, requestKey: 'one-intention' }

describe('durable control execution (real temporary files, injected contract faults)', () => {
  it('records concurrent retries, dispatches once, and reuses the result after reopen', async () => {
    const { directory, history } = await setup()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let effects = 0
    const run = executor(history, async () => { effects++; entered(); await gate; return 'sent' })
    const first = run.invoke(request, caller)
    await started
    const retry = run.invoke(request, caller)
    release()
    const [a, b] = await Promise.all([first, retry])
    expect(effects).toBe(1)
    expect(b.operation?.reusedCallId).toBe(a.operation?.callId)
    const reopened = executor(new FileControlHistory(directory), async () => { effects++; return 'should not run' })
    const replay = await reopened.invoke(request, caller)
    expect(replay).toMatchObject({ ok: true, value: 'sent', operation: { reusedCallId: a.operation?.callId } })
    expect(await reopened.invoke({ ...request, input: { text: 'different prompt' } }, caller)).toMatchObject({
      ok: false, error: { code: 'idempotency_conflict', outcome: 'not_started' },
    })
    expect(effects).toBe(1)
    const events = await new FileControlHistory(directory).events()
    expect(events.filter(event => event.kind === 'dispatched')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'duplicate')).toHaveLength(3)
    expect(new Set(events.map(event => event.callId)).size).toBe(4)
    expect((await stat(join(directory, 'events.jsonl'))).mode & 0o777).toBe(0o600)
  })

  it('preserves uncertainty after losing the final write and never retries the effect on restart', async () => {
    const { directory, history } = await setup()
    const failing: ControlHistory = {
      append: (event, payload) => event.kind === 'result' ? Promise.reject(new Error('injected disk failure')) : history.append(event, payload),
      events: () => history.events(), payload: id => history.payload(id), chunk: (id, offset, limit) => history.chunk(id, offset, limit),
    }
    const result = await executor(failing).invoke(request, caller)
    expect(result).toMatchObject({ ok: true, operation: { historyWarning: expect.any(String) } })
    let effects = 0
    const replay = await executor(new FileControlHistory(directory), async () => { effects++; return 'bad' }).invoke(request, caller)
    expect(replay).toMatchObject({ ok: false, error: { code: 'interrupted', outcome: 'unknown' } })
    expect(effects).toBe(0)
  })

  it('retrieves a complete large Unicode payload and freezes history paging before its own reads', async () => {
    const { history } = await setup()
    const full = 'agent output 🦊 漢字\n'.repeat(20000)
    const run = executor(history, async () => full)
    const result = await run.invoke(request, caller)
    const records = await history.events()
    const id = records.find(event => event.kind === 'result')!.payload!
    let offset = 0
    let reconstructed = ''
    do {
      const chunk = await history.chunk(id, offset, 4096)
      reconstructed += chunk.text
      if (chunk.nextOffset === null) break
      expect(chunk.nextOffset).toBeGreaterThan(offset)
      offset = chunk.nextOffset
    } while (true)
    expect(JSON.parse(reconstructed)).toEqual(result)
    const first = await run.invoke({ capabilityId: 'history.list', input: { limit: 1 } }, caller) as ControlResult<{
      events: Array<{ sequence: number }>; snapshot: number; nextAfter: number | null
    }>
    if (!first.ok) throw new Error('History read failed')
    expect(first.value.snapshot).toBe(records.length)
    let after = first.value.nextAfter
    const collected = [...first.value.events]
    while (after !== null) {
      const page = await run.invoke({ capabilityId: 'history.list', input: { limit: 1, after, snapshot: first.value.snapshot } }, caller) as typeof first
      if (!page.ok) throw new Error('History page failed')
      collected.push(...page.value.events)
      after = page.value.nextAfter
    }
    expect(collected.map(event => event.sequence)).toEqual(records.map(event => event.sequence))
  })

  it('keeps events appended without a request key JSON-identical to their durable form', async () => {
    // #975: a call without a request key used to append events whose
    // requestKey survived schema parsing as an explicit `undefined`
    // own-property. JSON.stringify dropped it on disk but the in-memory
    // cache kept it, so every history read covering those events failed
    // the capability output guard ("non-JSON value") until a restart
    // re-loaded the clean lines. The in-memory and durable shapes must
    // stay identical, whatever future writers pass in.
    const { history } = await setup()
    const run = executor(history)
    const result = await run.invoke({ capabilityId: 'trial.act', input: { text: 'no request key' } }, caller)
    expect(result).toMatchObject({ ok: true })
    // The exact operator read that failed in the wild: a capability
    // returning events appended by this same process.
    const read = await run.invoke({ capabilityId: 'history.list', input: { limit: 50 } }, caller)
    expect(read).toMatchObject({ ok: true })
    for (const event of await history.events()) {
      expect(() => z.json().parse(event)).not.toThrow()
      // toStrictEqual, not toEqual: toEqual ignores undefined-valued own
      // properties, so it would pass on exactly the poisoned shape (#975)
      // this loop exists to reject.
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event)
    }
  })
})

// #1240: a damaged journal used to block EVERY control call, across restarts,
// until someone edited events.jsonl by hand. Recovery must bring the app back
// without breaking the journal's other job (steering q12): a retried request
// key must never run its effect twice. Rows come from the owner's real
// journal (testing/fixtures/control-history).
const realRows = JSON.parse(await readFile(join(import.meta.dirname,
  '../../../../testing/fixtures/control-history/real-rows-2026-09.json'), 'utf8')) as {
  prefix: Array<Record<string, unknown>>
  keyedReceived: Record<string, unknown> & { caller: string; requestKey: string }
}
async function seeded() {
  const context = await setup()
  await writeFile(join(context.directory, 'events.jsonl'),
    realRows.prefix.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 })
  return context
}
type Recovery = { kind: string; quarantinePath: string; sha256: string; keyedCallsBlocked: boolean }
function reopen(directory: string) {
  const reports: Recovery[] = []
  return { history: new FileControlHistory(directory, { now: RECORDED_AT, onRecovered: report => reports.push(report as Recovery) }), reports }
}
// The real keyed row as its own external caller would retry it.
const realCaller = { kind: 'external' as const, id: realRows.keyedReceived.caller.replace(/^external:/, '') }
const realRetry = { capabilityId: 'trial.act', input: { text: 'retried' }, requestKey: realRows.keyedReceived.requestKey }

describe('damaged history recovery (#1240) keeps request keys idempotent', () => {
  it('recovers a torn tail, replays the prior call without re-running it, and preserves the bytes', async () => {
    const { directory, history } = await seeded()
    let effects = 0
    await executor(history, async () => { effects++; return 'sent' }).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    // A crash mid-append: a real row cut off mid-line.
    await appendFile(path, JSON.stringify({ ...realRows.keyedReceived, sequence: 7 }).slice(0, 90))
    const original = await readFile(path)

    const { history: recovered, reports } = reopen(directory)
    const run = executor(recovered, async () => { effects++; return 'second run' })
    expect(await run.invoke(request, caller)).toMatchObject({ ok: true, value: 'sent' })
    expect(effects).toBe(1)
    expect(await run.invoke({ ...request, requestKey: 'new-intention' }, caller)).toMatchObject({ ok: true, value: 'second run' })
    expect(effects).toBe(2)
    expect(reports).toEqual([expect.objectContaining({ kind: 'torn-tail', keyedCallsBlocked: false })])
    expect(await readFile(reports[0]!.quarantinePath)).toEqual(original)
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true)
  })

  it('still answers interrupted for a call whose result was lost before the tail tore', async () => {
    const { directory, history } = await seeded()
    const failing: ControlHistory = {
      append: (event, payload) => event.kind === 'result' ? Promise.reject(new Error('injected disk failure')) : history.append(event, payload),
      events: () => history.events(), payload: id => history.payload(id), chunk: (id, offset, limit) => history.chunk(id, offset, limit),
    }
    await executor(failing).invoke(request, caller)
    await appendFile(join(directory, 'events.jsonl'), '{"sequence":9,"kind":"resu')
    let effects = 0
    const replay = await executor(reopen(directory).history, async () => { effects++; return 'bad' }).invoke(request, caller)
    expect(replay).toMatchObject({ ok: false, error: { code: 'interrupted', outcome: 'unknown' } })
    expect(effects).toBe(0)
  })

  it('refuses a key whose received row is unreadable, and keeps reads, unkeyed calls and salvaged keys working', async () => {
    const { directory, history } = await seeded()
    let effects = 0
    await executor(history, async () => { effects++; return 'sent' }).invoke(request, caller)
    // A newer build's event kind, as an older build meets it after a downgrade.
    await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify({ ...realRows.keyedReceived, sequence: 7, kind: 'received.v2' })}\n`)

    const { history: recovered, reports } = reopen(directory)
    const run = executor(recovered, async () => { effects++; return 'ran' })
    expect(await run.invoke(realRetry, realCaller)).toMatchObject({ ok: false, error: { code: 'history_unavailable', outcome: 'not_started' } })
    expect(effects).toBe(1)
    expect(await run.invoke({ capabilityId: 'trial.act', input: { text: 'unkeyed' } }, caller)).toMatchObject({ ok: true, value: 'ran' })
    expect(await run.invoke({ capabilityId: 'history.list', input: { limit: 5 } }, caller)).toMatchObject({ ok: true })
    expect(await run.invoke(request, caller)).toMatchObject({ ok: true, value: 'sent' })
    expect(effects).toBe(2)
    expect(reports).toEqual([expect.objectContaining({ kind: 'damaged-rows', keyedCallsBlocked: false })])
  })

  it('blocks exactly the damaged pair, not every key of the same caller', async () => {
    // The real external caller sends many keyed intents (529 keyed rows in the
    // owner's journal); one unreadable pair must not lock the rest out.
    const { directory } = await seeded()
    await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify({ ...realRows.keyedReceived, sequence: 4, kind: 'received.v2' })}\n`)
    let effects = 0
    const run = executor(reopen(directory).history, async () => { effects++; return 'ran' })
    expect(await run.invoke(realRetry, realCaller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(await run.invoke({ ...realRetry, requestKey: `${realRows.keyedReceived.requestKey}-next` }, realCaller)).toMatchObject({ ok: true, value: 'ran' })
    expect(effects).toBe(1)
  })

  it('treats a row with its kind MISSING as corruption, not a downgrade (review B)', async () => {
    // Missing kind plus a truncated key: trusting the truncated pair would let
    // the REAL key dispatch a second time.
    const { directory } = await seeded()
    const { kind: _gone, ...kindless } = realRows.keyedReceived
    await appendFile(join(directory, 'events.jsonl'),
      `${JSON.stringify({ ...kindless, sequence: 4, requestKey: realRows.keyedReceived.requestKey.slice(0, -2) })}\n`)
    let effects = 0
    const { history, reports } = reopen(directory)
    expect(await executor(history, async () => { effects++; return 'ran' }).invoke(realRetry, realCaller))
      .toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(effects).toBe(0)
    expect(reports[0]).toMatchObject({ keyedCallsBlocked: true })
  })

  it('salvages every valid row around a gap once, and later loads find a clean ledger', async () => {
    const { directory, history } = await seeded()
    await executor(history).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    await writeFile(path, `${[lines[0], ...lines.slice(2)].join('\n')}\n`)
    const first = reopen(directory)
    expect((await first.history.events()).map(event => event.sequence)).toEqual(lines.slice(1).map((_, index) => index + 1))
    const second = reopen(directory)
    await second.history.events()
    // Renumbered to 1..n, so the next launch does not re-quarantine forever.
    expect(second.reports).toEqual([])
    expect((await readdir(directory)).filter(name => name.startsWith('events.quarantined-'))).toHaveLength(1)
  })

  it('preserves an unreadable marker as evidence when a later recovery rewrites it, and keeps its block', async () => {
    const { directory, history } = await seeded()
    await executor(history).invoke(request, caller)
    await writeFile(join(directory, 'recovery.json'), '{"quarantines": "garbage"}')
    const path = join(directory, 'events.jsonl')
    await appendFile(path, JSON.stringify({ ...realRows.keyedReceived, sequence: 9 }).slice(0, 60))
    let effects = 0
    const run = executor(reopen(directory).history, async () => { effects++; return 'ran' })
    // The torn tail alone would block nothing; the unreadable marker it
    // replaced must keep blocking new keyed intents.
    expect(await run.invoke({ ...request, requestKey: 'after-marker' }, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    const preserved = (await readdir(directory)).find(name => name.startsWith('recovery.invalid-'))!
    expect(await readFile(join(directory, preserved), 'utf8')).toBe('{"quarantines": "garbage"}')
    // Its record carries the block even once the preserved bytes are deleted.
    await rm(join(directory, preserved))
    expect(await executor(new FileControlHistory(directory), async () => { effects++; return 'ran' }).invoke({ ...request, requestKey: 'after-marker' }, caller))
      .toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(effects).toBe(0)
  })

  it('does not cache a failed load: the next call re-reads the disk', async () => {
    const { directory, history } = await seeded()
    const path = join(directory, 'events.jsonl')
    await chmod(path, 0o000)
    await expect(history.events()).rejects.toThrow()
    await chmod(path, 0o600)
    expect(await history.events()).toHaveLength(realRows.prefix.length)
  })

  // Review A: the executor stamps every row of a call with its request key,
  // and the lookup reads only `received` rows. A damaged `received` row can
  // name the wrong key while the call's kept rows still name the real one.
  async function withReceivedRewritten(rewrite: (row: Record<string, unknown>) => Record<string, unknown>) {
    const { directory, history } = await seeded()
    let effects = 0
    await executor(history, async () => { effects++; return 'sent' }).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    const index = lines.findIndex(line => JSON.parse(line).kind === 'received' && JSON.parse(line).requestKey === request.requestKey)
    lines[index] = JSON.stringify(rewrite(JSON.parse(lines[index]!)))
    await writeFile(path, `${lines.join('\n')}\n`)
    const run = executor(reopen(directory).history, async () => { effects++; return 'again' })
    return { directory, run, effects: () => effects }
  }

  it('blocks the real key when a downgrade-shaped received row carries a corrupted key string', async () => {
    const { run, effects } = await withReceivedRewritten(row => ({ ...row, kind: 'received.v2', requestKey: `${row.requestKey}-corrupted` }))
    expect(await run.invoke(request, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(effects()).toBe(1)
  })

  it('blocks the real key when a schema-valid received row lost its key but its siblings kept it', async () => {
    const { run, effects } = await withReceivedRewritten(({ requestKey: _lost, ...row }) => row)
    expect(await run.invoke(request, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(effects()).toBe(1)
  })

  it('blocks the real key when its received row was rewritten into another valid call', async () => {
    // The original call keeps agreeing dispatched/result rows but has no
    // intent row left, so the lookup cannot find it (#1254 round 2, A).
    const { run, effects } = await withReceivedRewritten(row => ({ ...row, callId: randomUUID(), requestKey: 'somebody-else' }))
    expect(await run.invoke(request, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(effects()).toBe(1)
  })

  it('recovers an inconsistent call once: later launches keep the block without re-quarantining (q17)', async () => {
    const { directory, run, effects } = await withReceivedRewritten(({ requestKey: _lost, ...row }) => row)
    expect(await run.invoke(request, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    const second = reopen(directory)
    expect(await executor(second.history, async () => 'again').invoke(request, caller))
      .toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    const third = reopen(directory)
    await third.history.events()
    expect(second.reports).toEqual([])
    expect(third.reports).toEqual([])
    expect((await readdir(directory)).filter(name => name.startsWith('events.quarantined-'))).toHaveLength(1)
    expect(effects()).toBe(1)
  })

  it('never lifts a recorded block when the quarantined evidence is shortened (review A)', async () => {
    const { directory, history } = await seeded()
    let effects = 0
    await executor(history, async () => { effects++; return 'sent' }).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    const index = lines.findIndex(line => JSON.parse(line).kind === 'received' && JSON.parse(line).requestKey === request.requestKey)
    lines[index] = 'NOT-JSON-RECEIVED'
    await writeFile(path, `${lines.join('\n')}\n`)
    await reopen(directory).history.events()
    // Cut the preserved copy inside the damaged line: re-analysis alone would
    // now call it a harmless torn tail.
    const quarantine = join(directory, (await readdir(directory)).find(name => name.startsWith('events.quarantined-'))!)
    const bytes = await readFile(quarantine, 'utf8')
    await writeFile(quarantine, bytes.slice(0, bytes.indexOf('NOT-JSON') + 5))
    expect(await executor(new FileControlHistory(directory), async () => { effects++; return 'again' }).invoke({ ...request, requestKey: 'fresh-after-cut' }, caller))
      .toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(effects).toBe(1)
  })

  it('blocks new keyed calls after an unreadable line until the operator clears recovery', async () => {
    const { directory, history } = await seeded()
    await executor(history).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    await appendFile(path, 'not json at all\n')
    let effects = 0
    const { history: recovered, reports } = reopen(directory)
    const run = executor(recovered, async () => { effects++; return 'ran' })
    const fresh = { ...request, requestKey: 'fresh-intention' }
    // The refusal names the evidence and how to accept it, so a blocked
    // caller is not left with a generic storage error.
    expect(await run.invoke(fresh, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable', outcome: 'not_started',
      message: expect.stringContaining('recovery-accepted.json') } })
    expect(await run.invoke({ capabilityId: 'trial.act', input: { text: 'unkeyed' } }, caller)).toMatchObject({ ok: true })
    expect(effects).toBe(1)
    expect(reports[0]).toMatchObject({ kind: 'damaged-rows', keyedCallsBlocked: true })

    // Neither a restart nor deleting the marker lifts the block (steering
    // q13): the preserved evidence itself is re-analyzed on load.
    await rm(join(directory, 'recovery.json'))
    const afterDelete = executor(new FileControlHistory(directory), async () => { effects++; return 'ran' })
    expect(await afterDelete.invoke(fresh, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable', outcome: 'not_started' } })
    expect(effects).toBe(1)

    // Only an explicit acceptance naming the exact evidence digest ends it:
    // request keys have no lifetime, so no timeout could be proven safe.
    await writeFile(join(directory, 'recovery-accepted.json'), JSON.stringify({ accepted: [reports[0]!.sha256] }))
    expect(await executor(new FileControlHistory(directory), async () => { effects++; return 'ran' }).invoke(fresh, caller))
      .toMatchObject({ ok: true, value: 'ran' })
    expect(effects).toBe(2)
  })

  it('treats a mid-ledger received-shaped row without provable key fields as unknown-key evidence (q13)', async () => {
    const { directory, history } = await seeded()
    let effects = 0
    await executor(history, async () => { effects++; return 'sent' }).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean).length
    // The real keyed intent with its key bytes lost, then an intact row after
    // it: the damage is in the middle, and which key it held is unknowable.
    const { requestKey: _lost, caller: _alsoLost, ...keyless } = realRows.keyedReceived
    await appendFile(path, `${JSON.stringify({ ...keyless, sequence: lines + 1 })}\n${JSON.stringify({ ...realRows.prefix[0], sequence: lines + 2 })}\n`)

    const { history: recovered, reports } = reopen(directory)
    const run = executor(recovered, async () => { effects++; return 'ran' })
    expect(await run.invoke(realRetry, realCaller)).toMatchObject({ ok: false, error: { code: 'history_unavailable', outcome: 'not_started' } })
    expect(await run.invoke({ ...request, requestKey: 'brand-new' }, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(await run.invoke(request, caller)).toMatchObject({ ok: true, value: 'sent' })
    expect(effects).toBe(1)
    expect(reports[0]).toMatchObject({ kind: 'damaged-rows', keyedCallsBlocked: true })
  })

  it('fails closed on a parseable but malformed recovery marker (q14)', async () => {
    const { directory, history } = await seeded()
    await executor(history).invoke(request, caller)
    await appendFile(join(directory, 'events.jsonl'), 'not json at all\n')
    await reopen(directory).history.events()
    // A marker naming the quarantine but carrying no flags must neither hide
    // that file from the rescan nor read as "no block".
    const quarantine = (await readdir(directory)).find(name => name.startsWith('events.quarantined-'))!
    await writeFile(join(directory, 'recovery.json'), JSON.stringify({ quarantines: [{ file: quarantine }] }))
    let effects = 0
    const run = () => executor(new FileControlHistory(directory), async () => { effects++; return 'ran' })
    expect(await run().invoke({ ...request, requestKey: 'marker-edited' }, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    // With the quarantine file gone too, the malformed marker alone still blocks.
    await rm(join(directory, quarantine))
    expect(await run().invoke({ ...request, requestKey: 'marker-edited' }, caller)).toMatchObject({ ok: false, error: { code: 'history_unavailable' } })
    expect(effects).toBe(0)
    // ...as a keyed block, not by breaking the load: unkeyed calls still run.
    expect(await run().invoke({ capabilityId: 'trial.act', input: { text: 'unkeyed' } }, caller)).toMatchObject({ ok: true, value: 'ran' })
  })

  it('blocks new keyed calls when rows are missing from the middle of the ledger', async () => {
    const { directory, history } = await seeded()
    await executor(history).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    // Lose real row 2: every remaining row is valid, but whatever the lost
    // row held is unknown.
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    await writeFile(path, `${[lines[0], ...lines.slice(2)].join('\n')}\n`)
    let effects = 0
    const { history: recovered, reports } = reopen(directory)
    expect(await executor(recovered, async () => { effects++; return 'ran' }).invoke({ ...request, requestKey: 'after-gap' }, caller))
      .toMatchObject({ ok: false, error: { code: 'history_unavailable', outcome: 'not_started' } })
    expect(effects).toBe(0)
    expect(reports[0]).toMatchObject({ kind: 'damaged-rows', keyedCallsBlocked: true })
  })

  it('recovers from a failed append in the same process, without a restart', async () => {
    const { directory, history } = await seeded()
    const run = executor(history)
    await run.invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    await chmod(path, 0o400)
    expect(await run.invoke({ ...request, requestKey: 'while-broken' }, caller)).toMatchObject({ ok: false })
    await chmod(path, 0o600)
    // What a failed write can leave behind: part of a row. Only the disk
    // knows, so the next append must re-read it rather than trust memory;
    // appending after a cached view would glue the new row onto the torn
    // bytes and damage the journal for the next launch.
    await appendFile(path, '{"sequence":7,"kind":"rece')
    expect(await run.invoke({ ...request, requestKey: 'after-repair' }, caller)).toMatchObject({ ok: true })
    const { history: nextLaunch, reports } = reopen(directory)
    expect((await nextLaunch.events()).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(reports).toEqual([])
    await access(path)
  })
})

// #1274: the journal and its payloads grew forever (129 MB after 22 days on
// the owner's machine, 105 MB of it read-only transcripts.page results) and
// the whole journal lived in memory. Retention may only drop calls that can
// never be looked up for dedupe (steering q12): unkeyed, finished, not reused.
const retentionRows = JSON.parse(await readFile(join(import.meta.dirname,
  '../../../../testing/fixtures/control-history/retention-rows-2026-09-27.json'), 'utf8')) as {
  rows: Array<{ sequence: number; callId: string; kind: string; payload?: string; requestKey?: string }>
}
const RETENTION_NOW = new Date('2026-09-27T12:00:00.000Z')
const OLD_UNKEYED = ['95caa49c-eb60-44e2-9b62-938ce2243d11', '5ea10842-a1c8-463c-aee9-5d0e238c56e1', '37763f2f-c479-49b7-8d79-4c990bc0784c']
const KEPT = ['95c97fce-bca0-4bc7-9901-90b45d988d1c', '13e43d53-5120-41ae-88d7-820dc9088728', 'a346f752-9eec-4b37-b7df-145dfaf1aaf5',
  'e8a21d19-b139-4012-8e09-6139b5643bb5', '2ebe82c0-c877-4bb6-9877-56ded38d4739']
// The old unkeyed externalControl.status and transcripts.page calls'
// `dispatched` rows name the same digest as the keyed app.windowFocus call's
// `dispatched` row (#1330 review B5 corrected which rows); pruning the first
// two must not take it away from the third.
const SHARED_DIGEST = 'e5624e8c0ef7518948b17f88486be4658cdb3ba0e9c92a02aea6ad365bb92fd1'
const ORPHAN_DIGEST = 'f'.repeat(64)

describe('control history retention (#1274)', () => {
  // Payload CONTENTS are not recorded (they hold prompts and results), and
  // retention now READS result and step payloads (#1330 review: an unknown
  // outcome or a task origin must be kept), through the same digest check
  // every reader uses. So each recorded digest is replaced, here and not in
  // the fixture, by the digest of a body of the right shape for the row
  // that first names it: a settled `completed` result, an ordinary owner
  // step, or an opaque input. One recorded digest maps to one body, so rows
  // that shared a payload still share one. Everything else is the recording.
  const bodies = new Map<string, string>()
  for (const row of retentionRows.rows) {
    if (!row.payload || bodies.has(row.payload)) continue
    bodies.set(row.payload, JSON.stringify(row.kind === 'result'
      ? { ok: true, value: { recorded: row.payload }, operation: { callId: row.callId, instanceId: 'recorded', status: 'completed' } }
      : row.kind === 'step' ? { step: 'resolve-owner', recorded: row.payload } : { recorded: row.payload }))
  }
  const digestOf = (body: string) => createHash('sha256').update(body).digest('hex')
  const remap = new Map([...bodies].map(([recorded, body]) => [recorded, digestOf(body)]))
  const rowsWithBodies = retentionRows.rows.map(row => row.payload ? { ...row, payload: remap.get(row.payload)! } : row)
  const SHARED = remap.get(SHARED_DIGEST)!
  async function writePayload(directory: string, body: string): Promise<string> {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, 'payloads'), { recursive: true })
    const digest = digestOf(body)
    await writeFile(join(directory, 'payloads', `${digest}.json`), body)
    return digest
  }
  async function seededJournal(rows: Array<Record<string, unknown> & { callId: string; kind: string; payload?: string }> = rowsWithBodies) {
    const { directory } = await setup()
    await writeFile(join(directory, 'events.jsonl'), rows.map((row, index) => `${JSON.stringify({ ...row, sequence: index + 1 })}\n`).join(''), { mode: 0o600 })
    for (const body of bodies.values()) await writePayload(directory, body)
    // An orphan, as a failed append leaves, and a temp file of a write that
    // never renamed: GC takes the first and must never touch the second.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, 'payloads'), { recursive: true })
    await writeFile(join(directory, 'payloads', `${ORPHAN_DIGEST}.json`), '{}')
    await writeFile(join(directory, 'payloads', `${ORPHAN_DIGEST}.json.tmp`), '{}')
    return directory
  }
  const open = (directory: string, onRecovered?: () => void) =>
    new FileControlHistory(directory, { now: () => RETENTION_NOW, onRecovered })

  it('drops old unkeyed finished calls and their payloads, and keeps every keyed, reused and recent call', async () => {
    const directory = await seededJournal()
    const events = await open(directory).events()
    expect([...new Set(events.map(event => event.callId))].sort()).toEqual([...KEPT].sort())
    // Kept rows are the recorded rows, in order, with only sequences renumbered.
    const expected = rowsWithBodies.filter(row => KEPT.includes(row.callId))
    expect(events.map(({ sequence: _s, ...rest }) => rest)).toEqual(expected.map(({ sequence: _s, ...rest }) => rest))
    expect(events.map(event => event.sequence)).toEqual(expected.map((_, index) => index + 1))
    const payloads = new Set(await readdir(join(directory, 'payloads')))
    const keptDigests = new Set(expected.map(row => row.payload!).filter(Boolean))
    expect(payloads).toEqual(new Set([...[...keptDigests].map(digest => `${digest}.json`), `${ORPHAN_DIGEST}.json.tmp`]))
    expect(payloads.has(`${SHARED}.json`)).toBe(true)
    expect(payloads.has(`${ORPHAN_DIGEST}.json`)).toBe(false)
    // The rewrite is durable and clean: a second launch prunes nothing and
    // reports no recovery.
    const reports: unknown[] = []
    expect(await open(directory, () => reports.push(1)).events()).toEqual(events)
    expect(reports).toEqual([])
  })

  it('keeps a call with no result row however old it is', async () => {
    const rows = rowsWithBodies.filter(row => !(row.callId === OLD_UNKEYED[2] && row.kind === 'result'))
    const directory = await seededJournal(rows)
    const events = await open(directory).events()
    expect(events.some(event => event.callId === OLD_UNKEYED[2])).toBe(true)
    expect(events.some(event => event.callId === OLD_UNKEYED[0])).toBe(false)
  })

  it('does not prune in a launch that had to recover the journal', async () => {
    const directory = await seededJournal()
    await appendFile(join(directory, 'events.jsonl'), '{"sequence":31,"kind":"resu')
    const reports: unknown[] = []
    const events = await open(directory, () => reports.push(1)).events()
    expect(reports).toHaveLength(1)
    expect(events.some(event => event.callId === OLD_UNKEYED[0])).toBe(true)
  })

  it('still replays an old keyed call after its unkeyed neighbours were pruned', async () => {
    const { directory } = await setup()
    const then = new Date('2026-09-01T00:00:00.000Z')
    let effects = 0
    const at = (clock: () => Date, history: ControlHistory) => {
      const registry = createControlRegistry()
      registry.register({ kind: 'main', generation: 'trial' }, [defineCapability({
        id: 'trial.act', title: 'Harmless trial', description: 'Exercise durable admission',
        execution: 'main', effect: 'mutation', input: z.object({ text: z.string() }), output: z.unknown(),
        handler: async () => { effects++; return 'sent' },
      })])
      return createControlExecutor({ history, instanceId: randomUUID(), id: randomUUID, now: () => clock().toISOString(),
        catalog: () => registry.list(), dispatch: (req, context) => registry.invoke(req, context) })
    }
    const old = new FileControlHistory(directory, { now: () => then })
    const first = await at(() => then, old).invoke(request, caller)
    await at(() => then, old).invoke({ ...request, requestKey: undefined, input: { text: 'unkeyed' } }, caller)
    expect(effects).toBe(2)

    const later = new FileControlHistory(directory, { now: () => RETENTION_NOW })
    const replay = await at(() => RETENTION_NOW, later).invoke(request, caller)
    expect(replay).toMatchObject({ ok: true, value: 'sent', operation: { reusedCallId: first.operation?.callId } })
    expect(effects).toBe(2)
    const kept = await new FileControlHistory(directory, { now: () => RETENTION_NOW }).events()
    expect(kept.every(event => event.requestKey === request.requestKey)).toBe(true)
  })

  // Rows shaped exactly like the executor's and the task writer's, for one
  // unkeyed call ending at `at`, each with a real hashed payload.
  type Built = { callId: string; rows: Array<Record<string, unknown> & { callId: string; kind: string; payload?: string }> }
  async function call(directory: string, options: { at: string; result?: unknown; steps?: unknown[]; reusedCallId?: string; callId?: string }): Promise<Built> {
    const callId = options.callId ?? randomUUID()
    const base = { at: options.at, instanceId: 'recorded', callId, capabilityId: 'agents.resume', caller: 'external:agent-code-control' }
    const rows: Built['rows'] = [
      { ...base, kind: 'received', payload: await writePayload(directory, JSON.stringify({ input: { callId } })) },
      { ...base, kind: 'dispatched', payload: await writePayload(directory, JSON.stringify({ owner: { kind: 'main', generation: 'g' } })) },
    ]
    for (const step of options.steps ?? []) rows.push({ ...base, kind: 'step', payload: await writePayload(directory, JSON.stringify(step)) })
    if (options.result !== undefined) rows.push({ ...base, kind: 'result', payload: await writePayload(directory, JSON.stringify(options.result)), ...(options.reusedCallId ? { reusedCallId: options.reusedCallId } : {}) })
    return { callId, rows }
  }
  async function journal(directory: string, calls: Built[]) {
    await writeFile(join(directory, 'events.jsonl'), calls.flatMap(built => built.rows).map((row, index) => `${JSON.stringify({ ...row, sequence: index + 1 })}\n`).join(''), { mode: 0o600 })
  }
  const OLD = '2026-09-01T00:00:00.000Z'
  const settled = (status = 'completed') => ({ ok: true, value: {}, operation: { callId: 'x', instanceId: 'recorded', status } })
  const kept = async (directory: string, ids: string[]) => {
    const present = new Set((await open(directory).events()).map(event => event.callId))
    return ids.map(id => present.has(id))
  }

  // #1330 review A1/C1, q49: an unkeyed task's original call is the task
  // store's lookup key. Pruning it turned operations.read into not_found and
  // made operations.finish unable to find its origin.
  it('keeps an unkeyed task origin, so operations.read still answers after the window', async () => {
    const { directory } = await setup()
    const owner = { kind: 'main' as const, generation: 'g' }
    const task = await call(directory, { at: OLD, result: settled('pending'), steps: [
      { step: 'task.started', owner },
      { step: 'task.finished', result: { ok: true, value: { newSessionId: 'new' } } },
    ] })
    const plain = await call(directory, { at: OLD, result: settled() })
    await journal(directory, [task, plain])
    const history = open(directory)
    const read = taskHistoryCapabilities(history, () => false).find(item => item.descriptor.id === 'operations.read')!
    const context = { requestId: 'read', owner, caller: { kind: 'external' as const, id: 'operator' } }
    expect(await read.execute({ callId: task.callId }, context)).toMatchObject({ ok: true, value: { status: 'completed', result: { ok: true, value: { newSessionId: 'new' } } } })
    expect(await kept(directory, [task.callId, plain.callId])).toEqual([true, false])
  })

  // #1330 review A3, q49: an unknown outcome is the evidence that the effect
  // may have run; `pending` is still open. Only a proven-settled result goes.
  it('keeps results that are not proven settled, and prunes settled ones', async () => {
    const { directory } = await setup()
    const unknown = await call(directory, { at: OLD, result: { ok: false, error: { code: 'unavailable', message: 'lost', outcome: 'unknown' }, operation: { callId: 'x', instanceId: 'recorded', status: 'outcome_unknown' } } })
    const pending = await call(directory, { at: OLD, result: settled('pending') })
    const refused = await call(directory, { at: OLD, result: { ok: false, error: { code: 'unavailable', message: 'no', outcome: 'not_started' }, operation: { callId: 'x', instanceId: 'recorded', status: 'blocked' } } })
    const done = await call(directory, { at: OLD, result: settled() })
    const opened = await call(directory, { at: OLD, result: settled('ui_opened') })
    const transport = await call(directory, { at: OLD, result: { direction: 'outbound', payload: { jsonrpc: '2.0' } } })
    await journal(directory, [unknown, pending, refused, done, opened, transport])
    expect(await kept(directory, [unknown, pending, refused, done, opened, transport].map(built => built.callId)))
      .toEqual([true, true, false, false, false, false])
    // The unknown outcome's payload is still readable for reconciliation.
    const history = open(directory)
    const row = (await history.events()).find(event => event.callId === unknown.callId && event.kind === 'result')!
    expect(await history.payload(row.payload!)).toMatchObject({ error: { outcome: 'unknown' } })
  })

  // #1330 review A2, q49: an unaccepted recovery's quarantine names rows and
  // payloads the operator must still be able to read. The first launch
  // recovers (no prune); the second must not prune what the quarantine
  // names; once the operator accepts the digest, it may go.
  it('keeps what an unaccepted recovery quarantine names, until it is accepted', async () => {
    const { directory } = await setup()
    const old = await call(directory, { at: OLD, result: settled() })
    await journal(directory, [old])
    await appendFile(join(directory, 'events.jsonl'), 'not json\n')
    const reports: Array<{ sha256: string }> = []
    await new FileControlHistory(directory, { now: () => RETENTION_NOW, onRecovered: report => reports.push(report) }).events()
    expect(reports).toHaveLength(1)
    const second = open(directory)
    const events = await second.events()
    const result = events.find(event => event.callId === old.callId && event.kind === 'result')
    expect(result).toBeDefined()
    expect(await second.payload(result!.payload!)).toMatchObject({ ok: true })
    await writeFile(join(directory, 'recovery-accepted.json'), JSON.stringify({ accepted: [reports[0]!.sha256] }))
    expect(await kept(directory, [old.callId])).toEqual([false])
  })

  // #1330 review B1: payload GC must only follow a durable rewrite. A
  // rewrite that fails (here: the directory refuses the temp file) leaves the
  // old journal naming every payload, and the load itself still works.
  it('leaves every payload and serves the unpruned rows when the rewrite fails', async () => {
    const directory = await seededJournal()
    const before = new Set(await readdir(join(directory, 'payloads')))
    await chmod(directory, 0o500)
    try {
      const events = await open(directory).events()
      expect(new Set(events.map(event => event.callId))).toEqual(new Set(retentionRows.rows.map(row => row.callId)))
      expect(new Set(await readdir(join(directory, 'payloads')))).toEqual(before)
    } finally { await chmod(directory, 0o700) }
    // Writable again, the next launch prunes as usual.
    expect(await kept(directory, OLD_UNKEYED)).toEqual([false, false, false])
  })

  // #1330 review A/B survivors: each rule on its own.
  it('keeps an old unkeyed call a kept duplicate reuses, and a call of unknown age', async () => {
    const { directory } = await setup()
    const target = await call(directory, { at: OLD, result: settled() })
    const reuser = await call(directory, { at: RETENTION_NOW.toISOString(), result: settled(), reusedCallId: target.callId })
    const unknownAge = await call(directory, { at: 'not a time', result: settled() })
    await journal(directory, [target, reuser, unknownAge])
    expect(await kept(directory, [target.callId, reuser.callId, unknownAge.callId])).toEqual([true, true, true])
  })

  // #1330 review C: the window is pinned at its boundary, not only by rows
  // three weeks apart.
  it('prunes a call exactly past the window and keeps one just inside it', async () => {
    const { directory } = await setup()
    const minute = 60_000
    const inside = await call(directory, { at: new Date(RETENTION_NOW.getTime() - CONTROL_HISTORY_RETENTION_MS + minute).toISOString(), result: settled() })
    const outside = await call(directory, { at: new Date(RETENTION_NOW.getTime() - CONTROL_HISTORY_RETENTION_MS - minute).toISOString(), result: settled() })
    await journal(directory, [inside, outside])
    expect(await kept(directory, [inside.callId, outside.callId])).toEqual([true, false])
    expect(CONTROL_HISTORY_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
