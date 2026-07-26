import { describe, expect, it, vi } from 'vitest'

import {
  closeConfirmationFor,
  describePartialClose,
  runCloseConfirmationGate,
  grantStillMatches,
  expandSessionCloseTargets,
  expandTabCloseTargets,
  narrowGrantToCurrent,
} from '@renderer/workspace/closeConfirmation'
import type { CloseTargetSnapshot } from '@renderer/workspace/closeConfirmation'

const target = (id: string, live = false): CloseTargetSnapshot => ({
  sessionId: id,
  title: `Agent ${id}`,
  live,
})

describe('close confirmation policy', () => {
  it('does not confirm an idle single close', () => {
    // The common case stays cheap precisely because it is the one Undo Close
    // genuinely covers. A dialog here would fire dozens of times an hour.
    expect(closeConfirmationFor([target('a')])).toEqual({ required: false })
  })

  it('confirms a single session that is still working', () => {
    const result = closeConfirmationFor([target('a', true)])
    expect(result).toMatchObject({ required: true, reason: 'running' })
    if (result.required) expect(result.summary).toContain('still working')
  })

  it('confirms any multi-target close and names the exact count', () => {
    // The audit's finding: a close that expanded from one row to four looked
    // identical to closing one.
    const result = closeConfirmationFor([target('a'), target('b'), target('c')])
    expect(result.required).toBe(true)
    if (result.required) {
      expect(result.summary).toContain('3 sessions')
      expect(result.targets).toHaveLength(3)
    }
  })

  it('reports how many of a cascade are still working', () => {
    const result = closeConfirmationFor([target('a', true), target('b'), target('c', true)])
    expect(result.required).toBe(true)
    if (result.required) {
      expect(result.reason).toBe('multi')
      expect(result.summary).toContain('2 still working')
    }
  })

  it('requires nothing for an empty target set', () => {
    expect(closeConfirmationFor([])).toEqual({ required: false })
  })
})

describe('grant validity', () => {
  it('accepts an unchanged target set', () => {
    const granted = [target('a'), target('b')]
    expect(grantStillMatches(granted, [target('a'), target('b')])).toBe(true)
  })

  it('rejects a set with the same COUNT but different members', () => {
    // The case a count check waves through: two agents finish and two new ones
    // spawn, so the number matches while every target changed.
    const granted = [target('a'), target('b')]
    expect(grantStillMatches(granted, [target('c'), target('d')])).toBe(false)
  })

  it('rejects a grown or shrunk set', () => {
    const granted = [target('a'), target('b')]
    expect(grantStillMatches(granted, [target('a')])).toBe(false)
    expect(grantStillMatches(granted, [target('a'), target('b'), target('c')])).toBe(false)
  })
})

describe('narrowing a stale grant', () => {
  it('keeps the targets that are still present', () => {
    // Killing the ten that did not change is the useful behaviour; the two
    // that did must be dropped, not killed on the old preview's authority.
    const granted = [target('a'), target('b'), target('c')]
    const current = [target('a'), target('c')]
    expect(narrowGrantToCurrent(granted, current).map(t => t.sessionId)).toEqual(['a', 'c'])
  })

  it('drops a target that started working since the grant', () => {
    // The user approved closing an IDLE agent. One that woke up is outside
    // what they authorized, even though its id is unchanged.
    const granted = [target('a'), target('b')]
    const current = [target('a'), target('b', true)]
    expect(narrowGrantToCurrent(granted, current).map(t => t.sessionId)).toEqual(['a'])
  })

  it('keeps a target that was already live when granted', () => {
    // The user saw and approved this one as running, so it stays covered.
    const granted = [target('a', true)]
    const current = [target('a', true)]
    expect(narrowGrantToCurrent(granted, current)).toHaveLength(1)
  })

  it('returns nothing when every target changed', () => {
    expect(narrowGrantToCurrent([target('a')], [target('b')])).toEqual([])
  })
})

describe('partial close reporting', () => {
  it('says nothing when everything succeeded', () => {
    expect(describePartialClose({ closed: ['a', 'b'], failed: [], skipped: [] })).toBeNull()
  })

  it('reports failures and skips separately', () => {
    // They mean different things: a failure is a backend problem worth
    // retrying, a skip is the grant correctly refusing to cover new work.
    const message = describePartialClose({
      closed: ['a'],
      failed: [{ sessionId: 'b', error: new Error('kill failed') }],
      skipped: ['c'],
    })
    expect(message).toContain('Closed 1')
    expect(message).toContain('1 failed')
    expect(message).toContain('1 skipped')
  })
})

