import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { applyConditionSnapshot } from '@renderer/session-runtime/conditions'

// The ONE fold from a provider-conditions snapshot to a runtime.
//
// It had no direct test at all. The review of #1083 showed that dropping the
// picker projection from the live `session:conditions` handler — the original
// and, again, only producer — left the whole suite green, and that hardcoding
// the picker kind instead of reading provider policy did too. Both are here
// now, because `conditions` and `picker` are two projections of ONE snapshot
// and must never be written apart: a composer showing a slash picker the
// conditions say is gone is a UI that disagrees with itself.

const snapshot = (kinds: Record<string, unknown>, provider: 'claude' | 'codex' = 'claude') => ({
  provider, ts: 1_000,
  conditions: Object.fromEntries(Object.entries(kinds).map(([kind, state]) => [kind, { kind, state, actions: [] }])),
})

const picker = { visible: true, items: [{ name: '/clear', description: 'clear', selected: true }] }

describe('applyConditionSnapshot', () => {
  it('projects the composer picker out of the snapshot that carries it', () => {
    const next = applyConditionSnapshot(emptyRuntime(), snapshot({ 'claude.slash-picker': picker }) as never)
    expect(next.picker).toEqual(picker)
    expect(next.conditions).toMatchObject({ provider: 'claude' })
  })

  it('CLEARS the picker when the snapshot no longer carries one', () => {
    // Absence means "not live". The legacy sticky fallback was deliberately
    // removed: a picker that outlived its condition kept capturing the
    // composer's arrow keys.
    const open = applyConditionSnapshot(emptyRuntime(), snapshot({ 'claude.slash-picker': picker }) as never)
    const closed = applyConditionSnapshot(open, snapshot({}) as never)
    expect(closed.picker).toEqual({ visible: false, items: [] })
  })

  it('reads the picker kind from provider policy, not a hardcoded name', () => {
    // Codex has no composer picker. A hardcoded `claude.slash-picker` lookup
    // would quietly project one for any provider whose snapshot happened to
    // carry that key, and would miss the next provider that names its own.
    const next = applyConditionSnapshot(emptyRuntime(), snapshot({ 'claude.slash-picker': picker }, 'codex') as never)
    expect(next.picker).toEqual({ visible: false, items: [] })
    expect(next.conditions).toMatchObject({ provider: 'codex' })
  })

  it('keeps every other runtime field it was handed', () => {
    const before = { ...emptyRuntime(), draftInput: 'half a prompt', totalEntries: 12 }
    const next = applyConditionSnapshot(before, snapshot({}) as never)
    expect(next).toMatchObject({ draftInput: 'half a prompt', totalEntries: 12 })
  })
})
