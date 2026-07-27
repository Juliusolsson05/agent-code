import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { codexOutputText, codexResultContent } from '@providers/codex/renderer/transcript/entries'
import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

// Stage G of docs/decomposition/image-read-base64-dump.md — the structural guard.
//
// Stages E and F fix the four node shapes the census found. This file is the
// only artifact that constrains the FIFTH — the shape a provider ships next
// month. Without it we are back to enumerate-and-patch, and the census expires
// the day it was written.
//
// The invariant is deliberately blunt and shape-agnostic: **no base64 run of
// 200+ characters may reach feed text, for any fixture, through any path.** It
// does not care how an image is encoded or where it sits. A new provider shape
// that this codebase does not recognize will still be caught the moment its
// payload reaches a string.

const FIXTURE_DIR = join(process.cwd(), 'testing/fixtures/image-reads')

// Matches a run of base64-alphabet characters long enough to be a payload rather
// than an id, a hash, or a path segment. 200 is comfortably above the longest
// incidental run in the corpora (uuids, call_ids, git sha values) and far below
// the shortest real image (the smallest recorded payload is 22,124 chars).
const BASE64_RUN = /[A-Za-z0-9+/=]{200,}/

type Fixture = {
  $fixture: {
    id: string
    source: string
    substitutions: { path: string; originalChars: number; mime: string }[]
    totalOriginalPayloadChars: number
  }
  entry: Record<string, unknown>
}

function fixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture)
}

/**
 * Restore each payload to the LENGTH it really had, in memory, for this test only.
 *
 * WHY this is necessary and not paranoia: the checked-in fixtures carry a 1×1
 * PNG (~100 chars) in place of the real bytes, which is BELOW this file's
 * 200-char detection threshold. Without re-inflation the escape guard cannot
 * fail — verified by deliberately disabling the recognizer's codex-data-url
 * branch and watching the structural tests go red while this one stayed green.
 * A guard that cannot fail is worse than no guard, because it reads as coverage.
 *
 * The fixture records `originalChars` for every substitution, so the real size
 * is recoverable exactly. The filler is a repeated base64-alphabet character:
 * the guard is checking that no long payload-shaped run reaches feed text, and
 * for that question the bytes are irrelevant but the LENGTH is the whole point.
 */
function inflate(fixture: Fixture): Fixture {
  const sizes = fixture.$fixture.substitutions.map(s => s.originalChars)
  let index = 0
  const grow = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(grow)
    if (typeof value !== 'object' || value === null) return value
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const isPayload =
        (key === 'image_url' && typeof child === 'string' && child.startsWith('data:')) ||
        ((key === 'data' || key === 'base64') && typeof child === 'string' && child.length > 32)
      if (isPayload && index < sizes.length) {
        const size = sizes[index]
        index += 1
        const filler = 'A'.repeat(Math.max(size, 1))
        out[key] = key === 'image_url'
          ? `${(child as string).slice(0, (child as string).indexOf(',') + 1)}${filler}`
          : filler
        continue
      }
      out[key] = grow(child)
    }
    return out
  }
  return { ...fixture, entry: grow(fixture.entry) as Record<string, unknown> }
}

/** Every string a fixture could put in front of a user, from every text path. */
function textProjections(fixture: Fixture): string[] {
  const out: string[] = []
  const payload = fixture.entry.payload as Record<string, unknown> | undefined

  if (payload?.output !== undefined) {
    out.push(codexOutputText(payload.output))
    const content = codexResultContent(payload.output)
    out.push(typeof content === 'string' ? content : toolResultContentText(content))
  }
  if (payload?.content !== undefined) {
    const content = codexResultContent(payload.content)
    out.push(typeof content === 'string' ? content : toolResultContentText(content))
  }

  // Claude-shaped: run every tool_result block through the shared flattener.
  const message = fixture.entry.message as Record<string, unknown> | undefined
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    const record = block as Record<string, unknown>
    if (record?.type === 'tool_result') {
      out.push(toolResultContentText(record.content as never))
    }
  }
  return out
}

describe('no base64 escapes into feed text', () => {
  for (const fixture of fixtures()) {
    it(`${fixture.$fixture.id}: every text projection is payload-free`, () => {
      // Inflated to real recorded sizes — see inflate() for why the committed
      // 1×1 payloads cannot exercise this assertion.
      for (const projection of textProjections(inflate(fixture))) {
        const leak = BASE64_RUN.exec(projection)
        expect(
          leak === null,
          leak
            ? `a ${leak[0].length}-char base64 run reached feed text from ${fixture.$fixture.source}`
            : '',
        ).toBe(true)
      }
    })
  }
})

describe('codexResultContent — structure survives the mapping boundary', () => {
  it('returns ordered blocks for the interleaved exec result', () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'codex-exec-interleaved-three-images.json'), 'utf8'),
    ) as Fixture
    const payload = fixture.entry.payload as Record<string, unknown>

    const content = codexResultContent(payload.output)

    expect(Array.isArray(content)).toBe(true)
    expect((content as { type: string }[]).map(b => b.type)).toEqual([
      'text', 'text', 'image', 'text', 'image', 'text', 'image',
    ])
  })

  it('returns a plain string for text-only output, byte-identical to before', () => {
    // The regression guard for the 99.9% case. Every corpus fixture and every
    // existing consumer depends on the plain-text path being untouched; if this
    // drifts, the bundle and recording corpora move for reasons unrelated to
    // images.
    const output = [
      { type: 'input_text', text: 'Script completed' },
      { type: 'input_text', text: 'Output:' },
    ]

    expect(codexResultContent(output)).toBe(codexOutputText(output))
    expect(codexResultContent(output)).toBe('Script completed\nOutput:')
  })
})

describe('rollout mapping — the reported bug end to end', () => {
  it('maps an exec image result to a tool_result carrying image blocks', () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'codex-exec-interleaved-three-images.json'), 'utf8'),
    ) as Fixture

    const entries = mapCodexRolloutToFeedEntries(fixture.entry)
    const message = entries[0]?.message as Record<string, unknown>
    const blocks = message.content as Record<string, unknown>[]
    const toolResult = blocks[0]

    expect(toolResult.type).toBe('tool_result')
    expect(Array.isArray(toolResult.content)).toBe(true)
    expect((toolResult.content as { type: string }[]).filter(b => b.type === 'image')).toHaveLength(3)
  })

  it('no longer drops a Codex user attachment', () => {
    // Census row 19. Before this change `input_image` in message content hit the
    // mapper's `return null` and the user's attachment vanished silently.
    const fixture = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'codex-user-attachment-no-detail.json'), 'utf8'),
    ) as Fixture

    const entries = mapCodexRolloutToFeedEntries(fixture.entry)
    const message = entries[0]?.message as Record<string, unknown>
    const blocks = message.content as Record<string, unknown>[]

    expect(blocks.filter(b => b.type === 'image')).toHaveLength(1)
  })
})
