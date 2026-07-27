// extract-image-shapes.mts — Stage B of docs/decomposition/image-read-base64-dump.md
//
// Walks the real on-disk provider corpora and emits a census of every distinct
// image-bearing node shape, with occurrence counts and payload sizes.
//
// WHY this script exists at all (it renders nothing and ships nothing)
// -------------------------------------------------------------------
// The image-dump bug looked like a one-line fix in codexOutputText. Writing the
// recognizer straight from the bug report would have handled the two shapes that
// happened to be in front of us and silently omitted the rest — and the omission
// would have been invisible, because an unrecognized shape falls through to the
// existing dump and reads as "not fixed yet" rather than "never looked". This
// census is the artifact that makes the omission COUNTABLE. Every branch in
// imageAttachment.ts must trace to a row this script produced; a branch with no
// census row does not get written.
//
// It has already earned its keep: the first draft of the decomposition named
// `view_image` as the carrier. The census showed `view_image` appears 6 times in
// ONE file across 1,581 sessions, while Codex's `exec` tool — via
// custom_tool_call_output — carries essentially all of them. A fix aimed at
// view_image would not have touched the reported bug.
//
// WHY it prints structure and never payload
// -----------------------------------------
// The corpora are the user's real sessions: building-permit drawings, personal
// photos, screenshots of private work. The census is committed to a public repo,
// so emitting payload bytes would leak them. Everything below reports keys,
// types, MIME, and LENGTHS. `assertNoPayload` is a hard gate on the way out: if a
// base64 run ever reaches the output buffer the script throws rather than
// writing a file someone might commit.
//
// Usage:
//   npx tsx scripts/extract-image-shapes.mts                  # both corpora
//   npx tsx scripts/extract-image-shapes.mts --codex-only
//   npx tsx scripts/extract-image-shapes.mts --out <path>

import { createReadStream } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

// ---------------------------------------------------------------------------
// Payload gate
// ---------------------------------------------------------------------------

// A run of 200+ base64 characters. Deliberately loose: it is a tripwire, not a
// parser, and a false positive costs one aborted census run while a false
// negative costs a leaked screenshot in a public repo.
const BASE64_RUN = /[A-Za-z0-9+/=]{200,}/

