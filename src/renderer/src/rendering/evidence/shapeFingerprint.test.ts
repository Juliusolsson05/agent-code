import { describe, expect, it } from 'vitest'

import {
  fingerprintRenderShape,
  MAX_ARRAY_ITEMS_SCANNED,
  MAX_OBJECT_KEYS_SCANNED,
  MAX_SHAPE_DEPTH,
  MAX_SHAPE_PATHS,
  MAX_VISITED_NODES,
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

  it('MIXED discriminator values under an array are order-free (review finding #1)', () => {
    // The regression the review panel proved: last-element-wins made
    // [text, tool_use] and [tool_use, text] different identities. The
    // sorted value-set union must make them ONE shape — a Claude assistant
    // message mixing text and tool_use blocks is among the most common
    // real payloads and providers reorder freely.
    const a = fingerprintRenderShape({
      ...base,
      payload: { content: [{ type: 'text' }, { type: 'tool_use' }] },
    })
    const b = fingerprintRenderShape({
      ...base,
      payload: { content: [{ type: 'tool_use' }, { type: 'text' }] },
    })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.discriminatorValues['content[].type']).toBe('text|tool_use')
  })

  it('retains dynamic object keys because dev evidence must preserve the actual observed structure', () => {
    // Codex patch results key `changes` by absolute path. The source session
    // recording already contains those paths; throwing them away only makes
    // the derived evidence unable to explain why two results routed apart.
    const a = fingerprintRenderShape({
      ...base,
      payload: { changes: { '/repo/a.ts': { add: 3 } } },
    })
    const b = fingerprintRenderShape({
      ...base,
      payload: { changes: { '/other/place/b.md': { add: 9 } } },
    })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.shapePaths).toContain('changes./repo/a.ts:object')
    expect(JSON.stringify(a)).toContain('/repo/a.ts')
  })

  it('empty array is a stable shape of its own', () => {
    const empty = fingerprintRenderShape({ ...base, payload: { items: [] } })
    const filled = fingerprintRenderShape({ ...base, payload: { items: [1] } })
    expect(empty.fingerprint).not.toBe(filled.fingerprint)
  })
})

