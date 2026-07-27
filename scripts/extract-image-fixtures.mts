// extract-image-fixtures.mts — Stage C of docs/decomposition/image-read-base64-dump.md
//
// Pulls specific REAL records out of the local provider corpora and writes them
// to testing/fixtures/image-reads/ as replayable fixtures, with every base64
// payload swapped for a 1×1 PNG and the original length recorded beside it.
//
// WHY substitute the payload when the method says "do not clean up recordings"
// ---------------------------------------------------------------------------
// The methodology's rule is that fixtures must be causally independent of the
// implementer's beliefs — the ugliness of real data is the point, because the
// shapes you did not imagine are the ones that break you. That argument applies
// to STRUCTURE: key names, nesting, ordering, interleaving, MIME spelling,
// which sibling fields are present. It does not apply to the encoded bytes,
// because nothing in the rendering path ever decodes them. The pipeline branches
// on MIME, on payload LENGTH (the 8 MiB admission cap in
// protocols/media/base64.ts), and on envelope shape. It never looks at a pixel.
//
// Meanwhile the real payloads here are the user's building-permit drawings,
// personal photographs, and screenshots of private work, and this repository is
// public. Committing 80 MB of those to git to test a code path that cannot read
// them would be a straight loss. So: structure verbatim, ordering verbatim,
// sibling fields verbatim, MIME verbatim, original length recorded as an
// assertable number — payload substituted.
//
// The one thing this costs us is a fixture that would catch a bug in base64
// DECODING. There is no such code in the rendering path (the data URL is handed
// to the browser), so that is an acceptable trade. If decoding is ever added,
// this decision must be revisited — that is why this comment is this long.
//
// Usage: npx tsx scripts/extract-image-fixtures.mts

import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const HOME = homedir()
const OUT_DIR = join(process.cwd(), 'testing/fixtures/image-reads')

// A real, decodable 1×1 transparent PNG. Chosen over a placeholder string so a
// fixture stays a VALID data URL end to end — a test that renders one gets a
// working <img>, not a broken one, which keeps the renderer tests honest.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type FixtureSpec = {
  id: string
  /** Census rows (shape-census.md) this fixture is the evidence for. */
  censusRows: number[]
  file: string
  line: number
  /** Why this specific record was chosen — what it proves that others do not. */
  proves: string
}

