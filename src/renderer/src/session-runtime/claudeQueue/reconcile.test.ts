import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyCommittedUserEntry,
  applyQueuedCommandObservation,
  applyQueueOperation,
  createClaudeQueueState,
  markStaleWhenIdle,
} from './reconcile'
import { derivePriority } from './priority'
import { PRIORITY_LATER, PRIORITY_NEXT, type ClaudeQueueState } from './types'

// Tests for the Claude queue reconciler.
//
// The named scenarios below are NOT invented inputs — every payload shape comes
// from the recorded corpus in testing/fixtures/queue-operations/ (see
// catalog.md for the measurements). The corpus replay at the bottom runs the
// real recorded sessions end to end.
//
// The acceptance bar is WHICH item left and WHY, never queue length. A test
// asserting "one item remains" passes while the wrong one remains, which is the
// exact bug this module was written to end.

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../testing/fixtures/queue-operations',
)

type FixtureEvent =
  | { kind: 'op'; op: string; content?: string; timestamp?: string }
  | { kind: 'user'; uuid?: string; text: string }

function loadFixture(slug: string): { source: string; note: string; events: FixtureEvent[] } {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${slug}.json`), 'utf8'))
}

function replay(events: readonly FixtureEvent[]): ClaudeQueueState {
  let state = createClaudeQueueState()
  for (const e of events) {
    state =
      e.kind === 'op'
        ? applyQueueOperation(state, { operation: e.op, content: e.content, timestamp: e.timestamp })
        : applyCommittedUserEntry(state, { uuid: e.uuid, text: e.text })
  }
  return state
}

// Payload builders matching the upstream emit sites verbatim
// (LocalShellTask.tsx / LocalAgentTask.tsx).
const backgroundCommand = (name: string, id = `bg-${name}`) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/${id}</output-file>\n<status>completed</status>\n<summary>Background command "${name}" completed (exit code 0)</summary>\n</task-notification>`

const agentFinished = (name: string, id = `ag-${name}`) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/${id}</output-file>\n<status>completed</status>\n<summary>Agent "${name}" finished</summary>\n</task-notification>`

const stallWatchdog = (name: string, id = `st-${name}`) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/${id}</output-file>\n<summary>Background command "${name}" appears to be waiting for interactive input</summary>\n</task-notification>\nLast output:\n$ `

describe('derivePriority — priority is per emit site, not per mode', () => {
  it('scores a background-command completion next, not later', () => {
    // The single row that caused the bug. LocalShellTask.tsx:169 resolves to
    // priority:"next" in the installed 2.1.220 binary.
    expect(derivePriority(backgroundCommand('build'))).toBe(PRIORITY_NEXT)
  })

  it('scores an agent completion later', () => {
    expect(derivePriority(agentFinished('audit'))).toBe(PRIORITY_LATER)
  })

  it('scores the statusless stall watchdog next', () => {
    expect(derivePriority(stallWatchdog('server'))).toBe(PRIORITY_NEXT)
  })

  it('scores a plain user prompt next', () => {
    expect(derivePriority('run the tests please')).toBe(PRIORITY_NEXT)
  })
})

describe('the reported bug: mixed later/next cohort with one remove', () => {
  it('removes the background command and KEEPS the agent notification', () => {
    // Claude's mid-turn drain at threshold `next` is eligible for the
    // background item only, so upstream logs exactly one `remove` and the
    // agent notification stays queued.
    //
    // The old implementation scored BOTH as 'later', tied, took index 0, and
    // dropped the agent item — stranding the background command forever. This
    // assertion is the regression that pins it.
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: agentFinished('audit'),
      timestamp: '1',
    })
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: backgroundCommand('build'),
      timestamp: '2',
    })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '3' })
    state = markStaleWhenIdle(state, true)

    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]!.content).toContain('Agent "audit" finished')
    expect(state.decisions.map(d => d.reason)).toContain('consumed-inferred')
    expect(
      state.decisions.find(d => d.reason === 'consumed-inferred')?.preview,
    ).toContain('Background command "build"')
  })

  it('does not strand the background command across repeated rounds', () => {
    // The soak shape: agent completions keep arriving while background
    // commands come and go. Under the old model the background residue grew
    // monotonically; here the queue drains to just the later-priority items.
    let state = createClaudeQueueState()
    for (let round = 0; round < 5; round++) {
      state = applyQueueOperation(state, {
        operation: 'enqueue',
        content: agentFinished(`a${round}`),
        timestamp: `${round}a`,
      })
      state = applyQueueOperation(state, {
        operation: 'enqueue',
        content: backgroundCommand(`b${round}`),
        timestamp: `${round}b`,
      })
      state = applyQueueOperation(state, { operation: 'remove', timestamp: `${round}r` })
    }
    state = markStaleWhenIdle(state, true)
    const stranded = state.pending.filter(i => i.content.includes('Background command'))
    expect(stranded).toEqual([])
  })
})

