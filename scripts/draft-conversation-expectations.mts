// Drafts testing/fixtures/conversations/expectations.json from the LOCAL
// (unredacted) corpus so the user can review readable labels and correct
// kinds. The committed file references only provider ids; the readable draft
// is printed to the terminal and never committed.
//
//   npx tsx --tsconfig tsconfig.node.json scripts/draft-conversation-expectations.mts
//
// WHY the rules here are deliberately naive and separate from the catalog:
// this script exists so the human decides what the catalog must reproduce.
// If it imported the catalog, the expectations would bless the
// implementation (staged-decomposition: "tests written from the same
// imagination that wrote the bug"). Anything the catalog disagrees with is a
// finding to show the user, never a reason to edit this file to match.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const LOCAL = join(REPO, 'testing', 'fixtures', 'conversations', 'local')
const OUT = join(REPO, 'testing', 'fixtures', 'conversations', 'expectations.json')
const manifest = JSON.parse(readFileSync(join(LOCAL, 'manifest.json'), 'utf8')) as { repoRoot: string; worktrees: string[] }
const norm = (p: string) => p.replace(/\/+$/, '').toLowerCase()
const roots = [manifest.repoRoot, ...manifest.worktrees].map(norm)
const inFamily = (cwd: string | null) => !!cwd && roots.some(r => norm(cwd) === r || norm(cwd).startsWith(r + '/'))

type Draft = { key: string; kind: string; labelSource: string; label: string; activity: number; where: string }
const drafts: Draft[] = []
const short = (cwd: string) => cwd.replace(manifest.repoRoot, '<repo>').replace(/^<repo>\/\.worktrees\//, 'wt:')

// Claude: kind from the first user prompt, label from custom > ai-title > first prompt.
const projects = join(LOCAL, 'claude', 'projects')
for (const dir of readdirSync(projects)) {
  for (const name of readdirSync(join(projects, dir)).filter(n => n.endsWith('.jsonl'))) {
    const records = readFileSync(join(projects, dir, name), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as Record<string, unknown>[]
    const cwd = records.find(r => typeof r.cwd === 'string')?.cwd as string | undefined
    if (!inFamily(cwd ?? null)) continue
    const users = records.filter(r => r.type === 'user' && !r.isMeta).map(r => { const c = (r.message as { content?: unknown })?.content; return typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b: { type?: string }) => b.type === 'text') as { text?: string } | undefined)?.text ?? '' : '' }).filter(Boolean)
    const first = users[0] ?? ''
    const aiTitle = [...records].reverse().find(r => r.type === 'ai-title')?.aiTitle as string | undefined
    const custom = [...records].reverse().find(r => typeof r.customTitle === 'string')?.customTitle as string | undefined
    const kind = first.startsWith('<orchestration-handoff>') ? 'orchestration-child' : first.startsWith('# Handoff Summary') || first.startsWith('# Portable handoff summary') ? 'projected' : users.length === 0 && !aiTitle ? 'empty' : 'user'
    const labelSource = custom ? 'provider-name' : aiTitle ? 'ai-title' : first && !first.startsWith('<') ? 'first-prompt' : 'cwd'
    const stat = JSON.parse(readFileSync(join(projects, dir, name + '.stat.json'), 'utf8')) as { mtimeMs: number }
    drafts.push({ key: `claude:${name.slice(0, -6)}`, kind, labelSource, label: (custom ?? aiTitle ?? first).replace(/\s+/g, ' ').slice(0, 70), activity: stat.mtimeMs, where: short(cwd ?? '') })
  }
}
// Codex: from the index.
const db = new DatabaseSync(join(LOCAL, 'codex', 'threads.sqlite'), { readOnly: true })
for (const row of db.prepare('select * from threads').all() as Record<string, unknown>[]) {
  if (!inFamily(row.cwd as string)) continue
  const title = String(row.title ?? '')
  const kind = row.source === 'exec' ? 'exec' : row.thread_source === 'subagent' ? 'native-subagent' : title.startsWith('<orchestration-handoff>') ? 'orchestration-child' : row.originator === 'agent-transcript-parser' ? 'projected' : title ? 'user' : 'empty'
  const name = typeof row.name === 'string' && row.name && !title.startsWith(row.name) ? row.name : null
  drafts.push({ key: `codex:${row.id}`, kind, labelSource: name ? 'provider-name' : title && !title.startsWith('<') ? 'first-prompt' : 'cwd', label: (name ?? title).replace(/\s+/g, ' ').slice(0, 70), activity: Number(row.recency_at_ms ?? row.updated_at_ms ?? 0), where: short(String(row.cwd)) })
}
db.close()
// OpenCode. Its auto-title hides what the first prompt was, so the kind comes
// from the first user text part (the same place the adapter reads it).
const oc = new DatabaseSync(join(LOCAL, 'opencode', 'opencode.sqlite'), { readOnly: true })
const firstParts = oc.prepare(`select p.data as part, m.data as message from part p join message m on m.id = p.message_id
  where m.session_id = ? order by m.time_created asc, p.time_created asc limit 40`)
