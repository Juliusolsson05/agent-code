import { describe, expect, it } from 'vitest'

import {
  canReplaceMismatchedLiveTurn,
  FOLD_POLICY,
  isClaimableEmptyShell,
  isTerminalYieldReady,
  type LiveTurnFacts,
} from '@renderer/rendering/policy/foldPolicy'

// ---------------------------------------------------------------------------
// Parity tests for the absorbed yield hatches. Every case below is a
// documented legacy behavior (foldEvent.ts + the 2026-05-16 bundles) —
// these pin the POLICY encoding to the exact literal behavior it replaced.
// ---------------------------------------------------------------------------

const codex = FOLD_POLICY.codex

const turn = (over: Partial<LiveTurnFacts>): LiveTurnFacts => ({
  source: 'proxy',
  endedAtMs: null,
  textLength: 0,
  blocks: [],
  ...over,
})

describe('fold policy — terminal-yield hatch (2026-05-16T19:08 class)', () => {
  it('yields when every known block is terminal, even without turn_completed', () => {
    const t = turn({
      blocks: [
        { finalized: true }, // completed message
        { status: 'completed' }, // completed function_call — the "pending tool" trap
      ],
    })
    expect(isTerminalYieldReady(codex, t)).toBe(true)
    expect(canReplaceMismatchedLiveTurn(codex, t, 'proxy')).toBe(true)
  })

  it('hybrid terminal markers count (18:42 class: finalized OR status completed)', () => {
    expect(isTerminalYieldReady(codex, turn({ blocks: [{ finalized: true, status: 'completed' }] }))).toBe(true)
    expect(isTerminalYieldReady(codex, turn({ blocks: [{ status: 'in_progress' }] }))).toBe(false)
  })

  it('does NOT yield while any block is still streaming (flicker defense)', () => {
    const streaming = turn({ blocks: [{ finalized: true }, { status: 'in_progress' }], textLength: 40 })
    expect(canReplaceMismatchedLiveTurn(codex, streaming, 'proxy')).toBe(false)
  })

  it('only sources in terminalYieldSources are eligible', () => {
    expect(isTerminalYieldReady(codex, turn({ source: 'screen', blocks: [{ finalized: true }] }))).toBe(false)
    // opencode encodes the hatch as EMPTY policy, not inherited behavior.
    expect(
      isTerminalYieldReady(FOLD_POLICY.opencode, turn({ source: 'opencode-sse', blocks: [{ finalized: true }] })),
    ).toBe(false)
  })
})

describe('fold policy — empty-shell hatch (rollout placeholder class)', () => {
  it('proxy may claim an empty non-proxy shell', () => {
    const shell = turn({ source: 'rollout' })
    expect(isClaimableEmptyShell(codex, shell)).toBe(true)
    expect(canReplaceMismatchedLiveTurn(codex, shell, 'proxy')).toBe(true)
  })

  it('a content-bearing non-proxy turn keeps full flicker protection', () => {
    expect(isClaimableEmptyShell(codex, turn({ source: 'rollout', textLength: 12 }))).toBe(false)
    expect(isClaimableEmptyShell(codex, turn({ source: 'rollout', blocks: [{}] }))).toBe(false)
  })

  it('an empty PROXY shell is not claimable through this hatch', () => {
    expect(isClaimableEmptyShell(codex, turn({ source: 'proxy' }))).toBe(false)
  })
})

describe('fold policy — shared replacement rules', () => {
  it('ended turns are replaceable for every provider (MCP next-turn lifecycle)', () => {
    for (const p of [FOLD_POLICY.claude, FOLD_POLICY.codex, FOLD_POLICY.opencode]) {
      expect(canReplaceMismatchedLiveTurn(p, turn({ endedAtMs: 123, textLength: 50 }), null)).toBe(true)
    }
  })

  it('untrusted event sources never displace a live turn', () => {
    const t = turn({ blocks: [{ finalized: true }] })
    expect(canReplaceMismatchedLiveTurn(codex, t, 'screen')).toBe(false)
    expect(canReplaceMismatchedLiveTurn(codex, t, null)).toBe(false)
  })
})
