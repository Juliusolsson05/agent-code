import { describe, expect, it } from 'vitest'

import {
  fingerprintRenderShape,
  MAX_SHAPE_DEPTH,
  MAX_SHAPE_PATHS,
} from '@renderer/rendering/evidence/shapeFingerprint'

// Phase 1 exit gate (plan §Test-first delivery phases): the fingerprint is
// DETERMINISTIC, CONTENT-FREE, and stable under content churn. These tests
// are the executable spec — the fingerprint algorithm must not change once
// catalogs pin fingerprints, so every behavior asserted here is a frozen
// contract, not an implementation detail.

const base = {
  provider: 'claude' as const,
  plane: 'committed-tool-use' as const,
  eventType: 'tool_use',
}

describe('structural fingerprint — content independence (plan spine rule)', () => {
  it('same structure / different content → SAME fingerprint (Bash ls == Bash git status)', () => {
    const a = fingerprintRenderShape({
      ...base,
      payload: { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    })
    const b = fingerprintRenderShape({
      ...base,
      payload: {
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'git status --porcelain && echo done' },
      },
    })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('render-relevant discriminator change → DIFFERENT fingerprint (Bash vs Edit)', () => {
    const bash = fingerprintRenderShape({
      ...base,
      payload: { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    })
    // Same key structure under `input`? No — Edit has different input keys,
    // but even with IDENTICAL structure the top-level `name` discriminator
    // must split the shapes: the tool name selects the visual grammar.
    const edit = fingerprintRenderShape({
      ...base,
      payload: { type: 'tool_use', name: 'Edit', input: { command: 'ls' } },
    })
    expect(bash.fingerprint).not.toBe(edit.fingerprint)
  })

  it('nested type/kind/subtype discriminators split shapes (content blocks)', () => {
    const text = fingerprintRenderShape({
      ...base,
      payload: { content: [{ type: 'text', text: 'x' }] },
    })
    const image = fingerprintRenderShape({
      ...base,
      payload: { content: [{ type: 'image', text: 'x' }] },
    })
    expect(text.fingerprint).not.toBe(image.fingerprint)
  })

  it('key VALUE TYPE changes the fingerprint (typed paths, not key names alone)', () => {
    const str = fingerprintRenderShape({ ...base, payload: { value: 'x' } })
    const num = fingerprintRenderShape({ ...base, payload: { value: 3 } })
    const arr = fingerprintRenderShape({ ...base, payload: { value: ['x'] } })
    expect(new Set([str.fingerprint, num.fingerprint, arr.fingerprint]).size).toBe(3)
  })

  it('provider / plane / eventType are part of the identity', () => {
    const payload = { type: 'tool_use', name: 'Bash' }
    const claude = fingerprintRenderShape({ ...base, payload })
    const codex = fingerprintRenderShape({ ...base, provider: 'codex', payload })
    const result = fingerprintRenderShape({
      ...base,
      plane: 'committed-tool-result',
      payload,
    })
    const other = fingerprintRenderShape({ ...base, eventType: 'other', payload })
    expect(new Set([claude, codex, result, other].map(f => f.fingerprint)).size).toBe(4)
  })

  it('key order does not matter — canonical sort', () => {
    const a = fingerprintRenderShape({ ...base, payload: { b: 1, a: 'x', c: true } })
    const b = fingerprintRenderShape({ ...base, payload: { c: false, a: 'y', b: 9 } })
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})

describe('structural fingerprint — arrays', () => {
  it('array LENGTH does not change the fingerprint (1 todo == 40 todos)', () => {
    const one = fingerprintRenderShape({
      ...base,
      payload: { todos: [{ content: 'a', status: 'pending' }] },
    })
    const many = fingerprintRenderShape({
      ...base,
      payload: {
        todos: Array.from({ length: 40 }, (_, i) => ({
          content: `item ${i}`,
          status: 'pending',
        })),
      },
    })
    expect(one.fingerprint).toBe(many.fingerprint)
  })

  it('heterogeneous element structures MERGE into one element shape (union, order-free)', () => {
    const a = fingerprintRenderShape({
      ...base,
      payload: { content: [{ type: 'text' }, { type: 'text', citations: [] }] },
    })
    const b = fingerprintRenderShape({
      ...base,
      payload: { content: [{ type: 'text', citations: [] }, { type: 'text' }] },
    })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('empty array is a stable shape of its own', () => {
    const empty = fingerprintRenderShape({ ...base, payload: { items: [] } })
    const filled = fingerprintRenderShape({ ...base, payload: { items: [1] } })
    expect(empty.fingerprint).not.toBe(filled.fingerprint)
  })
})

describe('structural fingerprint — privacy (the hard invariant)', () => {
  it('no content value ever enters fingerprint/shapePaths/discriminators', () => {
    const secret = 'SECRET_PROMPT_DO_NOT_LEAK ' + 'x'.repeat(200)
    const out = fingerprintRenderShape({
      ...base,
      payload: {
        type: 'tool_use',
        name: 'Bash',
        input: { command: secret, cwd: '/Users/someone/private-project' },
      },
    })
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('SECRET_PROMPT')
    expect(serialized).not.toContain('private-project')
  })

  it('secret-keyed subtrees are dropped, key name retained (lockstep with unknowns.ts)', () => {
    const withSecret = fingerprintRenderShape({
      ...base,
      payload: { headers: { authorization: 'Bearer abc' }, ok: 1 },
    })
    expect(withSecret.shapePaths).toContain('headers.authorization=<redacted-key>')
    expect(JSON.stringify(withSecret)).not.toContain('Bearer')
    // The VALUE STRUCTURE under a secret key must not influence identity:
    // string token vs whole object under `authorization` → same shape.
    const withObjectSecret = fingerprintRenderShape({
      ...base,
      payload: { headers: { authorization: { scheme: 'Bearer', token: 'x' } }, ok: 1 },
    })
    expect(withSecret.fingerprint).toBe(withObjectSecret.fingerprint)
  })

  it('discriminators reject free-form values (paths, sentences, long tokens)', () => {
    const out = fingerprintRenderShape({
      ...base,
      payload: {
        type: 'tool_use',
        // `name` IS allowlisted at top level — but only token-like values
        // may be recorded. A path or sentence must be excluded, not carried.
        name: '/Users/someone/evil tool name with spaces',
      },
    })
    expect(JSON.stringify(out.discriminatorValues)).not.toContain('/Users')
  })

  it('top-level `toolName` splits semantic live blocks (session-runtime vocabulary)', () => {
    const bash = fingerprintRenderShape({
      ...base,
      plane: 'semantic-tool',
      payload: { kind: 'tool_use', toolName: 'Bash', inputJson: '{}' },
    })
    const edit = fingerprintRenderShape({
      ...base,
      plane: 'semantic-tool',
      payload: { kind: 'tool_use', toolName: 'Edit', inputJson: '{}' },
    })
    expect(bash.fingerprint).not.toBe(edit.fingerprint)
  })

  it('nested `name` is NOT a discriminator (MCP inputs put user values there)', () => {
    const a = fingerprintRenderShape({
      ...base,
      payload: { input: { name: 'alpha' } },
    })
    const b = fingerprintRenderShape({
      ...base,
      payload: { input: { name: 'beta' } },
    })
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})

describe('structural fingerprint — hostile/degenerate inputs never throw', () => {
  it('cycles terminate with a stable marker', () => {
    type Cyc = { type: string; self?: unknown }
    const cyc: Cyc = { type: 'loop' }
    cyc.self = cyc
    const a = fingerprintRenderShape({ ...base, payload: cyc })
    const b = fingerprintRenderShape({ ...base, payload: cyc })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.shapePaths.some(p => p.includes('<cycle>'))).toBe(true)
  })

  it('depth beyond the cap collapses to a marker instead of recursing forever', () => {
    // Build nesting twice the cap deep; identical prefixes within the cap
    // must fingerprint identically regardless of what lies beyond it.
    const deep = (n: number): unknown => (n === 0 ? 'leaf' : { d: deep(n - 1) })
    const a = fingerprintRenderShape({ ...base, payload: deep(MAX_SHAPE_DEPTH * 2) })
    const b = fingerprintRenderShape({ ...base, payload: deep(MAX_SHAPE_DEPTH * 3) })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('very wide objects are bounded by the path cap and stay deterministic', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < MAX_SHAPE_PATHS * 2; i++) wide[`k${String(i).padStart(6, '0')}`] = i
    const a = fingerprintRenderShape({ ...base, payload: wide })
    const b = fingerprintRenderShape({ ...base, payload: wide })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.shapePaths.length).toBeLessThanOrEqual(MAX_SHAPE_PATHS + 1) // +1 truncation marker
    expect(a.shapePaths[a.shapePaths.length - 1]).toBe('<truncated-paths>')
  })

  it('JSON parity: undefined-valued keys fingerprint as ABSENT, undefined elements as null', () => {
    // Runtime payloads arrive via structured clone (undefined survives);
    // the evidence corpus is JSON on disk (undefined keys dropped, undefined
    // elements → null). The SAME logical shape must fingerprint identically
    // from both sources or every live sighting of a seeded shape files as a
    // false unknown.
    const live = fingerprintRenderShape({
      ...base,
      payload: { kind: 'tool_use', finalized: undefined, items: [undefined] },
    })
    const fromDisk = fingerprintRenderShape({
      ...base,
      payload: JSON.parse(JSON.stringify({ kind: 'tool_use', finalized: undefined, items: [undefined] })),
    })
    expect(live.fingerprint).toBe(fromDisk.fingerprint)
    expect(live.shapePaths.some(p => p.startsWith('finalized'))).toBe(false)
  })

  it('unserializable leaves (function/symbol/bigint) become type markers', () => {
    const a = fingerprintRenderShape({
      ...base,
      payload: { fn: () => 'x', sym: Symbol('s'), big: 10n },
    })
    const b = fingerprintRenderShape({
      ...base,
      payload: { fn: (q: number) => q, sym: Symbol('other'), big: 99n },
    })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('non-object payloads (string/number/null/undefined) fingerprint by type, not value', () => {
    const s1 = fingerprintRenderShape({ ...base, payload: 'secret text' })
    const s2 = fingerprintRenderShape({ ...base, payload: 'other text' })
    const n = fingerprintRenderShape({ ...base, payload: 42 })
    const nil = fingerprintRenderShape({ ...base, payload: null })
    expect(s1.fingerprint).toBe(s2.fingerprint)
    expect(s1.fingerprint).not.toBe(n.fingerprint)
    expect(n.fingerprint).not.toBe(nil.fingerprint)
    expect(JSON.stringify(s1)).not.toContain('secret text')
  })
})
