import { describe, expect, it } from 'vitest'

import { buildFrameDocument, childFrameCsp } from '@main/extensions/frameDocument.js'

// Guards for the extension frame's containment boundary. Every case here is a defect
// an adversarial review actually demonstrated against this file — they are regression
// locks, not hypotheticals.

const base = {
  extensionId: 'victim',
  viewId: 'victim.main',
  entry: 'dist/index.js',
  nonce: 'test-nonce',
}

/** Every inline <script> body in the document. */
function scriptBodies(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
}

describe('childFrameCsp', () => {
  it('names the extension origin explicitly and never the bare scheme', () => {
    const csp = childFrameCsp('n', 'alpha')
    // A bare `agent-code-ext:` scheme-source matches EVERY extension's origin. Since
    // 'self' already covers the document's own origin, the bare scheme would grant
    // only the cross-extension case — letting one extension fetch and execute another's
    // bundle.
    expect(csp).not.toMatch(/(^|[; ])agent-code-ext:(?!\/\/)/)
    expect(csp).toContain('agent-code-ext://alpha')
  })

  it('sets base-uri and form-action, which do NOT fall back to default-src', () => {
    const csp = childFrameCsp('n', 'alpha')
    // Without base-uri, an injected <base> repoints the bootstrap's relative import().
    // Without form-action, a form POST is an egress channel connect-src cannot see.
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('does not allow another extension origin', () => {
    expect(childFrameCsp('n', 'alpha')).not.toContain('agent-code-ext://beta')
  })
})

describe('buildFrameDocument', () => {
  it('cannot be escaped by a </script> payload in viewId or entry', () => {
    // This exact payload passes every one of the manifest schema's path refinements:
    // not absolute, no backslash, no `..` segment, ends in .js, under 256 chars.
    const payload = 'a</script><script src="agent-code-ext://evil/p.js"></script>b.js'
    const html = buildFrameDocument({ ...base, viewId: payload, entry: payload })

    // Exactly two script elements: the JSON config island and the nonced bootstrap.
    expect(scriptBodies(html)).toHaveLength(2)
    expect(html).not.toContain('<script src="agent-code-ext://evil/p.js">')
  })

  it('round-trips the config values through the JSON island', () => {
    const html = buildFrameDocument(base)
    const island = html.match(
      /<script type="application\/json" id="agent-code-ext-cfg">([\s\S]*?)<\/script>/,
    )
    expect(island).not.toBeNull()
    const cfg = JSON.parse(island![1]) as Record<string, string>
    expect(cfg.viewId).toBe(base.viewId)
    expect(cfg.entry).toBe(base.entry)
    // Only what the bootstrap actually reads. A `parentOrigin` was carried here
    // and never used; a required, attacker-supplied, unused field reads as a
    // security control that is doing nothing.
    expect(Object.keys(cfg).sort()).toEqual(['entry', 'viewId'])
  })

  it('escapes < in the config island so no value can open or close an element', () => {
    const html = buildFrameDocument({ ...base, viewId: 'x<y' })
    const island = html.match(
      /<script type="application\/json" id="agent-code-ext-cfg">([\s\S]*?)<\/script>/,
    )!
    expect(island[1]).not.toContain('<')
    // …and JSON.parse still reads it back exactly.
    expect((JSON.parse(island[1]) as { viewId: string }).viewId).toBe('x<y')
  })

  it('emits a bootstrap that parses as JavaScript', () => {
    // The bootstrap is a string in main and is never type-checked; a syntax error
    // would only ever surface inside a live frame.
    const bodies = scriptBodies(buildFrameDocument(base))
    const bootstrap = bodies.find(b => !b.trim().startsWith('{'))!
    expect(() => new Function(bootstrap)).not.toThrow()
  })

  it('carries the per-origin CSP in the document meta tag too', () => {
    const html = buildFrameDocument({ ...base, extensionId: 'alpha' })
    expect(html).toContain('agent-code-ext://alpha')
  })
})
