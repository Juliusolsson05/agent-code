import { describe, expect, it } from 'vitest'

import { buildFrameDocument, childFrameCsp } from '@main/extensions/frameDocument.js'

// Guards for the extension frame's containment boundary. Every case here is a defect
// an adversarial review actually demonstrated against this file — they are regression
// locks, not hypotheticals.

const base = {
  extensionId: 'victim',
  viewId: 'victim.main',
  entry: 'dist/index.js',
  declaredCommands: ['victim.start'],
  declaredViews: ['victim.main'],
  nonce: 'test-nonce',
}

/** Every inline <script> body in the document. */
function scriptBodies(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
}

/**
 * ── THE ASSERTION THAT WOULD HAVE CAUGHT A SHIPPED, TOTAL FAILURE ──
 *
 * The bootstrap contained a literal script closing tag inside one of its own
 * comments — the comment explaining how a closing tag breaks the document quoted
 * the payload verbatim. An HTML tokenizer ends a script element at the first
 * `</script` it sees with no regard for JavaScript context, so in a real browser
 * the frame's module script terminated after ~300 characters of comment and the
 * entire runtime — the API proxy, mount, the dynamic import, teardown — became
 * inert text in the body. No extension frame could ever have worked.
 *
 * Nothing caught it. Source review does not surface it (the file is valid
 * TypeScript and the string is valid JavaScript), the existing "parses as
 * JavaScript" test passed because `new Function` on a comment-only prefix parses
 * fine, and `scriptBodies` above is itself non-greedy, so every assertion built on
 * it was quietly examining a truncated prefix.
 *
 * This checks the property directly on the emitted document: the number of closing
 * tags must equal the number of opening tags. One extra means some script body
 * contains a close tag, which means that script is truncated in a browser.
 */
function assertNoPrematureScriptClose(html: string): void {
  const opens = (html.match(/<script/g) ?? []).length
  const closes = (html.match(/<\/script>/g) ?? []).length
  expect(closes).toBe(opens)
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
    const cfg = JSON.parse(island![1]) as Record<string, unknown>
    expect(cfg.viewId).toBe(base.viewId)
    expect(cfg.entry).toBe(base.entry)
    // Only what the bootstrap actually reads. A `parentOrigin` was carried here
    // and never used; a required, attacker-supplied, unused field reads as a
    // security control that is doing nothing.
    expect(Object.keys(cfg).sort()).toEqual([
      'declaredCommands',
      'declaredViews',
      'entry',
      'viewId',
    ])
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

describe('the declared-contributions contract', () => {
  it('carries the manifest\'s declared ids into the frame', () => {
    // The frame is the only place an extension registers anything, so it is the
    // only place that can reject an undeclared id. It cannot ask anyone — the ids
    // have to arrive with the document.
    const html = buildFrameDocument(base)
    const island = html.match(
      /<script type="application\/json" id="agent-code-ext-cfg">([\s\S]*?)<\/script>/,
    )!
    const cfg = JSON.parse(island[1]) as { declaredCommands: string[]; declaredViews: string[] }
    expect(cfg.declaredCommands).toEqual(['victim.start'])
    expect(cfg.declaredViews).toEqual(['victim.main'])
  })

  it('emits a bootstrap that refuses an undeclared registration', () => {
    // ── THE REGRESSION THIS PINS ──
    // The check lived in the host-realm ExtensionHost, which imported the module
    // and compared against the manifest it held. That host was deleted when
    // activation moved into the frame, and the check went with it silently — the
    // bootstrap just wrote into its maps, while the type, the module contract and
    // the authoring guide all still promised rejection. The failure it prevents is
    // invisible: a handler registered under an id the manifest does not declare can
    // never be invoked by anything, so a typo produced a command that did nothing,
    // with no error anywhere.
    const bootstrap = scriptBodies(buildFrameDocument(base)).find(
      body => !body.trim().startsWith('{'),
    )!
    expect(bootstrap).toContain('assertDeclared')
    expect(bootstrap).toContain('not declared in contributes.')
  })
})

describe('the emitted document is not truncated by its own contents', () => {
  it('has exactly one closing tag per script element', () => {
    assertNoPrematureScriptClose(buildFrameDocument(base))
  })

  it('stays intact for values that carry a closing tag', () => {
    // The config island escapes `<`, so even a hostile entry/viewId cannot add one.
    // This is the same payload the injection test uses, checked for a different
    // property: not "does it inject", but "does it truncate".
    const payload = 'a</scr' + 'ipt><scr' + 'ipt>b.js'
    assertNoPrematureScriptClose(buildFrameDocument({ ...base, viewId: payload, entry: payload }))
  })

  it('the module script survives to its final statement', () => {
    // The end of the bootstrap is the pagehide teardown. If the element is being cut
    // short anywhere, this is what notices — counting tags proves the document is
    // well-formed, and this proves the RUNTIME is whole.
    const html = buildFrameDocument(base)
    const moduleStart = html.indexOf('<script type="module"')
    const body = html.slice(moduleStart, html.indexOf('</script>', moduleStart))
    expect(body).toContain("addEventListener('pagehide'")
    expect(body).toContain("import('./' + ENTRY)")
  })
})