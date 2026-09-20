import { describe, expect, it } from 'vitest'

import {
  recognizeImageNode,
  recognizeResultParts,
  sidecarImageMetadata,
} from '@providers/shared/renderer/protocols/media/imageAttachment'
import {
  CORPUS_ROOTS,
  loadImageFixture as fixture,
  loadImageFixtures as allFixtures,
  malformedCitations,
  unreachableCitations,
  type ImageFixture as Fixture,
} from '@providers/shared/renderer/protocols/media/imageFixtureProvenance'

// Stage D of docs/decomposition/image-read-base64-dump.md.
//
// WHY the POSITIVE assertions all load their input from disk: they were written
// BEFORE imageAttachment.ts existed, against records captured verbatim from real
// sessions (see testing/fixtures/image-reads/MANIFEST.md). A test whose input is
// a literal someone typed proves only that the code does what its author
// imagined; it cannot fail for a shape the author did not think of. Each fixture
// is a shape that actually occurred, cited back to its census row.
//
// The NEGATIVE assertions ("what must not be recognized") are deliberately
// handwritten literals, and that is not a lapse: they describe inputs the
// recognizer must REJECT, which by definition are not in a corpus of things it
// accepted. One of them — the tool-schema node — is transcribed from census row
// 12, which is a real recorded false positive.
//
// If one of these fails, the fixture is right and the code is wrong. Do not
// adjust an expectation to match new behaviour without first confirming against
// the source record named in the fixture's `$fixture.source`.

describe('recognizeResultParts — Codex exec output (the reported bug)', () => {
  it('preserves the text/image interleaving verbatim', () => {
    // The single most important assertion in this file. The exec output array is
    // text(header), text(path), image, text(path), image, text(path), image — the
    // text parts are the FILENAMES labelling each image. Any implementation that
    // flattens to a string and then strips base64 leaves three orphaned paths
    // above three unlabelled images. Position is meaning here, so the shape of
    // the assertion is the ordered kind sequence, not a set of contents.
    const f = fixture('codex-exec-interleaved-three-images')
    const output = (f.entry.payload as Record<string, unknown>).output

    const parts = recognizeResultParts(output)

    expect(parts).not.toBeNull()
    expect(parts!.map(p => p.kind)).toEqual([
      'text', 'text', 'image', 'text', 'image', 'text', 'image',
    ])
  })

  it('carries each image with its own declared MIME, in order', () => {
    const f = fixture('codex-exec-interleaved-three-images')
    const output = (f.entry.payload as Record<string, unknown>).output

    const images = recognizeResultParts(output)!.filter(p => p.kind === 'image')

    // jpeg, jpeg, png — from the real record. A recognizer that assumed one MIME
    // per result, or that inferred PNG from the substituted bytes, fails here.
    expect(images.map(p => p.kind === 'image' && p.image.mimeType)).toEqual([
      'image/jpeg', 'image/jpeg', 'image/png',
    ])
  })

  it('keeps the filename text parts adjacent to their images', () => {
    const f = fixture('codex-exec-interleaved-three-images')
    const output = (f.entry.payload as Record<string, unknown>).output

    const parts = recognizeResultParts(output)!

    // The part immediately before each image is that image's path.
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].kind !== 'image') continue
      const before = parts[i - 1]
      expect(before.kind).toBe('text')
      expect(before.kind === 'text' && before.text).toMatch(/\.(jpg|jpeg|png)$/i)
    }
  })

  it('strips the data-URL prefix so the payload is raw base64', () => {
    // base64MediaDataUrl() reconstructs `data:<mime>;base64,<data>` when a
    // disclosure opens. If the recognizer left the prefix on, that would produce
    // `data:image/png;base64,data:image/png;base64,…` and paint nothing.
    const f = fixture('codex-exec-interleaved-three-images')
    const output = (f.entry.payload as Record<string, unknown>).output

    const first = recognizeResultParts(output)!.find(p => p.kind === 'image')

    expect(first).toBeDefined()
    expect(first!.kind === 'image' && first!.image.data.startsWith('data:')).toBe(false)
    expect(first!.kind === 'image' && first!.image.data.length).toBeGreaterThan(0)
  })

  it('records detail when present, and tolerates its absence', () => {
    const withDetail = fixture('codex-exec-interleaved-three-images')
    const withoutDetail = fixture('codex-user-attachment-no-detail')

    const a = recognizeResultParts((withDetail.entry.payload as Record<string, unknown>).output)!
      .find(p => p.kind === 'image')
    const b = recognizeResultParts((withoutDetail.entry.payload as Record<string, unknown>).content)!
      .find(p => p.kind === 'image')

    expect(a!.kind === 'image' && a!.image.detail).toBe('high')
    // Census row 19 is the two-key variant: `{image_url, type}` with no `detail`.
    // A recognizer that required `detail` would silently drop every user
    // attachment — which is the vanish bug, not a fix for the dump bug.
    expect(b!.kind === 'image' && b!.image.detail).toBeUndefined()
  })

  it('handles the single-image exec case', () => {
    const f = fixture('codex-exec-single-image')
    const output = (f.entry.payload as Record<string, unknown>).output

    const parts = recognizeResultParts(output)!

    expect(parts.map(p => p.kind)).toEqual(['text', 'image'])
  })
})

