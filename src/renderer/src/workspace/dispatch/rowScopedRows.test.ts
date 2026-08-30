import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  buildVisibleDispatchRows,
  resolveDispatchSpawnTarget,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  ORCHESTRATION_CHILD_CAP,
  rowScopedRows,
} from '@renderer/workspace/dispatch/rowScopedRows'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

// What ONE grid row shows: the canonical dispatch rows, filtered to that row's
// project and collapsed at that row's child density.
//
// Built on the real persisted workspace because the two things most easily got
// wrong here are properties of real data, not of a hand-built list: the
// canonical labels (which must survive filtering with GAPS, never renumber) and
// the parent/child nesting produced by orchestration.
const FIXTURE = JSON.parse(
  readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'),
) as { state: WorkspaceState }

const GLOBAL_ROWS = buildVisibleDispatchRows({
  ...FIXTURE.state,
  dispatchMode: { ...FIXTURE.state.dispatchMode!, scope: 'global' },
})

const labels = (items: ReturnType<typeof rowScopedRows>): string[] =>
  items.map(item => (item.kind === 'agent' ? item.row.label : `[${item.kind}:${item.hidden ?? 0}]`))

/** A synthetic parent with `count` children, appended to a real row list. */
function withFanOut(count: number): DispatchAgentRow[] {
  const parent = GLOBAL_ROWS.find(row => row.depth === 0)!
  return [
    ...GLOBAL_ROWS,
    { ...parent, key: 'p', label: 'Z1', sessionId: 'parent' as SessionId, depth: 0 },
    ...Array.from({ length: count }, (_, i) => ({
      ...parent,
      key: `c${i}`,
      label: `Z${i + 2}`,
      sessionId: `child-${i}` as SessionId,
      depth: 1,
    })),
  ]
}

describe('project binding', () => {
  it('passes every row through when the grid row is unbound', () => {
    const items = rowScopedRows(GLOBAL_ROWS, {})

    expect(items).toHaveLength(GLOBAL_ROWS.length)
  })

  it('keeps only the bound project s agents', () => {
    const tabId = GLOBAL_ROWS[0]!.tabId
    const items = rowScopedRows(GLOBAL_ROWS, { projectTabId: tabId })

    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThan(GLOBAL_ROWS.length)
    for (const item of items) {
      if (item.kind === 'agent') expect(item.row.tabId).toBe(tabId)
    }
  })

  it('preserves canonical labels with gaps instead of renumbering', () => {
    // THE drift class. buildVisibleDispatchRows assigns labels in one canonical
    // order that cmd+N, command targeting, and every rendered surface must
    // agree on. A filtered row showing "D1, D2" while cmd+N still means the
    // global D12/D15 would make the highlighted chip and the acted-on session
    // different agents.
    const lastTab = GLOBAL_ROWS[GLOBAL_ROWS.length - 1]!.tabId
    const items = rowScopedRows(GLOBAL_ROWS, { projectTabId: lastTab })
    const shown = items.flatMap(item => (item.kind === 'agent' ? [item.row] : []))

    for (const row of shown) {
      const canonical = GLOBAL_ROWS.find(candidate => candidate.sessionId === row.sessionId)
      expect(row.label).toBe(canonical!.label)
      expect(row.globalIndex).toBe(canonical!.globalIndex)
    }
    // Gapped, not 1..n — proof nothing renumbered.
    expect(shown[0]!.globalIndex).toBeGreaterThan(1)
  })
})

