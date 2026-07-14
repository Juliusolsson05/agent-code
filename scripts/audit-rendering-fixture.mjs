#!/usr/bin/env node
// Audit a captured rendering fixture or raw debug bundle for commit safety.
//
// WHY this script exists next to extract-rendering-fixtures.mjs instead of
// being folded into extraction: extraction answers "can the rendering pipeline
// replay this bug?", while this script answers "is this captured artifact safe
// and useful to commit?". Mixing those jobs would make it too easy to trust a
// fixture because the renderer test passed, even though the artifact still
// contains local paths, huge raw outputs, or credentials. Keep this read-only
// first: review evidence before any future redaction tool mutates files.
//
// Detection has two layers, deliberately asymmetric:
//   1. KEY-BASED (authoritative): the repo's canonical SENSITIVE_KEY gate
//      (rendering/model/unknowns.ts + rendering/replay/redact.ts), reached
//      through the tsx bridge scripts/audit-sensitive-core.mts. This is the
//      SAME gate the recording extractor uses to refuse leaky fixtures — one
//      implementation, no drift. See the bridge header for why.
//   2. CONTENT-REGEX (supplement): SECRET_PATTERNS below match secret-shaped
//      VALUES regardless of key (a PEM block inside a stdout string has no
//      secret-looking key). These are audit-local by design and NEVER replace
//      the key gate.
//
// Verdict/exit contract (machine-usable so a broken or leaky fixture can
// never slide through as success):
//   LIKELY_SAFE → exit 0   no block/review findings
//   REVIEW      → exit 2   at least one review finding (parse errors and
//                          oversized-unscanned files count — anything the
//                          scanner could NOT read is a finding, never silence)
//   BLOCKED     → exit 3   at least one block finding (secret material)
//   exit 1                 usage / IO / gate-infrastructure errors

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The bridge + tsconfig are addressed from the REPO ROOT (this file's parent
// dir's parent), not process.cwd() — the audit accepts absolute fixture paths
// and must work when invoked from anywhere.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const args = process.argv.slice(2)

function usage() {
  console.log(`Usage:
  node scripts/audit-rendering-fixture.mjs [--json|--markdown] [--max-preview N] <fixture.json|bundle-dir>

Exit codes: 0 LIKELY_SAFE, 2 REVIEW, 3 BLOCKED, 1 usage/IO error.

Examples:
  npm run fixture:audit -- testing/fixtures/rendering-bundles/2026-07-07T13-17-20-472-5b19529f.json
  npm run fixture:audit -- ~/.config/agent-code/debug-bundles/manual/<bundle-id>
`)
}

if (args.includes('--help') || args.includes('-h')) {
  usage()
  process.exit(0)
}

const jsonMode = args.includes('--json')
const markdownMode = args.includes('--markdown')
const maxPreviewIdx = args.indexOf('--max-preview')
const maxPreview =
  maxPreviewIdx >= 0 ? Number(args[maxPreviewIdx + 1]) : 400
const inputArg = args.find((arg, i) => {
  if (arg.startsWith('--')) return false
  if (args[i - 1] === '--max-preview') return false
  return true
})

if (!inputArg) {
  usage()
  process.exit(1)
}

const inputPath = resolve(inputArg.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))

if (!existsSync(inputPath)) {
  console.error(`audit-rendering-fixture: path does not exist: ${inputPath}`)
  process.exit(1)
}

const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024
const LARGE_STRING_WARN = 8 * 1024
const HUGE_STRING_BLOCK = 256 * 1024

const TEXT_EXTENSIONS = new Set([
  '.json',
  '.jsonl',
  '.txt',
  '.md',
  '.html',
  '.htm',
  '.log',
])

const SENSITIVE_BASENAME_RE =
  /(^|\/)(\.env(?:\..*)?|id_rsa|id_dsa|id_ed25519|\.npmrc|\.pypirc|credentials|credential|secret|secrets|token|tokens|cookie|cookies|keychain)(\/|$|\.)/i