function assertNoPayload(markdown: string): void {
  const hit = BASE64_RUN.exec(markdown)
  if (hit) {
    throw new Error(
      `refusing to write census: a ${hit[0].length}-char base64-looking run reached the output ` +
      `at offset ${hit.index}. The census must contain structure and lengths only.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Observation model
// ---------------------------------------------------------------------------

type Observation = {
  /** Stable identity of the shape: provider + JSON path + discriminating keys. */
  key: string
  provider: 'claude' | 'codex'
  /** Where in the entry this node sits — the plane a consumer would read it from. */
  path: string
  /** Discriminating detail: node type, MIME, sibling keys. */
  detail: string
}

type Census = {
  count: number
  files: Set<string>
  maxPayloadChars: number
  totalPayloadChars: number
  examples: Set<string>
  provider: string
  path: string
  detail: string
}

const census = new Map<string, Census>()

function record(obs: Observation, file: string, payloadChars: number, example?: string): void {
  let row = census.get(obs.key)
  if (!row) {
    row = {
      count: 0,
      files: new Set(),
      maxPayloadChars: 0,
      totalPayloadChars: 0,
      examples: new Set(),
      provider: obs.provider,
      path: obs.path,
      detail: obs.detail,
    }
    census.set(obs.key, row)
  }
  row.count += 1
  row.files.add(file)
  row.totalPayloadChars += payloadChars
  if (payloadChars > row.maxPayloadChars) row.maxPayloadChars = payloadChars
  // Keep at most three source citations per shape. The census is evidence, so
  // every row must be traceable back to a real session a reader can open — but
  // a row citing 200 files is noise, not evidence.
  if (example && row.examples.size < 3) row.examples.add(example)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keyList(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',')
}

/** Length of the encoded payload a node carries, in characters. Never its content. */
function payloadLength(node: Record<string, unknown>): number {
  const url = typeof node.image_url === 'string'
    ? node.image_url
    : isRecord(node.image_url) && typeof node.image_url.url === 'string'
      ? node.image_url.url
      : null
  if (url) return url.length
  const source = isRecord(node.source) ? node.source : null
  if (source && typeof source.data === 'string') return source.data.length
  if (typeof node.base64 === 'string') return node.base64.length
  return 0
}

function mimeOf(node: Record<string, unknown>): string {
  const url = typeof node.image_url === 'string' ? node.image_url : null
  if (url?.startsWith('data:')) {
    const semi = url.indexOf(';')
    return semi > 5 ? url.slice(5, semi) : 'data:?'
  }
  if (url) return 'url(non-data)'
  const source = isRecord(node.source) ? node.source : null
  const mime = source?.media_type ?? source?.mimeType ?? node.type
  return typeof mime === 'string' ? mime : '?'
}

// ---------------------------------------------------------------------------
// Generic walker
// ---------------------------------------------------------------------------

// WHY a generic recursive walker instead of per-provider extractors: the shapes
// we already know about are exactly the ones a hand-written extractor would
// find. The point of the census is the shapes we do NOT know about — including
// the five that agent-transcript-parser re-introduces under `_atp.source` when a
// session is switched between providers (a Claude image read is still
// Claude-shaped inside a Codex rollout). A walker that recognizes "image-ish"
// structurally, wherever it sits, is the only version that can surprise us.
const MAX_DEPTH = 10

function walk(
  node: unknown,
  path: string,
  provider: 'claude' | 'codex',
  file: string,
  citation: string,
  depth = 0,
): void {
  if (depth > MAX_DEPTH || node == null) return

  if (Array.isArray(node)) {
    for (const child of node) walk(child, `${path}[]`, provider, file, citation, depth + 1)
    return
  }
  if (!isRecord(node)) return

  const type = typeof node.type === 'string' ? node.type : null
  const looksImage =
    'image_url' in node ||
    (type != null && /image/i.test(type)) ||
    (typeof node.base64 === 'string' && typeof node.type === 'string' && /^image\//.test(node.type))

  if (looksImage) {
    const chars = payloadLength(node)
    const mime = mimeOf(node)
    const detail = `type=\`${type ?? '—'}\` mime=\`${mime}\` keys=\`${keyList(node)}\``
    record(
      { key: `${provider}|${path}|${type}|${mime}|${keyList(node)}`, provider, path, detail },
      file,
      chars,
      citation,
    )
  }

  for (const [k, v] of Object.entries(node)) {
    walk(v, `${path}.${k}`, provider, file, citation, depth + 1)
  }
}

// ---------------------------------------------------------------------------
// Corpus traversal
// ---------------------------------------------------------------------------

async function jsonlFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await jsonlFiles(full, out)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

async function scanCorpus(root: string, provider: 'claude' | 'codex'): Promise<number> {
  const files = await jsonlFiles(root)
  for (const file of files) {
    let lineNo = 0
    await new Promise<void>(resolve => {
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
      rl.on('line', line => {
        lineNo += 1
        // Cheap prefilter. Parsing every line of ~3,500 multi-megabyte
        // transcripts is minutes of wall time; the substring test skips the
        // ~99.9% of lines that cannot possibly carry an image.
        if (!line || !line.includes('image')) return
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          return
        }
        const root = isRecord(parsed) && typeof parsed.type === 'string' ? `<${parsed.type}>` : '<line>'
        walk(parsed, root, provider, file, `${file}:${lineNo}`)
      })
      rl.on('close', () => resolve())
      rl.on('error', () => resolve())
    })
  }
  return files.length
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function humanBytes(chars: number): string {
  // base64 encodes 3 bytes per 4 chars.
  const bytes = Math.ceil(chars * 3 / 4)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function buildMarkdown(scanned: { claude: number; codex: number }): string {
  const rows = [...census.values()].sort((a, b) => b.count - a.count)
  const totalPayload = rows.reduce((sum, r) => sum + r.totalPayloadChars, 0)

  const lines: string[] = []
  lines.push('# Image shape census')
  lines.push('')
  lines.push('**Generated by `scripts/extract-image-shapes.mts`. Do not hand-edit — re-run it.**')
  lines.push('')
  lines.push('Stage B artifact of [`../../image-read-base64-dump.md`](../../image-read-base64-dump.md).')
  lines.push('Every branch in `protocols/media/imageAttachment.ts` must trace to a row here.')
  lines.push('A branch with no row does not get written.')
  lines.push('')
  lines.push('Structure, MIME, and lengths only — never payload bytes. The generator hard-fails')
  lines.push('if a base64 run reaches this file.')
  lines.push('')
  lines.push('## Corpora scanned')
  lines.push('')
  lines.push(`- Claude: \`~/.claude/projects\` — ${scanned.claude} transcripts`)
  lines.push(`- Codex: \`~/.codex/sessions\` — ${scanned.codex} rollouts`)
  lines.push(`- Distinct image-bearing shapes: **${rows.length}**`)
  lines.push(`- Total encoded payload observed: **${humanBytes(totalPayload)}**`)
  lines.push('')
  lines.push('## Shapes')
  lines.push('')
  lines.push('| # | Provider | JSON path | Detail | Count | Files | Max payload |')
  lines.push('|---|---|---|---|---|---|---|')
  rows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.provider} | \`${row.path}\` | ${row.detail} | ${row.count} | ` +
      `${row.files.size} | ${row.maxPayloadChars.toLocaleString()} chars (${humanBytes(row.maxPayloadChars)}) |`,
    )
  })
  lines.push('')
  lines.push('## Source citations')
  lines.push('')
  lines.push('Up to three real sessions per shape, so every row is traceable to something')
  lines.push('a reader can open. Paths are machine-local and intentionally not redacted —')
  lines.push('they are file locations, not content.')
  lines.push('')
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. \`${row.path}\` — ${row.detail}`)
    for (const example of row.examples) lines.push(`   - \`${example}\``)
  })
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0
  ? args[outIndex + 1]
  : join(process.cwd(), 'docs/decomposition/evidence/image-reads/shape-census.md')

const scanned = { claude: 0, codex: 0 }
if (!args.includes('--codex-only')) {
  scanned.claude = await scanCorpus(join(homedir(), '.claude', 'projects'), 'claude')
}
if (!args.includes('--claude-only')) {
  scanned.codex = await scanCorpus(join(homedir(), '.codex', 'sessions'), 'codex')
}

const markdown = buildMarkdown(scanned)
assertNoPayload(markdown)
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, markdown, 'utf8')

console.log(
  `census: ${census.size} distinct shapes from ${scanned.claude} claude + ${scanned.codex} codex files → ${outPath}`,
)