for (const row of oc.prepare('select * from session').all() as Record<string, unknown>[]) {
  if (!inFamily(row.directory as string)) continue
  let first = ''
  for (const r of firstParts.all(String(row.id)) as Array<{ part: string; message: string }>) {
    try {
      const message = JSON.parse(r.message) as { role?: string }
      const part = JSON.parse(r.part) as { type?: string; text?: string; synthetic?: boolean }
      if (message.role === 'user' && part.type === 'text' && !part.synthetic && part.text?.trim()) { first = part.text.trim(); break }
    } catch { /* skip */ }
  }
  // The app creates OpenCode Terminal sessions with a fixed placeholder title
  // before the user types anything; one with no prompt is an empty shell.
  const placeholder = String(row.title) === 'Agent Code terminal session'
  const kind = row.parent_id ? 'native-subagent' : first.startsWith('<orchestration-handoff>') ? 'orchestration-child' : first.startsWith('# Handoff Summary') || first.startsWith('# Portable handoff summary') ? 'projected' : !first && placeholder ? 'empty' : 'user'
  drafts.push({ key: `opencode:${row.id}`, kind, labelSource: 'ai-title', label: String(row.title).replace(/\s+/g, ' ').slice(0, 70), activity: Number(row.time_updated), where: short(String(row.directory)) })
}
oc.close()

drafts.sort((a, b) => b.activity - a.activity)
const shown = drafts.filter(d => d.kind === 'user' || d.kind === 'projected')
console.log('Default view (top 30, newest activity first):')
console.log('   provider:id                                  kind       source        where                              label')
for (const d of shown.slice(0, 30)) console.log(`  ${d.key.slice(0, 16).padEnd(17)} ${d.kind.padEnd(10)} ${d.labelSource.padEnd(13)} ${d.where.slice(0, 34).padEnd(35)} ${d.label}`)
const byKind = drafts.reduce<Record<string, number>>((acc, d) => { acc[d.kind] = (acc[d.kind] ?? 0) + 1; return acc }, {})
console.log(`\nHidden by default: ${drafts.length - shown.length} of ${drafts.length}; by kind: ${JSON.stringify(byKind)}`)
const expectations = {
  version: 1,
  family: '/fixture/repo',
  kinds: Object.fromEntries(drafts.map(d => [d.key, d.kind])),
  labelSources: Object.fromEntries(drafts.map(d => [d.key, d.labelSource])),
  defaultOrderTop: shown.slice(0, 30).map(d => d.key),
}
writeFileSync(OUT, JSON.stringify(expectations, null, 2) + '\n')
console.log(`\nDraft written to ${OUT} (${drafts.length} conversations). Review the table above with the user before committing.`)
