// Records the machine's provider stores into the conversation corpus.
//
//   UPDATE_FIXTURES=1 npx tsx --tsconfig tsconfig.node.json scripts/extract-conversation-corpus.mts
//   npx tsx --tsconfig tsconfig.node.json scripts/extract-conversation-corpus.mts --verify-checked-in
//
// WHY this exists (docs/decomposition/conversations.md, Stage 0): the listers
// this corpus replaces were written against imagined transcript shapes, and
// every one of those assumptions is false on disk today. Every test in the
// rebuild reads this recording instead.
//
// Two outputs from one pass: the committed corpus (redacted through
// scripts/conversation-corpus-policy.ts) and a git-ignored local mirror used
// by the live suite and by the author when a redacted fixture is not enough.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createPathRewriter, redactRecord, redactValue } from './conversation-corpus-policy.js'
import { sanitizePath } from '../src/shared/runtime/projectDir.js'

const HOME = homedir()
const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..')
const OUT = join(REPO, 'testing', 'fixtures', 'conversations')
const LOCAL = join(OUT, 'local')
const VERIFY = process.argv.includes('--verify-checked-in')
const UPDATE = process.env.UPDATE_FIXTURES === '1'
const HEAD_RECORDS = 40
const TAIL_RECORDS = 20
const ROLLOUT_HEAD_RECORDS = 25
const ROLLOUT_SAMPLE = 8

type Json = Record<string, unknown>

const norm = (p: string) => p.replace(/\/+$/, '').toLowerCase()
// WHY the family is resolved through `git worktree list` here too: the corpus
// must record the same membership the family resolver (src/main/conversations/
// family.ts) computes, or the manifest counts would argue from a different
// definition than the code under test. The first porcelain entry is the main
// checkout, which is the family root even when this script runs from a
// worktree (it does: the branch lives in .worktrees/session-picker).
const worktreePaths = (() => {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO, encoding: 'utf8', timeout: 5000 })
    const listed = out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length))
    return listed.length > 0 ? listed : [REPO]
  } catch {
    return [REPO]
  }
})()
const FAMILY_ROOT = process.env.CORPUS_FAMILY_ROOT ?? worktreePaths[0]!
const paths = createPathRewriter(HOME, FAMILY_ROOT)
const familyRoots = [FAMILY_ROOT, ...worktreePaths].map(norm)
const inFamily = (cwd: string | null | undefined): boolean => {
  if (!cwd) return false
  const c = norm(cwd)
  return familyRoots.some(r => c === r || c.startsWith(r + '/'))
}

function parseLines(text: string): Json[] {
  const out: Json[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as Json) } catch { /* partial write */ }
  }
  return out
}

async function writeBoth(relative: string, redacted: string | Buffer, raw: string | Buffer): Promise<void> {
  const target = join(OUT, relative)
  const local = join(LOCAL, relative)
  await mkdir(dirname(target), { recursive: true })
  await mkdir(dirname(local), { recursive: true })
  await writeFile(target, redacted)
  await writeFile(local, raw)
}

function firstUserText(records: Json[]): string | null {
  for (const r of records) {
    if (r.type !== 'user' || r.isMeta === true) continue
    const m = r.message as Json | undefined
    const c = m?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const t = (c as Json[]).find(b => b.type === 'text' && typeof b.text === 'string')
      if (t) return t.text as string
    }
  }
  return null
}

