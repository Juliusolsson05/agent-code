import { describe, expect, it } from 'vitest'

import {
  closeConfirmationFor,
  describePartialClose,
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