describe('remove: the two upstream callers disagree, and we resolve safely', () => {
  it('uses the recorded remove content in a mixed queue instead of guessing a victim', () => {
    const fixture = loadFixture('divergence-stranded-background-commands')
    // Events 111–116 are one real mixed transition: a notification remains
    // pending, a prompt is enqueued, and remove names that exact prompt. Using
    // the fixture slice keeps all earlier queue state/evidence intact instead
    // of inventing a smaller queue that merely looks plausible.
    const throughRecordedRemove = fixture.events.slice(0, 117)
    const removedPrompt = fixture.events[115]
    const retainedNotification = fixture.events[112]
    if (
      removedPrompt?.kind !== 'op' ||
      typeof removedPrompt.content !== 'string' ||
      retainedNotification?.kind !== 'op' ||
      typeof retainedNotification.content !== 'string'
    ) {
      throw new Error('recorded mixed-queue fixture indices drifted')
    }

    const state = replay(throughRecordedRemove)
    expect(state.pending.map(item => item.content)).toContain(retainedNotification.content)
    expect(state.pending.map(item => item.content)).not.toContain(removedPrompt.content)
    expect(state.decisions.at(-1)).toEqual(
      expect.objectContaining({
        reason: 'consumed-observed',
        evidence: ['queue-operation content'],
      }),
    )
  })

  it('waits for the recorded durable attachment on a legacy content-free remove', () => {
    const bundle = JSON.parse(
      readFileSync(
        join(
          FIXTURE_DIR,
          '..',
          'rendering-bundles',
          '2026-06-14T14-25-07-012-a8ad1ebb.json',
        ),
        'utf8',
      ),
    ) as { input: { entries: Array<Record<string, unknown>> } }
    const enqueue = bundle.input.entries[7]!
    const remove = bundle.input.entries[8]!
    const durable = bundle.input.entries[13]!
    const attachment = durable.attachment as Record<string, unknown>
    if (
      typeof enqueue.content !== 'string' ||
      typeof durable.uuid !== 'string' ||
      attachment.commandMode !== 'prompt' ||
      typeof attachment.prompt !== 'string'
    ) {
      throw new Error('recorded legacy remove/attachment fixture indices drifted')
    }

    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: String(enqueue.operation),
      content: enqueue.content,
      timestamp: typeof enqueue.timestamp === 'string' ? enqueue.timestamp : undefined,
    })
    state = applyQueueOperation(state, {
      operation: String(remove.operation),
      timestamp: typeof remove.timestamp === 'string' ? remove.timestamp : undefined,
    })

    // A content-free remove is not permission to delete the guessed item. The
    // durable identity is only five recorded entries later and may cross a
    // watcher burst, so the bounded debt—not copied prompt text—survives.
    expect(state.pending.map(item => item.content)).toEqual([enqueue.content])
    expect(state.removeDebt).toEqual({
      count: 1,
      at: remove.timestamp,
    })
    expect(Object.keys(state.removeDebt ?? {}).sort()).toEqual(['at', 'count'])
    state = applyQueuedCommandObservation(state, {
      uuid: durable.uuid,
      mode: 'prompt',
      text: attachment.prompt,
    })
    expect(state.pending).toEqual([])
    expect(state.decisions.at(-1)).toEqual(
      expect.objectContaining({
        reason: 'consumed-observed',
        evidence: [durable.uuid],
      }),
    )
  })

  it('applies recorded exact removes before settling older dequeue debt', () => {
    const fixture = loadFixture('exact-remove-after-open-dequeue-debt')
    const afterRecordedOperations = replay(fixture.events)

    // This is one uninterrupted recorded run, not a constructed interleaving:
    // 16 notifications are enqueued, 3 dequeue records create identity debt,
    // then 13 content-bearing removes name the other departures exactly. Three
    // task ids occur twice, which is why queue length or unique-id assertions
    // would both bless the original bug.
    const observedRemoves = afterRecordedOperations.decisions.filter(
      decision => decision.reason === 'consumed-observed',
    )
    expect(observedRemoves).toHaveLength(13)
    expect(afterRecordedOperations.debt?.count).toBe(3)
    expect(afterRecordedOperations.pending).toHaveLength(3)

    // The recording ends before committed delivery rows can identify the
    // dequeue cohort, so idle is the independently bounded settlement point.
    // Exact remove evidence owns thirteen items; dequeue inference owns three.
    // Neither mechanism may consume an item on behalf of the other.
    const settled = markStaleWhenIdle(afterRecordedOperations, true)
    expect(settled.pending).toEqual([])
    expect(settled.decisions.filter(d => d.reason === 'consumed-observed')).toHaveLength(13)
    expect(settled.decisions.filter(d => d.reason === 'delivered-inferred')).toHaveLength(3)
    expect(settled.decisions).toHaveLength(settled.nextSeq)
  })

  it('never deletes a queued prompt when a notification is also removable', () => {
    // `remove` has two callers. query.ts:1642 selects by PRIORITY (so it would
    // take the prompt); REPL.tsx:2532 (Ctrl+B) selects by MODE and removes
    // task-notifications ONLY, never a prompt. The record cannot tell us which
    // fired, so we resolve toward the notification: wrongly removing one leaves
    // a prompt on screen and the identity pass can still retire it, while
    // wrongly removing a prompt deletes the user's pending work irreversibly.
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: 'please run the tests',
      timestamp: '1',
    })
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: agentFinished('audit', 'id-audit'),
      timestamp: '2',
    })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '3' })
    state = markStaleWhenIdle(state, true)

    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]!.content).toBe('please run the tests')
    expect(state.decisions[0]!.preview).toContain('Agent "audit" finished')
  })

  it('applies popAll content before settling older remove debt', () => {
    // `popAll` is the OTHER departure that logs its content, so the
    // exact-before-inference rule the recorded fixture proves for `remove`
    // must hold here too. It did not: `remove` was fixed to receive the raw
    // state while `popAll` was still handed `settleRemoveDebtByCohort(state)`,
    // so the guess ran first and could consume the very item popAll names.
    //
    // Sequence: two prompts queued, one content-free legacy remove (opens a
    // debt of 1), then popAll naming the FIRST prompt. Upstream, the composer
    // took 'first' and the earlier remove took something else. Settling first
    // picks 'first' by FIFO cohort order, popAll then misses entirely, and
    // 'second' is stranded with the debt already spent on the wrong item.
    //
    // NOTE this sequence is not in testing/fixtures/queue-operations — no
    // recorded session there contains a popAll at all. It is asserted at the
    // reducer level rather than dressed up as a recording, because the
    // invariant under test is the one the recorded `remove` fixture already
    // establishes; only the carrier differs.
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: 'first', timestamp: '1' })
    state = applyQueueOperation(state, { operation: 'enqueue', content: 'second', timestamp: '2' })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '3' })
    expect(state.removeDebt?.count).toBe(1)

    state = applyQueueOperation(state, {
      operation: 'popAll',
      content: 'first',
      timestamp: '4',
    })

    // The exact carrier owns its own departure and must be recorded as
    // observed, not inferred away by the older debt.
    const popped = state.decisions.filter(d => d.reason === 'popped-to-composer')
    expect(popped).toHaveLength(1)
    expect(popped[0]!.preview).toContain('first')

    // The debt accounts for a DIFFERENT departure and must survive for its own
    // later settlement. Spending it here is what strands 'second'.
    expect(state.removeDebt?.count).toBe(1)
    expect(state.pending.map(i => i.content)).toEqual(['second'])
  })

  it('removes the notification the carrier names when two share a task id', () => {
    // Notification identity was matched on the correlation id ALONE. The
    // recorded corpus shows that is not unique: in
    // divergence-stranded-background-commands.json, 2 of 126 enqueued task ids
    // carry two DIFFERENT notification bodies — upstream reuses the id when a
    // background shell from a previous session is reconciled ("...was stopped"
    // vs "No completion record was found..."). With both queued, an exact
    // content-bearing remove naming the SECOND matched the FIRST by id, retired
    // it with the second's evidence, and stranded the one that actually left.
    //
    // The duplicate-id shape is recorded; pairing it with a remove carrier is
    // reducer-executable rather than sampled, so this is asserted at the
    // reducer level and says so rather than being dressed as a recording.
    const stopped = backgroundCommand('watch workflows', 'dup-id')
    const noRecord = agentFinished('previous session shell', 'dup-id')
    expect(stopped).not.toBe(noRecord)

    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: stopped, timestamp: '1' })
    state = applyQueueOperation(state, { operation: 'enqueue', content: noRecord, timestamp: '2' })
    state = applyQueueOperation(state, {
      operation: 'remove',
      content: noRecord,
      timestamp: '3',
    })

    // Exact content is the strongest evidence available; it must beat a
    // same-id sibling.
    expect(state.pending.map(i => i.content)).toEqual([stopped])
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]!.reason).toBe('consumed-observed')
  })

  it('resolves a same-id attachment observation to the exact body', () => {
    // Same defect on the other remove carrier: the durable queued-command
    // attachment settles legacy content-free remove debt through the same
    // predicate, so it could retire the wrong twin too.
    const stopped = backgroundCommand('watch workflows', 'dup-id')
    const noRecord = agentFinished('previous session shell', 'dup-id')

    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: stopped, timestamp: '1' })
    state = applyQueueOperation(state, { operation: 'enqueue', content: noRecord, timestamp: '2' })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '3' })
    expect(state.removeDebt?.count).toBe(1)

    state = applyQueuedCommandObservation(state, {
      mode: 'task-notification',
      text: noRecord,
      uuid: 'att-1',
    })

    expect(state.pending.map(i => i.content)).toEqual([stopped])
    expect(state.removeDebt).toBeNull()
  })

  it('declines rather than guessing when two same-id twins both fail exact match', () => {
    // The residual of the same class. When the exact pass misses AND more than
    // one pending item carries the carrier's id, the id pass alone cannot say
    // which twin left, so returning the first by array order mislabels a coin
    // flip as `consumed-observed` — which the module header explicitly forbids
    // ("debug output never upgrades a fallback into proof") and which strands
    // the item that actually departed, irreversibly.
    //
    // Declining is the module's established direction for unprovable evidence:
    // applyRemove already returns the original state when its exact target is
    // absent. Both items stay visible and the debt stays open, so the next
    // cohort settlement retires one as an honest `consumed-inferred`.
    const stopped = backgroundCommand('watch workflows', 'dup-id')
    const noRecord = agentFinished('previous session shell', 'dup-id')

    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: stopped, timestamp: '1' })
    state = applyQueueOperation(state, { operation: 'enqueue', content: noRecord, timestamp: '2' })
    const beforeCarrier = state

    // A carrier built from the second twin, reformatted upstream so it
    // normalizes equal to NEITHER queued body while still carrying the id.
    state = applyQueueOperation(state, {
      operation: 'remove',
      content: `${noRecord}\nreformatted upstream`,
      timestamp: '3',
    })

    expect(state).toBe(beforeCarrier)
    expect(state.pending.map(i => i.content)).toEqual([stopped, noRecord])
    expect(state.decisions).toEqual([])
  })

  it('declines an ambiguous same-id attachment observation and keeps the debt', () => {
    // Same rule on the attachment carrier: an ambiguous observation must not
    // spend the debt, or the wrong twin is retired and the debt is gone.
    const stopped = backgroundCommand('watch workflows', 'dup-id')
    const noRecord = agentFinished('previous session shell', 'dup-id')

    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: stopped, timestamp: '1' })
    state = applyQueueOperation(state, { operation: 'enqueue', content: noRecord, timestamp: '2' })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '3' })
    expect(state.removeDebt?.count).toBe(1)

    state = applyQueuedCommandObservation(state, {
      mode: 'task-notification',
      text: `${noRecord}\nreformatted upstream`,
      uuid: 'att-1',
    })

    expect(state.pending).toHaveLength(2)
    expect(state.removeDebt?.count).toBe(1)
  })

  it('still matches a same-id notification when only one is queued', () => {
    // The id fallback must survive: a carrier whose text has drifted from the
    // queued body (whitespace, upstream reformatting) still has an
    // unambiguous target, and requiring exact text everywhere would strand it.
    const queued = backgroundCommand('solo', 'solo-id')
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: queued, timestamp: '1' })
    state = applyQueueOperation(state, {
      operation: 'remove',
      content: `${queued}\nappended upstream noise`,
      timestamp: '2',
    })

    expect(state.pending).toEqual([])
    expect(state.decisions[0]!.reason).toBe('consumed-observed')
  })

  it('leaves remove debt untouched when popAll names an absent item', () => {
    // Mirror of applyRemove's redelivery guard: a content-bearing carrier is
    // its own proof, so a miss must be a conservative no-op rather than
    // permission to settle the older debt by inference.
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: 'kept', timestamp: '1' })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '2' })
    const beforePop = state

    state = applyQueueOperation(state, {
      operation: 'popAll',
      content: 'never queued here',
      timestamp: '3',
    })

    expect(state).toBe(beforePop)
    expect(state.removeDebt?.count).toBe(1)
    expect(state.pending.map(i => i.content)).toEqual(['kept'])
  })

  it('still takes the priority winner when no notification is queued', () => {
    // With no ambiguity the attachment-drain rule applies unchanged.
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: 'first', timestamp: '1' })
    state = applyQueueOperation(state, { operation: 'enqueue', content: 'second', timestamp: '2' })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '3' })
    state = markStaleWhenIdle(state, true)

    expect(state.pending.map(i => i.content)).toEqual(['second'])
  })
})