// Each entry below cites a row in docs/decomposition/evidence/image-reads/shape-census.md.
// Between them these seven records cover all four distinct NODE shapes the census
// found, across every placement family: native Codex output, Codex user content,
// Claude tool_result, Claude's sidecar, and _atp cross-provider carriage in both
// directions.
const SPECS: FixtureSpec[] = [
  {
    id: 'codex-exec-interleaved-three-images',
    censusRows: [4, 8],
    file: join(HOME, '.codex/sessions/2026/07/23/rollout-2026-07-23T19-31-13-019f9008-09b5-7793-8222-307a8700791a.jsonl'),
    line: 68,
    proves:
      'THE reported bug. custom_tool_call_output from `exec` carrying text,image,text,image,text,image — ' +
      'the input_text parts are the filenames labelling each image, so flattening to one string destroys ' +
      'the pairing. 2,408,700 chars of base64 in a single feed row.',
  },
  {
    id: 'codex-exec-single-image',
    censusRows: [4],
    file: join(HOME, '.codex/sessions/2026/07/23/rollout-2026-07-23T19-31-13-019f9008-09b5-7793-8222-307a8700791a.jsonl'),
    line: 287,
    proves: 'Minimal exec case: one leading text part then one image. The common shape.',
  },
  {
    id: 'codex-user-attachment-no-detail',
    censusRows: [19],
    file: join(HOME, '.codex/sessions/2026/03/04/rollout-2026-03-04T15-04-08-019cb929-c760-7891-8b63-7e357be4ca30.jsonl'),
    line: 2061,
    proves:
      'payload.content[] user attachment. Two-key variant with NO `detail` sibling — proves the recognizer ' +
      'must not require `detail`. Today this shape is dropped entirely by rollout.ts (the vanish bug).',
  },
  {
    id: 'claude-tool-result-image-with-sidecar',
    censusRows: [2, 5, 7],
    file: join(HOME, '.claude/projects/-Users-juliusolsson-Desktop-Development-agent-code/606c672f-83dc-4e9d-a577-242273c3e508.jsonl'),
    line: 762,
    proves:
      'The dual-source case in one record: the same image appears BOTH as a tool_result content block ' +
      '(source.media_type/source.data) AND in the toolUseResult.file sidecar (base64/dimensions/originalSize). ' +
      'This is the fixture that pins which source wins and where metadata comes from.',
  },
  {
    id: 'claude-user-attachment',
    censusRows: [9],
    file: join(HOME, '.claude/projects/-Users-juliusolsson-Desktop-Development-agent-code/17dcbb2f-b55e-46c0-ad4c-a939a6eeb08f.jsonl'),
    line: 253,
    proves:
      'Top-level message content image — the ONE placement that already renders correctly today. ' +
      'Present as a regression guard: the fix must not disturb it.',
  },
  {
    id: 'atp-claude-image-inside-codex-rollout',
    censusRows: [11, 14],
    file: join(HOME, '.codex/sessions/2026/04/13/rollout-2026-04-13T19-21-14-f5795fee-ec3b-49c4-8432-1c8c7e6f0ebf.jsonl'),
    line: 30,
    proves:
      'Cross-provider carriage: a Claude-shaped image block living inside a Codex rollout under _atp.source, ' +
      'because the session was switched providers mid-task. Any fix scoped to "Codex shapes in Codex files" ' +
      'misses this.',
  },
  {
    id: 'atp-codex-image-inside-claude-transcript',
    censusRows: [20],
    file: join(HOME, '.claude/projects/-Users-juliusolsson-Desktop-Development-klay/c0c60d3d-681f-4457-b5c8-bf58745625de.jsonl'),
    line: 1142,
    proves:
      'Carriage in the OPPOSITE direction: a Codex input_image inside a Claude transcript. Proves the ' +
      'recognizer must be placement-agnostic rather than keyed off which provider owns the file.',
  },
]

// ---------------------------------------------------------------------------
// Payload substitution
// ---------------------------------------------------------------------------

type Substitution = { path: string; originalChars: number; mime: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Walk the record swapping every encoded payload for PIXEL_PNG, recording what
 * was there. Structure, ordering, and every sibling field survive untouched —
 * only the encoded bytes change.
 */
function substitute(node: unknown, path: string, out: Substitution[]): unknown {
  if (Array.isArray(node)) return node.map((child, i) => substitute(child, `${path}[${i}]`, out))
  if (!isRecord(node)) return node

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    const childPath = path ? `${path}.${key}` : key

    // Codex / OpenAI: a data URL in `image_url`.
    if (key === 'image_url' && typeof value === 'string' && value.startsWith('data:')) {
      const semi = value.indexOf(';')
      const mime = semi > 5 ? value.slice(5, semi) : 'image/png'
      out.push({ path: childPath, originalChars: value.length, mime })
      // Keep the ORIGINAL mime in the substituted URL even though the bytes are
      // now PNG. The recognizer branches on the declared MIME, and a fixture
      // that silently rewrote image/jpeg to image/png would stop exercising the
      // jpeg admission path — which is most of the corpus.
      result[key] = `data:${mime};base64,${PIXEL_PNG}`
      continue
    }

    // Claude native: `source.data`, with the MIME on a sibling.
    if (key === 'data' && typeof value === 'string' && value.length > 256 && isRecord(node)) {
      const mime =
        typeof node.media_type === 'string' ? node.media_type
        : typeof node.mimeType === 'string' ? node.mimeType
        : 'image/png'
      out.push({ path: childPath, originalChars: value.length, mime })
      result[key] = PIXEL_PNG
      continue
    }

    // Claude sidecar: `toolUseResult.file.base64`, MIME on the parent's `type`.
    if (key === 'base64' && typeof value === 'string' && value.length > 256) {
      const mime = typeof node.type === 'string' ? node.type : 'image/png'
      out.push({ path: childPath, originalChars: value.length, mime })
      result[key] = PIXEL_PNG
      continue
    }

    result[key] = substitute(value, childPath, out)
  }
  return result
}