// ---------------------------------------------------------------- Claude
async function extractClaude(counts: Json): Promise<void> {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude'), 'projects')
  const dirs = (await readdir(projects, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
  let transcripts = 0, family = 0, children = 0, projectDirs = 0
  const familySessionIds = new Set<string>()
  const sanitizedRoot = sanitizePath(FAMILY_ROOT)
  const sanitizedWorktrees = worktreePaths.map(sanitizePath)
  // One unrelated project dir is recorded as a negative control so scope tests
  // can prove "repository" excludes it while "everywhere" includes it.
  const control = dirs
    .filter(d => !d.startsWith(sanitizedRoot) && !sanitizedWorktrees.includes(d) && d.startsWith('-Users-'))
    .map(d => ({ d, n: readdirSync(join(projects, d)).filter(n => n.endsWith('.jsonl')).length }))
    .sort((a, b) => b.n - a.n)[0]?.d ?? null
  for (const dir of dirs) {
    const candidate = dir === sanitizedRoot || dir.startsWith(sanitizedRoot + '-') || sanitizedWorktrees.includes(dir) || dir === control
    if (!candidate) continue
    projectDirs++
    const names = (await readdir(join(projects, dir))).filter(n => n.endsWith('.jsonl'))
    for (const name of names) {
      const file = join(projects, dir, name)
      const raw = await readFile(file, 'utf8')
      const records = parseLines(raw)
      transcripts++
      const cwd = records.find(r => typeof r.cwd === 'string')?.cwd as string | undefined
      const isFamily = inFamily(cwd) || (!cwd && dir === sanitizedRoot)
      if (isFamily) {
        family++
        familySessionIds.add(name.slice(0, -6))
        if ((firstUserText(records) ?? '').startsWith('<orchestration-handoff>')) children++
      }
      const head = records.slice(0, HEAD_RECORDS)
      const tail = records.length > HEAD_RECORDS + TAIL_RECORDS ? records.slice(-TAIL_RECORDS) : records.slice(HEAD_RECORDS)
      const gap = records.length - head.length - tail.length
      const kept = gap > 0 ? [...head, { $corpus: 'gap', skipped: gap }, ...tail] : [...head, ...tail]
      const redacted = kept.map(r => JSON.stringify(r.$corpus ? r : redactRecord(r, paths))).join('\n') + '\n'
      const local = kept.map(r => JSON.stringify(r)).join('\n') + '\n'
      // The fixture dir name must be what sanitizePath yields for the REWRITTEN
      // cwd, or the adapter's directory resolution cannot find it.
      const fixtureDir = cwd ? sanitizePath(paths.rewrite(cwd)) : sanitizePath('/fixture/repo')
      const s = await stat(file)
      const sidecar = JSON.stringify({ mtimeMs: s.mtimeMs, size: s.size, records: records.length })
      await writeBoth(join('claude', 'projects', fixtureDir, name), redacted, local)
      await writeBoth(join('claude', 'projects', fixtureDir, name + '.stat.json'), sidecar, sidecar)
    }
  }
  // history.jsonl slice: every record whose session is in the family, plus the
  // control project's records, so search tests have both hits and misses.
  const history = parseLines(await readFile(join(dirname(projects), 'history.jsonl'), 'utf8'))
  const slice = history.filter(h => familySessionIds.has(String(h.sessionId)) || (control !== null && typeof h.project === 'string' && sanitizePath(h.project) === control))
  await writeBoth(join('claude', 'history.jsonl'), slice.map(h => JSON.stringify(redactRecord(h, paths))).join('\n') + '\n', slice.map(h => JSON.stringify(h)).join('\n') + '\n')
  const porcelain = worktreePaths.map(p => `worktree ${paths.rewrite(p)}\n`).join('')
  await writeBoth(join('claude', 'worktrees.porcelain'), porcelain, worktreePaths.map(p => `worktree ${p}\n`).join(''))
  counts.claude = { projectDirs, transcripts, inFamily: family, orchestrationChildren: children, historyRecords: slice.length, control: control ? sanitizePath(paths.rewrite(control.replace(/-/g, '/'))) : null }
}

// ----------------------------------------------------------------- Codex
function newestStateDb(codexHome: string): string | null {
  const names = readdirSync(codexHome).filter(n => /^state_\d+\.sqlite$/.test(n))
  names.sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))
  return names[0] ? join(codexHome, names[0]) : null
}