describe('dequeue is settled by identity, not inference', () => {
  it('removes the item the committed entry actually carries', () => {
    // Ordering here is the real transcript ordering (fixture
    // remove-is-not-persisted.json): enqueue, dequeue, then the committed
    // `user` entry carrying the notification verbatim.
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: agentFinished('first', 'id-first'),
      timestamp: '1',
    })
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: agentFinished('second', 'id-second'),
      timestamp: '2',
    })
    state = applyQueueOperation(state, { operation: 'dequeue', timestamp: '3' })
    // Claude delivered the SECOND one. Cohort order would have picked the first.
    state = applyCommittedUserEntry(state, {
      uuid: 'u1',
      text: agentFinished('second', 'id-second'),
    })

    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]!.content).toContain('id-first')
    expect(state.decisions).toEqual([
      expect.objectContaining({ reason: 'delivered-observed', evidence: ['u1'] }),
    ])
  })

  it('falls back to the cohort rule when no entry claims the dequeue', () => {
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: backgroundCommand('x'),
      timestamp: '1',
    })
    state = applyQueueOperation(state, { operation: 'dequeue', timestamp: '2' })
    state = applyCommittedUserEntry(state, { uuid: 'a', text: 'unrelated turn' })
    state = applyCommittedUserEntry(state, { uuid: 'b', text: 'another unrelated turn' })

    expect(state.pending).toEqual([])
    expect(state.decisions.map(d => d.reason)).toEqual(['delivered-inferred'])
    expect(state.decisions[0]!.evidence).toEqual([])
  })

  it('does not accept a bare task-id mention as proof of delivery', () => {
    // A subagent's task-id also appears in Task tool blocks. Counting that as
    // a delivery would remove a still-pending item.
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: agentFinished('audit', 'id-audit'),
      timestamp: '1',
    })
    state = applyQueueOperation(state, { operation: 'dequeue', timestamp: '2' })
    state = applyCommittedUserEntry(state, { uuid: 'u', text: 'see task id-audit for details' })

    expect(state.decisions.map(d => d.reason)).not.toContain('delivered-observed')
  })

  it('accumulates a multi-item dequeue run and settles each by identity', () => {
    let state = createClaudeQueueState()
    for (const n of ['one', 'two', 'three']) {
      state = applyQueueOperation(state, {
        operation: 'enqueue',
        content: agentFinished(n, `id-${n}`),
        timestamp: n,
      })
    }
    state = applyQueueOperation(state, { operation: 'dequeue', timestamp: 'd1' })
    state = applyQueueOperation(state, { operation: 'dequeue', timestamp: 'd2' })
    state = applyCommittedUserEntry(state, { uuid: 'x', text: agentFinished('three', 'id-three') })
    state = applyCommittedUserEntry(state, { uuid: 'y', text: agentFinished('two', 'id-two') })

    expect(state.pending.map(i => i.content.match(/<task-id>([^<]+)/)![1])).toEqual(['id-one'])
    expect(state.decisions.every(d => d.reason === 'delivered-observed')).toBe(true)
  })
})

