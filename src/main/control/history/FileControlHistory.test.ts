import { mkdtemp, readFile, readdir, appendFile, writeFile, rm, stat, chmod, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createControlExecutor, createControlRegistry } from '../../../control-sdk/host'
import { defineCapability, type ControlHistory, type ControlResult } from '@control-sdk'
import { FileControlHistory } from './FileControlHistory'
import { historyCapabilities } from './control'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ac-control-history-'))
  directories.push(directory)
  return { directory, history: new FileControlHistory(directory) }
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
  return { history: new FileControlHistory(directory, { onRecovered: report => reports.push(report as Recovery) }), reports }
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