// Same tripwire as the census generator. If a long base64 run survives
// substitution, a shape carries its payload somewhere this script does not know
// about — which is a census finding, not something to write to disk quietly.
const BASE64_RUN = /[A-Za-z0-9+/=]{300,}/

async function readLine(file: string, lineNo: number): Promise<string | null> {
  let current = 0
  return new Promise(resolve => {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    let found: string | null = null
    rl.on('line', line => {
      current += 1
      if (current === lineNo) {
        found = line
        rl.close()
      }
    })
    rl.on('close', () => resolve(found))
    rl.on('error', () => resolve(null))
  })
}

await mkdir(OUT_DIR, { recursive: true })

const manifest: string[] = []
manifest.push('# Image-read fixtures')
manifest.push('')
manifest.push('**Generated by `scripts/extract-image-fixtures.mts`. Do not hand-edit — re-run it.**')
manifest.push('')
manifest.push('Stage C artifact of [`../../../docs/decomposition/image-read-base64-dump.md`](../../../docs/decomposition/image-read-base64-dump.md).')
manifest.push('')
manifest.push('Every fixture is a **real record** from a real session, captured verbatim except that')
manifest.push('each base64 payload is replaced by a 1×1 PNG and its original length recorded in')
manifest.push('`$fixture.substitutions`. Structure, ordering, sibling fields, and declared MIME are')
manifest.push('untouched. The rendering path never decodes these bytes — it branches on MIME, on')
manifest.push('length, and on envelope shape — so the payload is the one part with no information')
manifest.push('value and all of the privacy risk. See the header of the generator for the full')
manifest.push('argument.')
manifest.push('')
manifest.push('| Fixture | Census rows | Source | Proves |')
manifest.push('|---|---|---|---|')

let written = 0
for (const spec of SPECS) {
  const raw = await readLine(spec.file, spec.line)
  if (!raw) {
    console.warn(`SKIP ${spec.id}: ${spec.file}:${spec.line} not readable`)
    continue
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`SKIP ${spec.id}: line ${spec.line} is not JSON`)
    continue
  }

  const substitutions: Substitution[] = []
  const entry = substitute(parsed, '', substitutions)

  const fixture = {
    $fixture: {
      id: spec.id,
      censusRows: spec.censusRows,
      source: `${spec.file}:${spec.line}`,
      proves: spec.proves,
      substitutions,
      totalOriginalPayloadChars: substitutions.reduce((n, s) => n + s.originalChars, 0),
    },
    entry,
  }

  const serialized = JSON.stringify(fixture, null, 2)
  const leak = BASE64_RUN.exec(serialized)
  if (leak) {
    throw new Error(
      `${spec.id}: a ${leak[0].length}-char base64 run survived substitution. ` +
      `A shape carries its payload somewhere substitute() does not handle — add the case before re-running.`,
    )
  }

  await writeFile(join(OUT_DIR, `${spec.id}.json`), `${serialized}\n`, 'utf8')
  written += 1
  manifest.push(
    `| \`${spec.id}.json\` | ${spec.censusRows.join(', ')} | \`${spec.file.replace(HOME, '~')}:${spec.line}\` | ${spec.proves} |`,
  )
}

manifest.push('')
await writeFile(join(OUT_DIR, 'MANIFEST.md'), `${manifest.join('\n')}\n`, 'utf8')
console.log(`wrote ${written}/${SPECS.length} fixtures → ${OUT_DIR}`)