async function extractCodex(counts: Json): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? join(HOME, '.codex')
  const dbPath = newestStateDb(codexHome)
  if (!dbPath) throw new Error('No Codex state_N.sqlite found; the corpus needs the index')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const columns = (db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>).map(c => c.name)
  const rows = db.prepare('select * from threads').all() as Json[]
  const edges = db.prepare('select * from thread_spawn_edges').all() as Json[]
  const migrations = db.prepare('select * from _sqlx_migrations').all() as Json[]
  db.close()
  const familyRows = rows.filter(r => inFamily(r.cwd as string))
  // Keep every family row plus a bounded slice of others as the negative
  // control, so "everywhere" has something to find and "repository" something
  // to exclude.
  const control = rows.filter(r => !inFamily(r.cwd as string)).sort((a, b) => Number(b.recency_at_ms ?? 0) - Number(a.recency_at_ms ?? 0)).slice(0, 25)
  const kept = [...familyRows, ...control]
  const keptIds = new Set(kept.map(r => r.id as string))
  const keptEdges = edges.filter(e => keptIds.has(e.child_thread_id as string) || keptIds.has(e.parent_thread_id as string))
  for (const variant of ['redacted', 'raw'] as const) {
    const target = variant === 'redacted' ? join(OUT, 'codex', 'threads.sqlite') : join(LOCAL, 'codex', 'threads.sqlite')
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { force: true })
    const out = new DatabaseSync(target)
    out.exec(`create table threads (${columns.map(c => `"${c}"`).join(', ')});`)
    out.exec('create table thread_spawn_edges (parent_thread_id text not null, child_thread_id text not null primary key, status text not null);')
    out.exec('create table _sqlx_migrations (version bigint primary key, description text not null, installed_on timestamp not null, success boolean not null, checksum blob not null, execution_time bigint not null);')
    const insert = out.prepare(`insert into threads (${columns.map(c => `"${c}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`)
    for (const row of kept) {
      const value = variant === 'redacted' ? (redactRecord(row, paths) as Json) : row
      insert.run(...columns.map(c => (value[c] === undefined ? null : value[c]) as null | number | string | Uint8Array))
    }
    const insertEdge = out.prepare('insert into thread_spawn_edges values (?, ?, ?)')
    for (const e of keptEdges) insertEdge.run(String(e.parent_thread_id), String(e.child_thread_id), String(e.status))
    const insertMigration = out.prepare('insert into _sqlx_migrations values (?, ?, ?, ?, ?, ?)')
    for (const m of migrations) insertMigration.run(Number(m.version), String(m.description), String(m.installed_on), Number(m.success), m.checksum as Uint8Array, Number(m.execution_time))
    out.close()
  }
  // Sample rollouts for the fallback path: newest family rows across kinds,
  // plus one child, one originated by agent-transcript-parser and one exec run.
  const byKind = (pred: (r: Json) => boolean, n: number) => familyRows.filter(pred).sort((a, b) => Number(b.recency_at_ms ?? 0) - Number(a.recency_at_ms ?? 0)).slice(0, n)
  const sampled = [
    ...byKind(r => r.source === 'cli' && r.thread_source !== 'subagent' && !String(r.title).startsWith('<'), ROLLOUT_SAMPLE - 3),
    ...byKind(r => String(r.title).startsWith('<orchestration-handoff>'), 1),
    ...byKind(r => r.originator === 'agent-transcript-parser', 1),
    ...byKind(r => r.source === 'exec', 1),
  ]
  let sampledCount = 0
  for (const row of sampled) {
    const file = row.rollout_path as string
    if (!existsSync(file)) continue
    const records = parseLines(await readFile(file, 'utf8')).slice(0, ROLLOUT_HEAD_RECORDS)
    const relative = file.slice(codexHome.length + 1)
    await writeBoth(join('codex', relative), records.map(r => JSON.stringify(redactRecord(r, paths))).join('\n') + '\n', records.map(r => JSON.stringify(r)).join('\n') + '\n')
    sampledCount++
  }
  // Unindexed rollouts: count only, plus the newest three as fixtures so the
  // union path has something real to find.
  const onDisk: string[] = []
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const s = statSync(full)
      if (s.isDirectory() && depth < 3) walk(full, depth + 1)
      else if (s.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) onDisk.push(full)
    }
  }
  walk(join(codexHome, 'sessions'), 0)
  const indexedPaths = new Set(rows.map(r => r.rollout_path as string))
  const unindexed = onDisk.filter(p => !indexedPaths.has(p)).sort().reverse()
  for (const file of unindexed.slice(0, 3)) {
    const records = parseLines(await readFile(file, 'utf8')).slice(0, ROLLOUT_HEAD_RECORDS)
    const relative = file.slice(codexHome.length + 1)
    await writeBoth(join('codex', relative), records.map(r => JSON.stringify(redactRecord(r, paths))).join('\n') + '\n', records.map(r => JSON.stringify(r)).join('\n') + '\n')
  }
  counts.codex = {
    indexed: rows.length, inFamily: familyRows.length, control: control.length,
    exec: familyRows.filter(r => r.source === 'exec').length,
    subagents: familyRows.filter(r => r.thread_source === 'subagent').length,
    orchestrationChildren: familyRows.filter(r => String(r.title).startsWith('<orchestration-handoff>')).length,
    sampledRollouts: sampledCount, unindexedOnDisk: unindexed.length, unindexedSampled: Math.min(3, unindexed.length), columns,
  }
}