describe('popAll', () => {
  it('removes the popped prompt by logged content and leaves notifications', () => {
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: agentFinished('keep', 'id-keep'),
      timestamp: '1',
    })
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: 'edit this prompt later',
      timestamp: '2',
    })
    state = applyQueueOperation(state, {
      operation: 'popAll',
      content: 'edit this prompt later',
      timestamp: '3',
    })

    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]!.content).toContain('Agent "keep" finished')
    expect(state.decisions.map(d => d.reason)).toEqual(['popped-to-composer'])
  })
})

describe('reference stability (D11)', () => {
  it('returns the same state object when an operation changes nothing', () => {
    const base = createClaudeQueueState()
    expect(applyQueueOperation(base, { operation: 'dequeue' })).toBe(base)
    expect(applyQueueOperation(base, { operation: 'enqueue' })).toBe(base)
    expect(applyQueueOperation(base, { operation: 'wat-is-this' })).toBe(base)
    expect(applyCommittedUserEntry(base, { text: 'hello' })).toBe(base)
    expect(markStaleWhenIdle(base, false)).toBe(base)
  })

  it('ignores a redelivered enqueue record', () => {
    let state = createClaudeQueueState()
    const op = { operation: 'enqueue', content: 'hello', timestamp: 't1' }
    state = applyQueueOperation(state, op)
    const afterFirst = state
    state = applyQueueOperation(state, op)
    expect(state).toBe(afterFirst)
  })
})