const PRIVATE_TRANSCRIPT_PATH_RE =
  /(^|\/)\.(?:codex|claude)\/(?:sessions|projects)(?:\/|$)|(^|\/)(?:codex|claude)\/history\.jsonl$/i

const ABS_PATH_RE =
  /(?:~\/|\/(?:Users|private|tmp|var|Volumes|opt|etc|home)\/[^\s"'<>),;`]+(?:[^\s"'<>),;`]|\b))/g

const REL_PATH_RE =
  /\b(?:[\w.-]+\/)+(?:[\w .@()+,[\]-]+\.)?(?:ts|tsx|js|jsx|mjs|json|jsonl|md|css|html|yml|yaml|toml|py|rs|go|java|swift|kt|sh|zsh|bash|txt|lock)\b/g

// CONTENT-REGEX SUPPLEMENT ONLY. The authoritative key-based detector is the
// canonical SENSITIVE_KEY gate reached via runSensitiveKeyGate() below —
// these patterns exist for secret-shaped VALUES that sit under an innocent
// key (a PEM block in a Bash stdout string, an sk-… key pasted into a
// prompt). They must never grow key-name matching: that job belongs to the
// one shared regex in rendering/model/unknowns.ts, so the audit and the
// recording extractor can never disagree about what a secret key is.
const SECRET_PATTERNS = [
  {
    id: 'private-key',
    severity: 'block',
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: 'openai-or-anthropic-key',
    severity: 'block',
    re: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{20,})\b/,
  },
  {
    id: 'github-token',
    severity: 'block',
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/,
  },
  {
    id: 'aws-access-key',
    severity: 'block',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'slack-token',
    severity: 'block',
    re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    id: 'jwt',
    severity: 'review',
    re: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  },
  {
    id: 'credential-assignment',
    severity: 'review',
    re: /\b(?:api[_-]?key|token|secret|password|authorization|cookie)[A-Za-z0-9_.-]{0,40}\s*[:=]\s*["']?[A-Za-z0-9_./+=:-]{16,}/i,
  },
]

// WHY parse failures come back as BOTH an in-stream marker object AND an
// entry in `issues`: the marker keeps positional context (which array index
// the broken line occupied) and carries the RAW line text so the string
// scanners still sweep unparseable content — a secret in a torn line must not
// escape scanning just because JSON.parse choked on it. The `issues` entry is
// what makes the failure a VERDICT input: audit() turns every issue into a
// review finding, so a bundle of broken JSON can never exit 0 as LIKELY_SAFE
// (the scanner literally could not read it — that is the opposite of safe).
function readJsonl(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const items = []
  const issues = []
  let lastNonEmpty = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) {
      lastNonEmpty = i
      break
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      items.push(JSON.parse(line))
    } catch (err) {
      // A torn FINAL line is an expected artifact of reading an append-only
      // stream mid-write; anywhere else it is corruption. Both still force
      // REVIEW — for a checked-in fixture even a torn tail is malformed data
      // a human should look at — but the detail says which case it was.
      const tornTail = i === lastNonEmpty
      items.push({
        __auditParseError: true,
        line: i + 1,
        toleratedTornTail: tornTail,
        message: err instanceof Error ? err.message : String(err),
        rawText: line,
      })
      issues.push({
        kind: 'parse-error',
        source: path,
        path: `line ${i + 1}`,
        detail: `${tornTail ? 'torn final jsonl line' : 'malformed jsonl line'}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  return { items, issues }
}

function safeReadText(path) {
  const stat = statSync(path)
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    return {
      skipped: `file is ${formatBytes(stat.size)}; max text scan is ${formatBytes(MAX_TEXT_FILE_BYTES)}`,
      text: '',
    }
  }
  return { skipped: null, text: readFileSync(path, 'utf8') }
}

function listBundleFiles(dir) {
  const out = []
  const stack = [{ dir, depth: 0 }]
  while (stack.length > 0) {
    const next = stack.pop()
    for (const ent of readdirSync(next.dir, { withFileTypes: true })) {
      const full = join(next.dir, ent.name)
      if (ent.isDirectory()) {
        if (next.depth < 2) stack.push({ dir: full, depth: next.depth + 1 })
        continue
      }
      out.push(full)
    }
  }
  return out.sort()
}

// Load one text file into roots/issues. Shared by the directory and
// single-file entrypoints so the two modes cannot drift: the size cap, the
// parse-error handling, and the "unreadable content is an issue, never
// silence" rule apply identically no matter how the input was addressed.
// (The first version had no size cap and a bare JSON.parse in single-file
// mode — a 100MB or malformed .json behaved completely differently depending
// on whether you pointed at the file or its parent directory.)
function loadTextFile(file, roots, issues) {
  const ext = extname(file)
  const { skipped, text } = safeReadText(file)
  if (skipped) {
    // An unscanned file is a REVIEW input by definition: the audit's whole
    // promise is "everything in this artifact was swept", and a silent skip
    // breaks that promise exactly where it matters most (huge raw payloads
    // are where captured secrets and bulk content hide).
    issues.push({ kind: 'oversized-unscanned', source: file, path: '', detail: skipped })
    return
  }
  if (ext === '.json') {
    try {
      roots.push({ source: file, value: JSON.parse(text) })
    } catch (err) {
      // Keep the RAW text as a scanned root: JSON.parse failing must not
      // exempt the bytes from the secret/path sweeps (see readJsonl).
      roots.push({
        source: file,
        value: {
          __auditParseError: true,
          message: err instanceof Error ? err.message : String(err),
          rawText: text,
        },
      })
      issues.push({
        kind: 'parse-error',
        source: file,
        path: '',
        detail: `malformed json: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else if (ext === '.jsonl') {
    const { items, issues: lineIssues } = readJsonl(file)
    roots.push({ source: file, value: items })
    issues.push(...lineIssues)
  } else {
    roots.push({ source: file, value: text })
  }
}

function loadInput(path) {
  const stat = statSync(path)
  const roots = []
  const files = []
  // Loader problems that MUST reach the verdict (parse errors, oversized
  // skips). audit() folds every one of these into a review finding.
  const issues = []
  if (stat.isDirectory()) {
    for (const file of listBundleFiles(path)) {
      const fileStat = statSync(file)
      const ext = extname(file)
      files.push({
        path: file,
        relativePath: file.slice(path.length + 1),
        bytes: fileStat.size,
      })
      if (!TEXT_EXTENSIONS.has(ext)) continue
      loadTextFile(file, roots, issues)
    }
    return { kind: 'bundle-directory', path, roots, files, issues }
  }

  files.push({ path, relativePath: basename(path), bytes: stat.size })
  loadTextFile(path, roots, issues)
  return { kind: 'file', path, roots, files, issues }
}

// KEY-BASED DETECTION — the authoritative layer. Ships every parsed root to
// the tsx bridge (scripts/audit-sensitive-core.mts), which imports the
// canonical SENSITIVE_KEY / findSensitiveSurvivors gate from
// rendering/replay/redact.ts — the exact gate the recording extractor uses to
// refuse leaky fixtures. See the bridge header for the full rationale and the
// drift check that keeps the two in lockstep.
//
// FAIL CLOSED: if the bridge cannot run (tsx missing, drift check tripped,
// crash), the audit exits 1 instead of continuing without its authoritative
// detector — an audit that silently skipped key-based detection would be the
// original blocker all over again, just intermittent.
function runSensitiveKeyGate(roots) {
  let out
  try {
    out = execFileSync(
      'npx',
      ['tsx', '--tsconfig', join(REPO_ROOT, 'tsconfig.web.json'), join(REPO_ROOT, 'scripts/audit-sensitive-core.mts')],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        input: JSON.stringify(roots.map(({ source, value }) => ({ source, value }))),
        // Survivor lists are small, but be generous: a pathological fixture
        // could have thousands of survivors and stdout must not truncate.
        maxBuffer: 256 * 1024 * 1024,
      },
    )
  } catch (err) {
    const detail = err?.stderr ? String(err.stderr).trim() : String(err)
    console.error(
      `audit-rendering-fixture: canonical SENSITIVE_KEY gate failed to run — refusing to audit without it.\n${detail}`,
    )
    process.exit(1)
  }
  try {
    return JSON.parse(out)
  } catch (err) {
    console.error(`audit-rendering-fixture: gate bridge printed unparseable output: ${err}`)
    process.exit(1)
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function preview(value, limit = maxPreview) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function jsonPath(parent, key) {
  if (parent === '$') return `${parent}.${key}`
  return `${parent}.${key}`
}

function walk(value, visit, path = '$', source = '<input>') {
  visit(value, path, source)
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, visit, `${path}[${i}]`, source))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, visit, jsonPath(path, key), source)
    }
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function tryParseJsonText(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function addMapSet(map, key, item) {
  if (!key) return
  let arr = map.get(key)
  if (!arr) {
    arr = []
    map.set(key, arr)
  }
  arr.push(item)
}

function uniqueItems(items, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function extractPathsFromString(text) {
  const out = []
  for (const match of text.matchAll(ABS_PATH_RE)) out.push(match[0])
  for (const match of text.matchAll(REL_PATH_RE)) out.push(match[0])
  return out
}

function pathRisk(path) {
  if (path.includes('/.ssh/')) return 'ssh-path'
  if (isSensitivePath(path)) return 'sensitive-path'
  if (path.startsWith('/Users/') || path.startsWith('~/')) return 'local-home-path'
  if (path.startsWith('/tmp/') || path.startsWith('/private/tmp/')) return 'temp-path'
  return 'path'
}

function isSensitivePath(path) {
  const normalized = String(path).replaceAll('\\', '/')
  // WHY "session" is intentionally not a generic sensitive filename: this repo
  // has normal source files such as src/main/sessions/forwarder.ts and
  // src/preload/api/session.ts. The private thing is the provider transcript
  // store under ~/.codex or ~/.claude, not every path that happens to contain
  // the word session.
  return SENSITIVE_BASENAME_RE.test(normalized) || PRIVATE_TRANSCRIPT_PATH_RE.test(normalized)
}

function extractPatchPaths(text) {
  const out = []
  const lines = String(text).split('\n')
  for (const line of lines) {
    let m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
    if (m) {
      out.push(m[1].trim())
      continue
    }
    m = /^(?:---|\+\+\+) [ab]\/(.+)$/.exec(line)
    if (m && m[1] !== '/dev/null') out.push(m[1].trim())
  }
  return out
}

function fieldName(path) {
  const m = /\.([A-Za-z0-9_$-]+)(?:\[\d+\])?$/.exec(path)
  return m?.[1] ?? ''
}

function commandText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) {
    return value.join(' ')
  }
  return null
}

function commandKind(command) {
  const lower = command.toLowerCase()
  if (/\b(rm|unlink)\b/.test(lower)) return 'delete'
  if (/\b(apply_patch|patch|git apply)\b/.test(lower) || command.includes('*** Begin Patch')) return 'patch'
  if (/(^|[\s;&|])>{1,2}\s*\S+|\btee\s+\S+|\bcat\s+>\s*\S+/.test(command)) return 'write'
  if (/\b(cat|sed|awk|rg|grep|find|ls|head|tail|wc|git show|git diff)\b/.test(lower)) return 'read'
  return 'command'
}

function discoverToolActivity(root, source, report) {
  walk(root, (value, path) => {
    const rec = asRecord(value)
    if (!rec) return

    const type = String(rec.type ?? rec.kind ?? '')
    const name = String(rec.name ?? rec.toolName ?? rec.tool ?? '')
    const lowerName = name.toLowerCase()
    const isTool =
      type.includes('tool') ||
      type === 'function_call' ||
      type === 'custom_tool_call' ||
      lowerName.length > 0
    if (!isTool) return

    const input =
      rec.input ??
      rec.parsedInput ??
      tryParseJsonText(rec.argumentsJson) ??
      tryParseJsonText(rec.inputJson) ??
      rec.argumentsJson ??
      rec.inputJson ??
      null

    const rawCommand =
      commandText(rec.command) ??
      commandText(rec.cmd) ??
      commandText(asRecord(input)?.command) ??
      commandText(asRecord(input)?.cmd) ??
      commandText(asRecord(input)?.argv)

    if (rawCommand) {
      const kind = commandKind(rawCommand)
      report.commands.push({
        source,
        path,
        tool: name || type || 'command',
        kind,
        hash: sha(rawCommand),
        preview: preview(rawCommand),
      })
      for (const p of extractPathsFromString(rawCommand)) {
        addFileActivity(report, kind === 'delete' ? 'deleted' : kind === 'write' ? 'written' : kind === 'patch' ? 'patched' : 'mentioned', p, source, path)
      }
      for (const p of extractPatchPaths(rawCommand)) addFileActivity(report, 'patched', p, source, path)
    }

    // apply_patch payloads arrive DECODED at this point (`input` is either
    // the patch string itself or a parsed record like Codex's
    // `{ raw: "*** Begin Patch\n..." }`). extractPatchPaths splits on real
    // newlines with ^-anchored regexes, so it must see the decoded string —
    // the first version JSON.stringify'd the whole input record, which
    // escaped every newline into `\n` and made every patch extract ZERO
    // paths (fixture 2026-06-24T14-52-00-547-75fb2add.json: apply_patch
    // calls under input.raw reported `patched: 0`). `String(input)` on a
    // record was equally broken: "[object Object]" never contains the patch
    // envelope, so record-shaped patches didn't even trigger this branch.
    const inputRecord = asRecord(input)
    const patchTexts =
      typeof input === 'string'
        ? [input]
        : inputRecord
          ? Object.values(inputRecord).filter(v => typeof v === 'string')
          : []
    if (lowerName === 'apply_patch' || patchTexts.some(t => t.includes('*** Begin Patch'))) {
      // Sweep every string field rather than guessing the envelope key
      // (`raw` today, but the audit should not bake in one provider's arg
      // name): extractPatchPaths returns [] for non-patch text, so extra
      // fields are harmless.
      for (const text of patchTexts) {
        for (const p of extractPatchPaths(text)) addFileActivity(report, 'patched', p, source, path)
      }
    }

    if (inputRecord) {
      for (const [key, raw] of Object.entries(inputRecord)) {
        if (typeof raw !== 'string') continue
        if (!/(path|file|filename|dir|cwd|workdir|source|destination|target)/i.test(key)) continue
        const category =
          /^(old_|source|from)/i.test(key) || /read|grep|glob|ls/.test(lowerName)
            ? 'read'
            : /delete|remove/.test(lowerName)
              ? 'deleted'
              : /write|edit|patch|multi/.test(lowerName)
                ? 'written'
                : 'mentioned'
        addFileActivity(report, category, raw, source, `${path}.${key}`)
      }
    }
  }, '$', source)
}

function addFileActivity(report, category, file, source, path) {
  const normalized = String(file).trim()
  if (!normalized) return
  const item = { file: normalized, source, path }
  report.fileActivity[category].push(item)
  if (isSensitivePath(normalized)) {
    report.findings.push({
      severity: 'review',
      kind: 'sensitive-file-reference',
      source,
      path,
      detail: normalized,
    })
  }
}

function audit(input) {
  const report = {
    input: {
      path: input.path,
      kind: input.kind,
      fileCount: input.files.length,
      totalBytes: input.files.reduce((sum, f) => sum + f.bytes, 0),
    },
    meta: {},
    counts: {
      objects: 0,
      arrays: 0,
      strings: 0,
      stringChars: 0,
      entries: 0,
      semanticHistoryTurns: 0,
      expectedRows: 0,
      triageItems: 0,
      ghosts: 0,
    },
    paths: [],
    commands: [],
    fileActivity: {
      read: [],
      written: [],
      patched: [],
      deleted: [],
      mentioned: [],
    },
    largeStrings: [],
    findings: [],
  }

  // Loader issues (parse errors, oversized-unscanned files) are findings
  // FIRST: anything the scanner could not read forces REVIEW. A verdict of
  // LIKELY_SAFE must mean "everything was swept and came back clean", never
  // "the scanner failed to look".
  for (const issue of input.issues) {
    report.findings.push({
      severity: 'review',
      kind: issue.kind,
      source: issue.source,
      path: issue.path,
      detail: issue.detail,
    })
  }

  // Canonical key-based detection (one bridge run over all roots). Value-type
  // triage happens HERE, not in the gate: this corpus is saturated with
  // integer token-usage counters (`input_tokens`, `cache_read_input_tokens`,
  // …) whose keys match /token/ — 13k+ hits across the committed fixtures,
  // every one an int. A number or boolean cannot carry a secret, so those
  // aggregate into one info finding per file (visible, not verdict-moving),
  // while ANY string/object/array survivor is a review finding: that is the
  // `authorization: "Bearer …"` class the audit exists to catch.
  const survivors = runSensitiveKeyGate(input.roots)
  const scalarSurvivorsBySource = new Map()
  for (const s of survivors) {
    if (s.valueType === 'number' || s.valueType === 'boolean') {
      scalarSurvivorsBySource.set(s.source, (scalarSurvivorsBySource.get(s.source) ?? 0) + 1)
      continue
    }
    report.findings.push({
      severity: 'review',
      kind: 'sensitive-key-value',
      source: s.source,
      path: s.path,
      hash: s.hash,
      // Never preview the value itself — it may literally be the secret. The
      // hash + path are enough for a human to locate and judge it.
      detail: `${s.valueType} (${s.chars} chars) under a SENSITIVE_KEY-matching key`,
    })
  }
  for (const [source, count] of scalarSurvivorsBySource) {
    report.findings.push({
      severity: 'info',
      kind: 'sensitive-key-scalars',
      source,
      path: '',
      detail: `${count} numeric/boolean values under token-like keys (usage counters, not secrets)`,
    })
  }

  for (const { source, value } of input.roots) {
    if (value?.meta && typeof value.meta === 'object') {
      report.meta = { ...report.meta, ...value.meta }
    }
    if (value?.input && typeof value.input === 'object') {
      report.counts.entries += Array.isArray(value.input.entries) ? value.input.entries.length : 0
      report.counts.semanticHistoryTurns += Array.isArray(value.input.semanticHistory) ? value.input.semanticHistory.length : 0
      report.counts.ghosts += value.input.ghosts && typeof value.input.ghosts === 'object'
        ? Object.keys(value.input.ghosts).length
        : 0
    }
    if (value?.expected && typeof value.expected === 'object') {
      report.counts.expectedRows += Array.isArray(value.expected.rows) ? value.expected.rows.length : 0
    }
    if (Array.isArray(value?.triage)) report.counts.triageItems += value.triage.length

    discoverToolActivity(value, source, report)

    walk(value, (node, path) => {
      if (Array.isArray(node)) {
        report.counts.arrays += 1
        return
      }
      if (node && typeof node === 'object') {
        report.counts.objects += 1
        return
      }
      if (typeof node !== 'string') return
      report.counts.strings += 1
      report.counts.stringChars += node.length

      const key = fieldName(path)
      const fieldLooksPathy = /(path|file|filename|dir|cwd|workdir|project|transcript|source|destination|target)/i.test(key)
      const extractedPaths = extractPathsFromString(node)
      for (const p of extractedPaths) {
        report.paths.push({ value: p, risk: pathRisk(p), source, path })
      }
      if (fieldLooksPathy && node.includes('/')) {
        report.paths.push({ value: node, risk: pathRisk(node), source, path })
      }

      for (const pattern of SECRET_PATTERNS) {
        if (!pattern.re.test(node)) continue
        report.findings.push({
          severity: pattern.severity,
          kind: pattern.id,
          source,
          path,
          hash: sha(node),
          preview: pattern.severity === 'block' ? '[redacted]' : preview(node),
        })
      }

      if (node.length >= LARGE_STRING_WARN) {
        report.largeStrings.push({
          source,
          path,
          chars: node.length,
          hash: sha(node),
          preview: preview(node),
        })
        if (node.length >= HUGE_STRING_BLOCK) {
          report.findings.push({
            severity: 'review',
            kind: 'huge-string-payload',
            source,
            path,
            detail: `${node.length} chars`,
          })
        }
      }
    }, '$', source)
  }

  report.paths = uniqueItems(report.paths, p => `${p.value}\0${p.source}\0${p.path}`)
  for (const key of Object.keys(report.fileActivity)) {
    report.fileActivity[key] = uniqueItems(
      report.fileActivity[key],
      item => `${item.file}\0${item.source}\0${item.path}`,
    )
  }
  report.largeStrings.sort((a, b) => b.chars - a.chars)

  // Sensitive PATH references become review findings — with ONE carve-out.
  // Every committed bundle fixture carries `$.meta.entriesSource`, the
  // provenance pointer at the local provider transcript the entries were
  // mined from (`~/.claude/projects/...jsonl`). That field is part of the
  // fixture SCHEMA — a path reference, not captured transcript content — and
  // it matches PRIVATE_TRANSCRIPT_PATH_RE in 44/48 committed fixtures. If it
  // forced REVIEW, every fixture would flag on its own provenance forever and
  // the verdict would carry no signal (the exact rot this audit is meant to
  // prevent). The path is still LISTED in the paths section with its
  // sensitive-path risk label; it just doesn't move the verdict. A transcript
  // path appearing anywhere ELSE (a command, a tool result, prose) is real
  // signal and still forces REVIEW.
  const PROVENANCE_JSON_PATHS = new Set(['$.meta.entriesSource'])
  for (const p of report.paths) {
    if (!p.risk.includes('sensitive') && !p.risk.includes('ssh')) continue
    if (PROVENANCE_JSON_PATHS.has(p.path)) continue
    report.findings.push({
      severity: 'review',
      kind: 'sensitive-path',
      source: p.source,
      path: p.path,
      detail: p.value,
    })
  }

  const absolutePathCount = report.paths.filter(p => p.value.startsWith('/') || p.value.startsWith('~/')).length
  const sensitivePathCount = report.paths.filter(p => p.risk.includes('sensitive') || p.risk.includes('ssh')).length
  const blockCount = report.findings.filter(f => f.severity === 'block').length
  const reviewCount = report.findings.filter(f => f.severity === 'review').length

  report.summary = {
    absolutePathCount,
    sensitivePathCount,
    commandCount: report.commands.length,
    touchedFileCount: Object.values(report.fileActivity).reduce((sum, items) => sum + items.length, 0),
    largeStringCount: report.largeStrings.length,
    findingCount: report.findings.length,
  }
  // The verdict is decided by FINDINGS ALONE (info findings excluded).
  //
  // WHY plain absolute paths and 8KB+ strings no longer force REVIEW: these
  // fixtures are replay inputs mined from real sessions in this repo, so
  // `/Users/<name>/.../agent-code/...` paths are pervasive and intentional —
  // they are the content the renderer renders. With them verdict-moving,
  // 46/48 committed fixtures came out REVIEW and the verdict carried no
  // information; reviewers stop reading a signal that always fires. Both
  // stay fully REPORTED (paths section, largest-strings section, summary
  // counts) as evidence for a human — they are info, not alarms. The
  // escalation ladder that still moves the verdict:
  //   - secret-shaped content / key-based survivors → block or review
  //   - sensitive path references outside fixture provenance → review
  //   - huge strings (>= HUGE_STRING_BLOCK, far above the extraction
  //     pipeline's own 8000-char text cap) → review
  //   - anything the scanner could not read (parse error, oversized) → review
  report.verdict = blockCount > 0 ? 'BLOCKED' : reviewCount > 0 ? 'REVIEW' : 'LIKELY_SAFE'

  return report
}

function renderList(items, render, limit = 20) {
  if (items.length === 0) return ['  none']
  const shown = items.slice(0, limit).map(render)
  if (items.length > limit) shown.push(`  ... ${items.length - limit} more`)
  return shown
}

function printHuman(report) {
  const lines = []
  lines.push(`# Rendering Fixture Audit`)
  lines.push('')
  lines.push(`Verdict: ${report.verdict}`)
  lines.push(`Input: ${report.input.path}`)
  lines.push(`Kind: ${report.input.kind}`)
  lines.push(`Files scanned: ${report.input.fileCount} (${formatBytes(report.input.totalBytes)})`)
  lines.push('')
  lines.push(`## Metadata`)
  const metaKeys = ['bundleId', 'note', 'kind', 'sessionId', 'capturedAtIso', 'entriesSource', 'projectDir', 'cwd']
  for (const key of metaKeys) {
    if (report.meta[key] !== undefined && report.meta[key] !== null) {
      lines.push(`- ${key}: ${String(report.meta[key])}`)
    }
  }
  lines.push(`- entries: ${report.counts.entries}`)
  lines.push(`- semantic history turns: ${report.counts.semanticHistoryTurns}`)
  lines.push(`- ghosts: ${report.counts.ghosts}`)
  lines.push(`- expected rows: ${report.counts.expectedRows}`)
  lines.push(`- triage items: ${report.counts.triageItems}`)
  lines.push('')

  lines.push(`## Findings`)
  lines.push(...renderList(report.findings, f => {
    const loc = `${f.source}:${f.path}`
    const detail = f.detail ? ` - ${f.detail}` : f.preview ? ` - ${f.preview}` : ''
    return `- [${f.severity}] ${f.kind} at ${loc}${detail}`
  }, 30))
  lines.push('')

  const byRisk = new Map()
  for (const p of report.paths) addMapSet(byRisk, p.risk, p)
  lines.push(`## Paths`)
  for (const [risk, items] of [...byRisk.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${risk} (${items.length})`)
    lines.push(...renderList(items, p => `- ${p.value} (${p.source}:${p.path})`, 20))
  }
  if (report.paths.length === 0) lines.push('  none')
  lines.push('')

  lines.push(`## File Activity`)
  for (const [category, items] of Object.entries(report.fileActivity)) {
    lines.push(`### ${category} (${items.length})`)
    lines.push(...renderList(items, item => `- ${item.file} (${item.source}:${item.path})`, 20))
  }
  lines.push('')

  lines.push(`## Commands (${report.commands.length})`)
  lines.push(...renderList(report.commands, c => `- [${c.kind}] ${c.tool}: ${c.preview} (${c.source}:${c.path})`, 30))
  lines.push('')

  lines.push(`## Largest Strings`)
  lines.push(...renderList(report.largeStrings, s => `- ${s.chars} chars sha=${s.hash} at ${s.source}:${s.path} - ${s.preview}`, 15))
  lines.push('')

  lines.push(`## Summary`)
  for (const [key, value] of Object.entries(report.summary)) lines.push(`- ${key}: ${value}`)
  console.log(lines.join(markdownMode ? '\n' : '\n'))
}

const loaded = loadInput(inputPath)
const report = audit(loaded)

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2))
} else {
  printHuman(report)
}

// Exit semantics (documented in usage()): the verdict is machine-readable so
// automation (pre-commit sweep, CI spot check) cannot mistake "needs a human"
// or "found secret material" for success. 2/3 chosen over 1 so operational
// failures (bad args, unreadable input, gate infrastructure down) stay
// distinguishable from audit outcomes.
process.exit(report.verdict === 'BLOCKED' ? 3 : report.verdict === 'REVIEW' ? 2 : 0)