// -------------------------------------------------------------- OpenCode
async function extractOpencode(counts: Json): Promise<void> {
  const dataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode') : join(HOME, '.local', 'share', 'opencode')
  const dbPath = join(dataDir, 'opencode.db')
  if (!existsSync(dbPath)) { counts.opencode = { sessions: 0, inFamily: 0, control: 0, children: 0, absent: true }; return }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const sessions = db.prepare('select * from session').all() as Json[]
  const projects = db.prepare('select * from project').all() as Json[]
  const familySessions = sessions.filter(s => inFamily(s.directory as string))
  const control = sessions.filter(s => !inFamily(s.directory as string)).sort((a, b) => Number(b.time_updated) - Number(a.time_updated)).slice(0, 10)
  const kept = [...familySessions, ...control]
  const keptIds = kept.map(s => s.id as string)
  const placeholders = keptIds.map(() => '?').join(', ')
  // Only the first six messages per session and their parts: the adapter
  // reads the first user texts, and the whole message store for the family is
  // 31,000 parts (13 MB) that no test needs.
  const messages: Json[] = []
  const firstMessages = db.prepare('select * from message where session_id = ? order by time_created asc limit 6')
  for (const id of keptIds) messages.push(...(firstMessages.all(id) as Json[]))
  const messageIds = messages.map(m => m.id as string)
  const parts: Json[] = []
  const partsOf = db.prepare('select * from part where message_id = ? order by time_created asc')
  for (const id of messageIds) parts.push(...(partsOf.all(id) as Json[]))
  db.close()
  const tableColumns = (rows: Json[]) => Object.keys(rows[0] ?? {})
  for (const variant of ['redacted', 'raw'] as const) {
    const target = variant === 'redacted' ? join(OUT, 'opencode', 'opencode.sqlite') : join(LOCAL, 'opencode', 'opencode.sqlite')
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { force: true })
    const out = new DatabaseSync(target)
    const write = (table: string, rows: Json[]) => {
      const cols = tableColumns(rows)
      if (cols.length === 0) { out.exec(`create table "${table}" (id text primary key);`); return }
      out.exec(`create table "${table}" (${cols.map(c => `"${c}"`).join(', ')});`)
      const insert = out.prepare(`insert into "${table}" (${cols.map(c => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`)
      for (const row of rows) {
        // message.data and part.data are JSON strings: parse, redact as a
        // record, and re-stringify so role/type survive but text hashes.
        const value: Json = { ...row }
        if (typeof value.data === 'string') {
          try { value.data = JSON.stringify(variant === 'redacted' ? redactRecord(JSON.parse(value.data), paths) : JSON.parse(value.data)) } catch { /* keep as is */ }
        }
        const redacted = variant === 'redacted'
          ? (Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'data' ? v : redactValue(k, v, paths)])) as Json)
          : value
        insert.run(...cols.map(c => (redacted[c] === undefined ? null : redacted[c]) as null | number | string | Uint8Array))
      }
    }
    write('session', kept)
    write('project', projects)
    write('message', messages)
    write('part', parts)
    out.close()
  }
  counts.opencode = { sessions: sessions.length, inFamily: familySessions.length, control: control.length, children: familySessions.filter(s => s.parent_id).length, messages: messages.length, parts: parts.length }
}