describe('recognizeResultParts — Claude tool_result', () => {
  it('recognizes a native image block inside tool_result content', () => {
    const f = fixture('claude-tool-result-image-with-sidecar')
    const message = f.entry.message as Record<string, unknown>
    const toolResult = (message.content as Record<string, unknown>[])[0]

    const parts = recognizeResultParts(toolResult.content)!

    expect(parts.map(p => p.kind)).toEqual(['image'])
    expect(parts[0].kind === 'image' && parts[0].image.mimeType).toBe('image/jpeg')
    expect(parts[0].kind === 'image' && parts[0].image.origin).toBe('claude-native')
  })
})

describe('sidecarImageMetadata — the second source of truth', () => {
  it('reads dimensions and originalSize from toolUseResult.file', () => {
    // Decision recorded in the plan: the PAYLOAD comes from the tool_result
    // content block, the METADATA comes from this sidecar. The sidecar is the
    // only place dimensions and originalSize exist, and until this change
    // `toolUseResult` was referenced nowhere in the renderer at all.
    const f = fixture('claude-tool-result-image-with-sidecar')

    const meta = sidecarImageMetadata(f.entry.toolUseResult)!

    expect(meta.mimeType).toBe('image/jpeg')
    expect(meta.originalSize).toBe(874018)
    expect(meta.dimensions).toEqual({
      originalWidth: 2940,
      originalHeight: 1858,
      displayWidth: 2000,
      displayHeight: 1264,
    })
  })

  it('returns null for a toolUseResult that carries no image', () => {
    expect(sidecarImageMetadata({ filePath: '/x.ts', content: 'hello' })).toBeNull()
    expect(sidecarImageMetadata(null)).toBeNull()
    expect(sidecarImageMetadata('a string')).toBeNull()
  })
})

describe('recognizeImageNode — placement independence', () => {
  it('recognizes a Claude image block carried inside a Codex rollout', () => {
    // Cross-provider carriage. The session was switched provider mid-task, so
    // agent-transcript-parser preserved the Claude-shaped originals under
    // _atp.source while the Codex-side view kept only "[Image #4] [Image #5]".
    // The recognizer must key off the NODE, never off which provider owns the
    // file it was found in.
    const f = fixture('atp-claude-image-inside-codex-rollout')
    const atp = f.entry._atp as Record<string, unknown>
    const source = atp.source as Record<string, unknown>
    const message = source.message as Record<string, unknown>
    const blocks = message.content as Record<string, unknown>[]

    const images = blocks.map(recognizeImageNode).filter(Boolean)

    expect(images).toHaveLength(3)
    expect(images[0]!.origin).toBe('claude-native')
  })

  it('recognizes a Codex image carried inside a Claude transcript', () => {
    // The same carriage in the opposite direction, and a recorded data-loss
    // case: the Claude-side message.content for this entry is a single text
    // block reading "Script completed / Wall time 0.0 seconds / Output:" — the
    // image survives ONLY under _atp.source.
    const f = fixture('atp-codex-image-inside-claude-transcript')
    const atp = f.entry._atp as Record<string, unknown>
    const source = atp.source as Record<string, unknown>
    const payload = source.payload as Record<string, unknown>

    const parts = recognizeResultParts(payload.output)!

    expect(parts.map(p => p.kind)).toEqual(['text', 'image'])
    expect(parts[1].kind === 'image' && parts[1].image.origin).toBe('codex-data-url')
  })
})

describe('recognizeImageNode — what must NOT be recognized', () => {
  it('rejects a tool schema declaration that merely mentions image_url', () => {
    // Census row 12 is a false positive the generic walker found: Codex's exec
    // tool JSON-Schema declares its output item type as
    // {image_url, name, path, text, type}. It describes an image; it is not one.
    // A recognizer that keys off "has an image_url property" would render the
    // schema as a broken image.
    const schemaNode = {
      image_url: { type: 'string' },
      name: { type: 'string' },
      path: { type: 'string' },
      text: { type: 'string' },
      type: { type: 'string' },
    }

    expect(recognizeImageNode(schemaNode)).toBeNull()
  })

  it('rejects a non-data image_url', () => {
    // Remote URLs need a different loading and security policy than an inline
    // payload (CSP, network egress from the renderer). Silently treating one as
    // the other is how a feed starts making outbound requests.
    expect(recognizeImageNode({ type: 'input_image', image_url: 'https://example.com/a.png' })).toBeNull()
  })

  it('rejects an image block whose source is not base64', () => {
    expect(recognizeImageNode({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } })).toBeNull()
  })

  it('returns null for content with no images at all', () => {
    // The overwhelmingly common case. Returning null (rather than an array of
    // text parts) is the signal that lets every existing consumer keep its
    // current string fast path untouched — no extra allocation per render for
    // the 99.9% of tool results that are plain text.
    expect(recognizeResultParts('plain string output')).toBeNull()
    expect(recognizeResultParts([{ type: 'input_text', text: 'hello' }])).toBeNull()
    expect(recognizeResultParts([])).toBeNull()
    expect(recognizeResultParts(null)).toBeNull()
  })
})

