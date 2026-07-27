import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  recognizeImageNode,
  recognizeResultParts,
  sidecarImageMetadata,
} from '@providers/shared/renderer/protocols/media/imageAttachment'

// Stage D of docs/decomposition/image-read-base64-dump.md.
//
// WHY every input here is loaded from disk instead of written inline: these
// assertions were written BEFORE imageAttachment.ts existed, against records
// captured verbatim from real sessions (see testing/fixtures/image-reads/MANIFEST.md).
// A test whose input is a literal someone typed proves only that the code does
// what its author imagined; it cannot fail for a shape the author did not think
// of. Each fixture below is a shape that actually occurred, cited back to the
// census row and the source session that produced it.
//
// If one of these fails, the fixture is right and the code is wrong. Do not
// adjust an expectation to match new behaviour without first confirming against
// the source record named in the fixture's `$fixture.source`.

const FIXTURE_DIR = join(process.cwd(), 'testing/fixtures/image-reads')

type Fixture = {
  $fixture: {
    id: string
    censusRows: number[]
    source: string
    proves: string
    substitutions: { path: string; originalChars: number; mime: string }[]
    totalOriginalPayloadChars: number
  }
  entry: Record<string, unknown>
}

function fixture(id: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.json`), 'utf8')) as Fixture
}

function allFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture)
}

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
  it('every fixture is traceable to a census row and a real session', () => {
    for (const f of allFixtures()) {
      expect(f.$fixture.censusRows.length).toBeGreaterThan(0)
      expect(f.$fixture.source).toMatch(/\.jsonl:\d+$/)
      expect(f.$fixture.proves.length).toBeGreaterThan(0)
    }
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