// ------------------------------------------------------------------ main
async function verifyCheckedIn(): Promise<void> {
  // The committed corpus must satisfy the policy: re-running redaction over
  // every committed JSONL record must be a no-op. Only JSONL is checked; the
  // sqlite files are produced by the same code path from the same records and
  // the manifest holds counts, not content.
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'local') continue
      const p = join(dir, e.name)
      e.isDirectory() ? walk(p) : files.push(p)
    }
  }
  walk(OUT)
  const verifier = createPathRewriter('/fixture/home', '/fixture/repo')
  let violations = 0
  let records = 0
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    for (const r of parseLines(readFileSync(file, 'utf8'))) {
      if (r.$corpus) continue
      records++
      const again = JSON.stringify(redactRecord(r, verifier))
      if (again !== JSON.stringify(r)) {
        violations++
        console.error(`policy drift: ${file}`)
        break
      }
    }
  }
  if (violations > 0) {
    console.error(`${violations} file(s) hold values the policy would still redact`)
    process.exit(1)
  }
  console.log(`Conversation corpus verified: ${files.length} files, ${records} JSONL records`)
}

async function main(): Promise<void> {
  if (VERIFY) {
    await verifyCheckedIn()
    return
  }
  if (!UPDATE) {
    console.error('Refusing to write: set UPDATE_FIXTURES=1 to regenerate, or pass --verify-checked-in.')
    process.exit(2)
  }
  // Keep the hand-authored expectations across regenerations; everything else
  // is derived and rebuilt.
  let expectations: string | null = null
  try { expectations = await readFile(join(OUT, 'expectations.json'), 'utf8') } catch { expectations = null }
  let readme: string | null = null
  try { readme = await readFile(join(OUT, 'README.md'), 'utf8') } catch { readme = null }
  await rm(OUT, { recursive: true, force: true })
  await mkdir(LOCAL, { recursive: true })
  if (expectations !== null) await writeFile(join(OUT, 'expectations.json'), expectations)
  if (readme !== null) await writeFile(join(OUT, 'README.md'), readme)
  const counts: Json = {}
  await extractClaude(counts)
  await extractCodex(counts)
  await extractOpencode(counts)
  const manifest = {
    version: 1,
    capturedAt: new Date().toISOString(),
    repoRoot: '/fixture/repo',
    worktrees: worktreePaths.map(p => paths.rewrite(p)),
    // Only the count of other projects is committed: their directory names
    // are the author's private project list.
    otherProjects: Object.keys(paths.others()).length,
    counts,
  }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(LOCAL, 'manifest.json'), JSON.stringify({ ...manifest, repoRoot: FAMILY_ROOT, worktrees: worktreePaths, home: HOME, others: paths.others() }, null, 2) + '\n')
  console.log(JSON.stringify(counts, null, 2))
}

await main()