describe('orchestration child cap', () => {
  it('leaves the recorded workspace untouched', () => {
    // The real recording has three parents with two children each, which is
    // BELOW the cap. This asserts the honest state of the evidence: on every
    // shape this repository has actually recorded, the cap is inert. If a
    // future recording contains a real fan-out, this test is where it lands.
    const capped = rowScopedRows(GLOBAL_ROWS, {})
    const uncapped = rowScopedRows(GLOBAL_ROWS, { capChildren: false })

    expect(capped).toEqual(uncapped)
    expect(capped.every(item => item.kind === 'agent')).toBe(true)
  })

  it('collapses a parent whose children exceed the cap', () => {
    const items = rowScopedRows(withFanOut(10), {})
    const shown = labels(items)

    // Parent, then exactly CAP children, then one marker standing for the rest.
    expect(shown).toContain('Z1')
    expect(shown.filter(label => /^Z(?!1$)/.test(label))).toHaveLength(ORCHESTRATION_CHILD_CAP)
    expect(shown).toContain(`[more:${10 - ORCHESTRATION_CHILD_CAP}]`)
  })

  it('never hides a top-level agent, however many there are', () => {
    // The parent reports; the children are workers. A list that hides the thing
    // being reported is worse than a long list.
    const items = rowScopedRows(withFanOut(10), {})
    const shownTopLevel = items.filter(item => item.kind === 'agent' && item.row.depth === 0)

    expect(shownTopLevel).toHaveLength(GLOBAL_ROWS.filter(r => r.depth === 0).length + 1)
  })

  it('shows every child of a parent the user expanded, and offers to re-collapse', () => {
    const items = rowScopedRows(withFanOut(10), { expandedParents: ['parent' as SessionId] })
    const shown = labels(items)

    expect(shown.filter(label => /^Z(?!1$)/.test(label))).toHaveLength(10)
    expect(shown).toContain('[fewer:0]')
  })

  it('expands only the named parent', () => {
    const rows = [
      ...withFanOut(10),
      { ...GLOBAL_ROWS[0]!, key: 'p2', label: 'Y1', sessionId: 'other' as SessionId, depth: 0 },
      ...Array.from({ length: 8 }, (_, i) => ({
        ...GLOBAL_ROWS[0]!,
        key: `o${i}`,
        label: `Y${i + 2}`,
        sessionId: `other-${i}` as SessionId,
        depth: 1,
      })),
    ]
    const shown = labels(rowScopedRows(rows, { expandedParents: ['parent' as SessionId] }))

    expect(shown.filter(label => /^Z(?!1$)/.test(label))).toHaveLength(10)
    expect(shown.filter(label => /^Y(?!1$)/.test(label))).toHaveLength(ORCHESTRATION_CHILD_CAP)
  })

  it('does not cap a child that renders as a top-level row', () => {
    // U2, resolved rather than merely flagged. buildDispatchGroups emits a
    // child at depth 0 when its parent is absent from the group — a scope
    // filter, a closed parent, or a PINNED parent (pins are pulled into their
    // own section). Such a row is visually indistinguishable from an ordinary
    // agent: it carries its own label and sits at the top level.
    //
    // Hiding it under a "+N more" belonging to a parent the user cannot see
    // would be strictly worse than showing it. So the cap follows VISUAL
    // nesting, and an orphaned child is correctly not capped — the depth rule
    // is right, not merely convenient.
    const orphans = Array.from({ length: 9 }, (_, i) => ({
      ...GLOBAL_ROWS[0]!,
      key: `orphan${i}`,
      label: `W${i + 1}`,
      sessionId: `orphan-${i}` as SessionId,
      depth: 0,
    }))
    const items = rowScopedRows([...GLOBAL_ROWS, ...orphans], {})

    expect(items.filter(item => item.kind !== 'agent')).toHaveLength(0)
    expect(labels(items).filter(label => label.startsWith('W'))).toHaveLength(9)
  })

  it('applies the cap after the project filter, not before', () => {
    // Order matters: filtering to a project can remove a parent's siblings but
    // never its children, so capping first would count children that the row
    // does not even show.
    const fanOut = withFanOut(10)
    const boundTab = fanOut[fanOut.length - 1]!.tabId
    const items = rowScopedRows(fanOut, { projectTabId: boundTab })

    for (const item of items) {
      if (item.kind === 'agent') expect(item.row.tabId).toBe(boundTab)
    }
    expect(items.some(item => item.kind === 'more')).toBe(true)
  })
})

describe('spawning into a bound row', () => {
  // A new agent created from an empty lane in a bound row belongs to that row's
  // project. Falling back to classic focus or activeTabId would file it under a
  // project the row does not even list, in a slot the row's own index cannot
  // then offer.
  it('files a new agent under the focused row s project', () => {
    // Deliberately a project that is NOT the active tab — that is the whole
    // point: the binding has to outrank the activeTabId fallback.
    const boundTab = GLOBAL_ROWS.find(row => row.tabId !== FIXTURE.state.activeTabId)!.tabId
    const state: WorkspaceState = {
      ...FIXTURE.state,
      dispatchMode: {
        ...FIXTURE.state.dispatchMode!,
        scope: 'global',
        // Empty focused lane, so there is no lane session to read the project
        // from — exactly the case that used to fall through to activeTabId.
        tiled: {
          lanes: [{}],
          rows: [{ length: 1, projectTabId: boundTab }],
          focusedLane: 0,
        },
      },
    }

    expect(boundTab).not.toBe(FIXTURE.state.activeTabId)
    expect(resolveDispatchSpawnTarget(state).tabId).toBe(boundTab)
  })

  it('still falls back to the active tab for an unbound row', () => {
    const state: WorkspaceState = {
      ...FIXTURE.state,
      dispatchMode: {
        ...FIXTURE.state.dispatchMode!,
        scope: 'global',
        focusedSessionId: undefined,
        tiled: { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 },
      },
    }

    expect(resolveDispatchSpawnTarget(state).tabId).toBe(FIXTURE.state.activeTabId)
  })
})