describe('target expansion', () => {
  const state = {
    sessions: {
      parent: { title: 'Parent' },
      child: { title: 'Child', linkedParentId: 'parent' },
      grandchild: { title: 'Grandchild', linkedParentId: 'child' },
      unrelated: { title: 'Unrelated' },
      detached: { title: 'Detached' },
    },
  }

  it('expands linked descendants transitively', () => {
    // A linked child can itself have linked children. Stopping at one level
    // would under-report the cascade in exactly the deep case where the count
    // matters most.
    const ids = expandSessionCloseTargets(state, {}, 'parent').map(t => t.sessionId)
    expect(ids.sort()).toEqual(['child', 'grandchild', 'parent'])
  })

  it('does not sweep in unrelated sessions', () => {
    const ids = expandSessionCloseTargets(state, {}, 'parent').map(t => t.sessionId)
    expect(ids).not.toContain('unrelated')
  })

  it('survives a malformed parent cycle instead of hanging', () => {
    // Guarding with a visited set rather than trusting the data to be a tree:
    // an infinite loop here would freeze the app on a close.
    const cyclic = {
      sessions: {
        a: { title: 'A', linkedParentId: 'b' },
        b: { title: 'B', linkedParentId: 'a' },
      },
    }
    const ids = expandSessionCloseTargets(cyclic, {}, 'a').map(t => t.sessionId)
    expect(ids.sort()).toEqual(['a', 'b'])
  })

  it('marks a running session live', () => {
    const runtimes = { parent: { sessionStatus: 'running' } }
    expect(expandSessionCloseTargets(state, runtimes, 'parent')[0].live).toBe(true)
  })

  it('marks a mid-stream session live even when not running', () => {
    // Both signals matter, and they are the SAME pair CloseOldAgentsModal uses
    // — so its preview and this confirmation cannot disagree about who is busy.
    const runtimes = { parent: { streamPhase: 'delta' } }
    expect(expandSessionCloseTargets(state, runtimes, 'parent')[0].live).toBe(true)
  })

  it('treats an idle stream phase as not live', () => {
    const runtimes = { parent: { sessionStatus: 'idle', streamPhase: 'idle' } }
    expect(expandSessionCloseTargets(state, runtimes, 'parent')[0].live).toBe(false)
  })

  it('includes a tab detached sessions alongside its grid leaves', () => {
    // The ones people forget: a detached session has no tile in the tab the
    // user is looking at, so a tab close that takes six background agents with
    // it looks like closing an empty tab.
    const targets = expandTabCloseTargets(state, {}, ['parent'], ['detached'])
    expect(targets.map(t => t.sessionId).sort()).toEqual([
      'child', 'detached', 'grandchild', 'parent',
    ])
  })

  it('does not double-count a session reachable two ways', () => {
    const targets = expandTabCloseTargets(state, {}, ['parent', 'child'], [])
    expect(targets).toHaveLength(3)
  })

  it('turns a cascade into a confirmation that names the count', () => {
    // The end-to-end point of expansion: closing ONE pane confirms as three.
    const targets = expandSessionCloseTargets(state, {}, 'parent')
    const result = closeConfirmationFor(targets)
    expect(result.required).toBe(true)
    if (result.required) expect(result.summary).toContain('3 sessions')
  })
})

// ---------------------------------------------------------------------------
// Forced confirmation, for closes a MODEL initiated.
//
// This is what replaced the main-side close-grant store. That store was the
// right idea in the wrong layer: a grant must be issued by a user action, main
// has no user action meaning "the user asked this agent to close that agent",
// so nothing ever issued one and every close_agent call was denied. The tool
// was 100% broken and every test passed, because the tests only ever exercised
// the store — never the fact that nobody fed it.
//
// The lesson these cases pin: an authorization mechanism has to be tested
// end-to-end from a real caller, or it tests only itself.
// ---------------------------------------------------------------------------
describe('forced close confirmation', () => {
  const idleSingle = [{ sessionId: 's1', title: 'Reviewer', live: false }]

  it('asks about an idle single close that the policy would wave through', async () => {
    // The idle-single exemption is about a human aiming at a pane they can see,
    // with Undo Close behind them. None of that is true when a model decides.
    expect(closeConfirmationFor(idleSingle).required).toBe(false)

    const ask = vi.fn().mockResolvedValue(true)
    const outcome = await runCloseConfirmationGate({
      enumerate: () => [...idleSingle],
      ask,
      force: { headline: 'Agent “Coordinator” is asking to close this agent.' },
    })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({
      required: true,
      reason: 'irreversible',
    })
    // The headline is not decoration. A dialog the user did not summon has to
    // say who summoned it, or it is unanswerable.
    expect(ask.mock.calls[0][0].summary).toContain('Coordinator')
    expect(outcome).toMatchObject({ ok: true, prompted: true })
  })

  it('refuses when the user declines', async () => {
    const outcome = await runCloseConfirmationGate({
      enumerate: () => [...idleSingle],
      ask: vi.fn().mockResolvedValue(false),
      force: { headline: 'An agent is asking to close this agent.' },
    })
    expect(outcome).toEqual({ ok: false, reason: 'declined' })
  })

  it('still re-validates the approved set', async () => {
    // Forcing the prompt must not skip the second enumeration — a model-driven
    // close is the case where the workspace is LEAST likely to be holding still.
    let call = 0
    const outcome = await runCloseConfirmationGate({
      enumerate: () => (call++ === 0 ? [...idleSingle] : [{ sessionId: 'other', title: 'X', live: false }]),
      ask: vi.fn().mockResolvedValue(true),
      force: { headline: 'An agent is asking to close this agent.' },
    })
    expect(outcome).toEqual({ ok: false, reason: 'changed' })
  })

  it('does not invent a dialog when there is nothing to close', async () => {
    const ask = vi.fn()
    const outcome = await runCloseConfirmationGate({
      enumerate: () => [],
      ask,
      force: { headline: 'An agent is asking to close this agent.' },
    })
    expect(ask).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: true, prompted: false })
  })
})