describe('corpus-wide invariants', () => {
  it('every fixture cites a census row and a well-formed session line', () => {
    // #901. This used to assert that every cited session still EXISTED, as
    // soon as either corpus root did — so a developer whose old transcripts
    // had rotated away could not get a green `npm test`, and `npm run check`
    // was blocked for work that had nothing to do with these fixtures. Nothing
    // was wrong with the fixtures; the gate was reading the machine.
    //
    // `docs/testing/standard.md`: reading a developer's home directory is LIVE
    // behaviour and needs an explicit opt-in variable on top of `test:live`.
    // "The directory happens to be there" is not an opt-in. The reachability
    // half now lives in imageAttachment.live.test.ts.
    expect(malformedCitations(allFixtures())).toEqual([])
  })

  it('every fixture cites a session inside a provider corpus, so the live check has something to check', () => {
    // Machine-INDEPENDENT, which the first version of this control was not:
    // it matched against `CORPUS_ROOTS`, which embed `homedir()`, so on CI —
    // and on any second developer's machine — nothing matched, every fixture
    // was skipped, and the assertion read `expected [] to have a length of 7`.
    // A live suite that passes vacuously everywhere but one laptop is worse
    // than no live suite, so `unreachableCitations` now matches on the
    // provider directory SEGMENTS and this pins the property it relies on.
    const missingEverything = unreachableCitations(allFixtures(), () => false)
    expect(missingEverything).toHaveLength(allFixtures().length)
    expect(missingEverything.every(problem => problem.reason.includes('missing session'))).toBe(true)
  })

  // The positive controls. "No problems reported" is also what a check that
  // reports nothing would say, and five mutations proved exactly that: the
  // assertions above passed with the census-row rule deleted, the `proves`
  // rule deleted, the line number no longer parsed, and the whole function
  // returning an empty list.
  //
  // These inputs are hand-built on purpose, for the same reason the negative
  // assertions at the top of this file are: they describe fixtures the check
  // must REJECT, which by definition are not in a corpus of ones it accepted.
  describe('what the provenance check must reject', () => {
    const broken = (over: Partial<Fixture['$fixture']>): Fixture => ({
      $fixture: {
        id: 'synthetic',
        censusRows: [1],
        source: `${CORPUS_ROOTS.claude}/p/session.jsonl:42`,
        proves: 'something',
        substitutions: [],
        totalOriginalPayloadChars: 0,
        ...over,
      },
      entry: {},
    })

    it.each([
      { what: 'no census row', over: { censusRows: [] }, reason: 'cites no census row' },
      { what: 'nothing claimed proved', over: { proves: '' }, reason: 'claims to prove nothing' },
      { what: 'a citation with no line', over: { source: `${CORPUS_ROOTS.claude}/p/session.jsonl` }, reason: 'source is not' },
      { what: 'a citation with a zero line', over: { source: `${CORPUS_ROOTS.claude}/p/session.jsonl:0` }, reason: 'source is not' },
      { what: 'a citation that is not a transcript', over: { source: `${CORPUS_ROOTS.claude}/p/session.txt:1` }, reason: 'source is not' },
    ])('rejects $what', ({ over, reason }) => {
      const problems = malformedCitations([broken(over)])
      expect(problems).toHaveLength(1)
      expect(problems[0]!.reason).toContain(reason)
    })

    it('ignores a citation outside any provider corpus, which was never a corpus session', () => {
      const elsewhere = broken({ source: '/somewhere/else/session.jsonl:7' })
      expect(malformedCitations([elsewhere])).toEqual([])
      expect(unreachableCitations([elsewhere], () => false)).toEqual([])
    })

    it('flags a missing session under ANY home directory, not just the extractor\'s', () => {
      // The direct statement of what CI caught: the check keys on the
      // provider's directory names, which are the same everywhere, not on the
      // absolute path of whoever happened to record the fixtures.
      const foreign = broken({ source: '/home/someone-else/.codex/sessions/2026/s.jsonl:3' })
      expect(unreachableCitations([foreign], () => false)).toHaveLength(1)
      expect(unreachableCitations([foreign], () => true)).toEqual([])
    })
  })

  it('records the real payload size that was substituted away', () => {
    // The fixtures carry a 1×1 PNG in place of the real bytes, but the ORIGINAL
    // length is preserved as an assertable number. That is what keeps the size
    // dimension of this corpus honest: the largest single image really was
    // 1,777,026 characters, and the admission cap in base64.ts is tested against
    // that recorded fact rather than against a number someone chose.
    const f = fixture('codex-exec-interleaved-three-images')

    expect(f.$fixture.totalOriginalPayloadChars).toBe(2408700)
    expect(Math.max(...f.$fixture.substitutions.map(s => s.originalChars))).toBe(1777026)
  })
})
