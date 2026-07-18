import { describe, expect, it } from 'vitest'

import {
  defineRenderShape,
  defineRenderShapeCatalog,
  type RenderShapeCatalog,
  type RenderShapeDefinition,
} from '@renderer/rendering/evidence/defineRenderShape'

// The catalog contract is mostly COMPILE-time (provider-prefixed ids,
// key↔id equality via the mapped type). Runtime tests cover the belt that
// types cannot see, plus pin the `keyof typeof` id-derivation pattern the
// per-provider shapes.ts files will rely on.

const claudeEdit = defineRenderShape({
  id: 'claude.edit.v1',
  provider: 'claude',
  fingerprints: ['fp2-00000001'],
  eventTypes: ['tool_use'],
  planes: ['committed-tool-use'],
  lifecycles: ['input-complete', 'result-complete'],
  observed: {
    providerVersions: ['2.1.0'],
    models: ['claude-opus-4-8'],
    firstSeen: '2026-07-16',
    lastSeen: '2026-07-16',
  },
  fixtures: { final: ['claude/edit-v1/final.json'], prefixes: [] },
  disposition: { kind: 'planned', targetGrammar: 'code-edit' },
  why: 'test fixture entry',
})

describe('defineRenderShape / defineRenderShapeCatalog', () => {
  it('returns the definition unchanged (identity helper)', () => {
    expect(claudeEdit.id).toBe('claude.edit.v1')
    expect(claudeEdit.provider).toBe('claude')
  })

  it('accepts a consistent catalog and preserves keyof typeof id derivation', () => {
    const catalog = defineRenderShapeCatalog('claude', {
      'claude.edit.v1': claudeEdit,
    })
    type Id = keyof typeof catalog
    const id: Id = 'claude.edit.v1'
    expect(catalog[id].disposition.kind).toBe('planned')
    // And the bare-satisfies form the plan shows stays valid:
    const bare = { 'claude.edit.v1': claudeEdit } as const satisfies RenderShapeCatalog<'claude'>
    expect(Object.keys(bare)).toEqual(['claude.edit.v1'])
  })

  it('throws when a runtime id disagrees with its catalog key', () => {
    const wrongId = { ...claudeEdit, id: 'claude.write.v1' } as RenderShapeDefinition<'claude'>
    expect(() =>
      defineRenderShapeCatalog('claude', {
        // Cast simulates the spread/computed-literal hole the mapped type
        // cannot check — the runtime belt must catch it.
        'claude.edit.v1': wrongId as never,
      }),
    ).toThrow(/key and id must be identical/)
  })

  it('throws when an entry declares a foreign provider', () => {
    const foreign = {
      ...claudeEdit,
      id: 'codex.edit.v1',
      provider: 'codex',
    } as unknown as RenderShapeDefinition<'claude'>
    expect(() =>
      defineRenderShapeCatalog('claude', { 'codex.edit.v1': foreign as never }),
    ).toThrow(/provider "codex" inside the "claude" catalog/)
  })
})