describe('stale marking', () => {
  it('marks unattributed residue instead of deleting it', () => {
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: backgroundCommand('gone'),
      timestamp: '1',
    })
    state = applyQueueOperation(state, {
      operation: 'enqueue',
      content: agentFinished('orphan'),
      timestamp: '2',
    })
    state = applyQueueOperation(state, { operation: 'remove', timestamp: '3' })
    state = markStaleWhenIdle(state, true)

    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]!.stale).toBe(true)
    expect(state.decisions.map(d => d.reason)).toContain('stale-unattributed')
  })

  it('does not mark a queue that has never seen a departure', () => {
    let state = createClaudeQueueState()
    state = applyQueueOperation(state, { operation: 'enqueue', content: 'waiting', timestamp: '1' })
    expect(markStaleWhenIdle(state, true)).toBe(state)
  })
})

describe('recorded corpus replay', () => {
  // Every fixture is an agent-code session: the corpus is published, so it
  // draws only on this repository's own transcripts, with free-typed prompt
  // text replaced by stable synthetic tokens (identically on both sides of a
  // delivery, so matching behaviour is unchanged). See catalog.md.
  //
  // NOTE: there is deliberately no `popAll` fixture. No agent-code session in
  // the local corpus contains one — the single recorded sighting was in an
  // unrelated project and is not publishable. `popAll` is covered by the
  // synthetic case above; if an agent-code session ever produces one, add it.
  const CASES = [
    'divergence-stranded-background-commands',
    'divergence-agent-dominant',
    'remove-dominant-balanced-mix',
    'remove-is-not-persisted',
    'exact-remove-after-open-dequeue-debt',
  ] as const

  it.each(CASES)('%s conserves every minted item exactly once', slug => {
    const state = replay(loadFixture(slug).events)

    // EXACT conservation, not a bound. `nextSeq` counts items actually minted
    // by `applyEnqueue` (after its redelivery guard), and every one of them
    // must be either still pending or accounted for by exactly one REMOVAL
    // decision. `stale-unattributed` is excluded because it marks an item in
    // place rather than removing it.
    //
    // WHY an identity and not the inequalities this test used to assert:
    // `pending <= enqueued` and `decisions <= departures + pending` both hold
    // by construction for any implementation that does not invent items —
    // including one that removes nothing at all. They were satisfied with 10–80×
    // margin and could not fail. This equation fails on a double-removal, on an
    // invented item, and on a leak.
    const removals = state.decisions.filter(d => d.reason !== 'stale-unattributed')
    expect(state.pending.length + removals.length).toBe(state.nextSeq)
  })

  it.each(CASES)('%s leaves no item that can never be retired', slug => {
    const state = replay(loadFixture(slug).events)

    // Slash commands were excluded from BOTH drains, so nothing could ever
    // remove them: one recorded session ended holding eleven identical `/loop`
    // prompts and a `/model`, which the strip renders as "12 queued" forever.
    // Upstream dequeues them individually (queueProcessor), so they are
    // eligible for the dequeue cohort — this asserts the residue is gone.
    const unretirable = state.pending.filter(i => i.isSlashCommand)
    expect(unretirable.map(i => i.content.slice(0, 40))).toEqual([])
  })

  it('does not strand background commands in the background-dominant session', () => {
    // The reported bug's own signature, on the session that exhibits it most
    // heavily (147 background notifications vs 16 agent). Asserted as an exact
    // count, on the fixture where the claim is load-bearing.
    const state = replay(loadFixture('divergence-stranded-background-commands').events)
    const stranded = state.pending.filter(i => i.content.includes('Background command'))
    expect(stranded.map(i => i.content.slice(0, 60))).toEqual([])
  })

  it('does not over-drain the later cohort when agent completions dominate', () => {
    // The mirror case. Over-eager removal would empty this queue; the guard is
    // that whatever remains is genuinely un-departed, which the conservation
    // identity above already pins — here we assert the shape is not degenerate.
    const state = replay(loadFixture('divergence-agent-dominant').events)
    expect(state.decisions.length).toBeGreaterThan(0)
    expect(state.pending.length).toBeLessThan(state.nextSeq)
  })


  it('proves the dequeue/remove asymmetry on the recorded session', () => {
    const state = replay(loadFixture('remove-is-not-persisted').events)
    const reasons = new Set(state.decisions.map(d => d.reason))
    // Both evidence paths must actually fire in real data — if one never does,
    // the corresponding branch is untested by the corpus and this suite is
    // asserting less than it appears to.
    expect(reasons).toContain('delivered-observed')
    expect(reasons).toContain('consumed-inferred')
  })
})