describe('structural fingerprint — structural identity boundaries', () => {
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

  it('retains auth-looking keys and their value structure without copying scalar values', () => {
    const withSecret = fingerprintRenderShape({
      ...base,
      payload: { headers: { authorization: 'Bearer abc' }, ok: 1 },
    })
    expect(withSecret.shapePaths).toContain('headers.authorization:string')
    expect(JSON.stringify(withSecret)).not.toContain('Bearer')
    // String vs object is a real render/data shape distinction and dev-only
    // evidence deliberately captures it.
    const withObjectSecret = fingerprintRenderShape({
      ...base,
      payload: { headers: { authorization: { scheme: 'Bearer', token: 'x' } }, ok: 1 },
    })
    expect(withObjectSecret.shapePaths).toContain('headers.authorization.token:string')
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

  it('nested discriminators reject non-enum tokens (hex secrets, IDs) — review finding A4', () => {
    const hex = fingerprintRenderShape({
      ...base,
      payload: { input: { config: { type: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' } } },
    })
    // Value contains digits after a letter start — but real enums are short
    // lowercase snake; the 32-hex string exceeds the 32-char cap and fails.
    expect(JSON.stringify(hex.discriminatorValues)).not.toContain('a1b2c3d4e5f6')
    const camel = fingerprintRenderShape({
      ...base,
      payload: { input: { config: { type: 'MixedCaseInternalId' } } },
    })
    expect(JSON.stringify(camel.discriminatorValues)).not.toContain('MixedCase')
  })

  it('traversal work is bounded — a huge payload stops at MAX_VISITED_NODES with a marker', () => {
    const wide: Record<string, { a: number; b: number }> = {}
    for (let i = 0; i < MAX_VISITED_NODES; i++) wide[`k${i}`] = { a: 1, b: 2 }
    const started = performance.now()
    const out = fingerprintRenderShape({ ...base, payload: wide })
    expect(performance.now() - started).toBeLessThan(500)
    expect(out.shapePaths[out.shapePaths.length - 1]).toBe('<truncated-paths>')
    // Determinism holds under truncation.
    expect(fingerprintRenderShape({ ...base, payload: wide }).fingerprint).toBe(out.fingerprint)
  })

  it('safety-cap markers do not mint a second fingerprint identity', () => {
    const atPathBudget: Record<string, number> = {}
    // The root object itself consumes one path, so 511 leaves fill the 512
    // evidence-path budget exactly without tripping the marker.
    for (let i = 0; i < MAX_SHAPE_PATHS - 1; i++) {
      atPathBudget[`k${String(i).padStart(6, '0')}`] = i
    }
    const beyondPathBudget = { ...atPathBudget, k999999: 1 }
    const exact = fingerprintRenderShape({ ...base, payload: atPathBudget })
    const clipped = fingerprintRenderShape({ ...base, payload: beyondPathBudget })
    expect(exact.shapePaths).not.toContain('<truncated-paths>')
    expect(clipped.shapePaths).toContain('<truncated-paths>')
    expect(clipped.fingerprint).toBe(exact.fingerprint)

    const admittedArray = Array.from({ length: MAX_ARRAY_ITEMS_SCANNED }, () => ({ value: 1 }))
    const justBelowArray = admittedArray.slice(0, -1)
    const cappedArray = [...admittedArray, { value: 2 }]
    const justBelow = fingerprintRenderShape({ ...base, payload: { items: justBelowArray } })
    const admitted = fingerprintRenderShape({ ...base, payload: { items: admittedArray } })
    const capped = fingerprintRenderShape({ ...base, payload: { items: cappedArray } })
    expect(capped.shapePaths).toContain('<truncated-paths>')
    expect(admitted.fingerprint).toBe(justBelow.fingerprint)
    expect(capped.fingerprint).toBe(admitted.fingerprint)

    // Root object + array consume two visits; each repeated element below
    // consumes four. 999 elements stay just under the 4,000-node budget and
    // the thousandth trips it without introducing any new merged path.
    const repeated = () => ({ a: { b: { c: 1 } } })
    const underNodeBudget = Array.from({ length: Math.floor((MAX_VISITED_NODES - 2) / 4) }, repeated)
    const overNodeBudget = [...underNodeBudget, repeated()]
    const underNodes = fingerprintRenderShape({ ...base, payload: { items: underNodeBudget } })
    const overNodes = fingerprintRenderShape({ ...base, payload: { items: overNodeBudget } })
    expect(underNodes.shapePaths).not.toContain('<truncated-paths>')
    expect(overNodes.shapePaths).toContain('<truncated-paths>')
    expect(overNodes.fingerprint).toBe(underNodes.fingerprint)
  })

  it('non-structural sensitive keys use <dyn> in identity without merging stable schema keys', () => {
    const dynamicA = fingerprintRenderShape({
      ...base,
      payload: { headers: { '/tenant/a/secret-token': { value: 'secret' } } },
    })
    const dynamicB = fingerprintRenderShape({
      ...base,
      payload: { headers: { '/tenant/b/secret-token': { value: 'other secret' } } },
    })
    // Literal names remain useful in local developer evidence, but changing
    // only an open-world sensitive map key cannot churn checked-in catalog ids.
    expect(dynamicA.shapePaths).toContain('headers./tenant/a/secret-token:object')
    expect(dynamicB.shapePaths).toContain('headers./tenant/b/secret-token:object')
    expect(dynamicA.fingerprint).toBe(dynamicB.fingerprint)

    const authorization = fingerprintRenderShape({ ...base, payload: { authorization: 'x' } })
    const apiKey = fingerprintRenderShape({ ...base, payload: { api_key: 'x' } })
    expect(authorization.fingerprint).not.toBe(apiKey.fingerprint)
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

  it('token-shaped secrets in nested discriminator-named fields stay out of identity', () => {
    const hunter = fingerprintRenderShape({
      ...base,
      payload: { input: { type: 'hunter2' } },
    })
    const different = fingerprintRenderShape({
      ...base,
      payload: { input: { type: 'differentsecret' } },
    })
    expect(hunter.fingerprint).toBe(different.fingerprint)
    expect(JSON.stringify(hunter)).not.toContain('hunter2')

    // Reviewed provider enums still carry the structural split the renderer
    // actually branches on; only open-world token-shaped values are excluded.
    const text = fingerprintRenderShape({ ...base, payload: { content: [{ type: 'text' }] } })
    const toolUse = fingerprintRenderShape({
      ...base,
      payload: { content: [{ type: 'tool_use' }] },
    })
    expect(text.fingerprint).not.toBe(toolUse.fingerprint)
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

  it('wide-object identity is independent of insertion order at the local admission cap', () => {
    const ascending: Record<string, unknown> = {}
    const descending: Record<string, unknown> = {}
    const keys = Array.from(
      { length: MAX_OBJECT_KEYS_SCANNED + 1 },
      (_, index) => `key_${String(index).padStart(5, '0')}`,
    )
    for (const key of keys) ascending[key] = { value: 1 }
    for (const key of [...keys].reverse()) descending[key] = { value: 1 }

    const forward = fingerprintRenderShape({ ...base, payload: ascending })
    const reverse = fingerprintRenderShape({ ...base, payload: descending })

    // The diagnostic prefixes intentionally differ: they show what bounded
    // evidence was actually inspected. Catalog identity must not differ just
    // because insertion order moved one key across the safety cutoff.
    expect(forward.shapePaths).not.toEqual(reverse.shapePaths)
    expect(forward.shapePaths).toContain('<truncated-paths>')
    expect(reverse.shapePaths).toContain('<truncated-paths>')
    expect(forward.fingerprint).toBe(reverse.fingerprint)
  })

  it('wide-object collapse cannot be escaped by a capped sensitive or discriminator key', () => {
    const make = (specialFirst: boolean): Record<string, unknown> => {
      const record: Record<string, unknown> = {}
      if (specialFirst) {
        record.authorization = 'secret'
        record.kind = 'captured-kind'
      }
      for (let index = 0; index < MAX_OBJECT_KEYS_SCANNED + 2; index += 1) {
        record[`key_${String(index).padStart(5, '0')}`] = index
      }
      if (!specialFirst) {
        record.authorization = 'secret'
        record.kind = 'captured-kind'
      }
      return record
    }
    const admitted = fingerprintRenderShape({ ...base, payload: make(true) })
    const capped = fingerprintRenderShape({ ...base, payload: make(false) })
    expect(admitted.fingerprint).toBe(capped.fingerprint)
  })

  it('wide-array identity is independent of member order at the local admission cap', () => {
    const common = Array.from(
      { length: MAX_ARRAY_ITEMS_SCANNED },
      () => ({ kind: 'common', value: 1 }),
    )
    const distinct = { kind: 'distinct', extra: true }
    const distinctAtEnd = [...common, distinct]
    const distinctAtStart = [distinct, ...common]

    const tail = fingerprintRenderShape({ ...base, payload: { items: distinctAtEnd } })
    const head = fingerprintRenderShape({ ...base, payload: { items: distinctAtStart } })

    expect(tail.shapePaths).toContain('<truncated-paths>')
    expect(head.shapePaths).toContain('<truncated-paths>')
    expect(tail.fingerprint).toBe(head.fingerprint)
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
