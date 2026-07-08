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

import { createHash } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const args = process.argv.slice(2)

function usage() {
  console.log(`Usage:
  node scripts/audit-rendering-fixture.mjs [--json|--markdown] [--max-preview N] <fixture.json|bundle-dir>

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

function readJsonl(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const out = []
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
      out.push(JSON.parse(line))
    } catch (err) {
      out.push({
        __auditParseError: true,
        line: i + 1,
        toleratedTornTail: i === lastNonEmpty,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
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

function loadInput(path) {
  const stat = statSync(path)
  const roots = []
  const files = []
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
      const { skipped, text } = safeReadText(file)
      if (skipped) {
        roots.push({ source: file, value: { __auditSkipped: skipped } })
        continue
      }
      if (ext === '.json') {
        try {
          roots.push({ source: file, value: JSON.parse(text) })
        } catch (err) {
          roots.push({
            source: file,
            value: {
              __auditParseError: true,
              message: err instanceof Error ? err.message : String(err),
              textPreview: preview(text),
            },
          })
        }
      } else if (ext === '.jsonl') {
        roots.push({ source: file, value: readJsonl(file) })
      } else {
        roots.push({ source: file, value: text })
      }
    }
    return { kind: 'bundle-directory', path, roots, files }
  }

  const ext = extname(path)
  files.push({ path, relativePath: basename(path), bytes: stat.size })
  if (ext === '.json') {
    roots.push({ source: path, value: JSON.parse(readFileSync(path, 'utf8')) })
  } else if (ext === '.jsonl') {
    roots.push({ source: path, value: readJsonl(path) })
  } else {
    const { text, skipped } = safeReadText(path)
    roots.push({ source: path, value: skipped ? { __auditSkipped: skipped } : text })
  }
  return { kind: 'file', path, roots, files }
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

    if (lowerName === 'apply_patch' || String(input).includes('*** Begin Patch')) {
      const text = typeof input === 'string' ? input : JSON.stringify(input ?? '')
      for (const p of extractPatchPaths(text)) addFileActivity(report, 'patched', p, source, path)
    }

    const inputRecord = asRecord(input)
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
  report.verdict = blockCount > 0
    ? 'BLOCKED'
    : reviewCount > 0 ||
      sensitivePathCount > 0 ||
      absolutePathCount > 0 ||
      report.largeStrings.length > 0
      ? 'REVIEW'
      : 'LIKELY_SAFE'

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
