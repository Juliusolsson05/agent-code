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
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

// The documented rules of docs/decomposition/conversations.md §2.2–2.4,
// restated here by hand (never imported from the catalog).
const NOT_A_PROMPT = ['# AGENTS.md instructions for', '<environment_context>', '<command-name>', '<local-command-caveat>', '<local-command-stdout>', '<recommended_plugins>', '<user_instructions>', '<system-reminder>', '<task-notification>', 'This session is being continued from a previous conversation']
type First = { text: string; wrapper: 'stt' | 'orchestration-handoff' | 'projected-handoff' | null } | null
function firstPromptOf(texts: string[]): First {
  for (const raw of texts) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('<stt')) return { text: t, wrapper: 'stt' }
    if (t.startsWith('<orchestration-handoff>')) return { text: t, wrapper: 'orchestration-handoff' }
    if (t.startsWith('# Handoff Summary') || t.startsWith('# Portable handoff summary')) return { text: t, wrapper: 'projected-handoff' }
    if (NOT_A_PROMPT.some(p => t.startsWith(p)) || t.startsWith('<')) continue
    return { text: t, wrapper: null }
  }
  return null
}
function kindOf(p: { texts: string[]; first: First; aiTitle: string | null; customTitle: string | null; subagent: boolean; exec: boolean; projectedOriginator: boolean }): string {
  if (p.subagent) return 'native-subagent'
  if (p.exec) return 'exec'
  if (p.first?.wrapper === 'orchestration-handoff') return 'orchestration-child'
  if (p.first?.wrapper === 'projected-handoff' || p.projectedOriginator) return 'projected'
  if (p.texts.length === 0 && !p.aiTitle && !p.customTitle) return 'empty'
  return 'user'
}
function labelSourceOf(p: { first: First; aiTitle: string | null; customTitle: string | null; cwd: string | null }): string {
  if (p.customTitle) return 'provider-name'
  if (p.aiTitle) return 'ai-title'
  if (p.first?.text) return 'first-prompt'
  // The last rung: a bridge-session stub has no cwd record at all, so the
  // only name left is the native id (docs/decomposition/conversations.md §2.3).
  return p.cwd ? 'cwd' : 'native-id'
}
// Claude activity = history.jsonl (the catalog's source), else the last user
// record timestamp in the recorded window, else mtime.
const historyLast = new Map<string, number>()
for (const line of readFileSync(join(LOCAL, 'claude', 'history.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue
  try { const h = JSON.parse(line) as { sessionId?: string; timestamp?: number }; if (h.sessionId && typeof h.timestamp === 'number') historyLast.set(h.sessionId, Math.max(historyLast.get(h.sessionId) ?? 0, h.timestamp)) } catch { /* skip */ }
}

// Claude: kind from the first user prompt, label from custom > ai-title > first prompt.
const projects = join(LOCAL, 'claude', 'projects')
for (const dir of readdirSync(projects)) {
  for (const name of readdirSync(join(projects, dir)).filter(n => n.endsWith('.jsonl'))) {
    const records = readFileSync(join(projects, dir, name), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as Record<string, unknown>[]
    const cwd = records.find(r => typeof r.cwd === 'string')?.cwd as string | undefined
    // A transcript without a cwd (a bridge-session stub) is in the family only
    // when its directory IS the root or a worktree, the rule the adapter and
    // the extractor share. The local mirror uses fixture directory names, and
    // every worktree in this corpus lives under `.worktrees/`.
    const exactFamilyDir = dir === '-fixture-repo' || dir.startsWith('-fixture-repo--worktrees-')
    if (cwd ? !inFamily(cwd) : !exactFamilyDir) continue
    const userRecords = records.filter(r => r.type === 'user' && !r.isMeta && (r.message as { role?: string })?.role === 'user')
    const users = userRecords.map(r => { const c = (r.message as { content?: unknown })?.content; return typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b: { type?: string }) => b.type === 'text') as { text?: string } | undefined)?.text ?? '' : '' }).filter(Boolean)
    const first = firstPromptOf(users)
    const aiTitle = ([...records].reverse().find(r => r.type === 'ai-title')?.aiTitle as string | undefined) ?? null
    const custom = ([...records].reverse().find(r => typeof r.customTitle === 'string')?.customTitle as string | undefined) ?? null
    const kind = kindOf({ texts: users, first, aiTitle, customTitle: custom, subagent: false, exec: false, projectedOriginator: false })
    const labelSource = labelSourceOf({ first, aiTitle, customTitle: custom, cwd: cwd ?? null })
    const stat = JSON.parse(readFileSync(join(projects, dir, name + '.stat.json'), 'utf8')) as { mtimeMs: number }
    const id = name.slice(0, -6)
    const lastUserTs = [...userRecords].reverse().map(r => Date.parse(String(r.timestamp ?? ''))).find(Number.isFinite)
    const activity = historyLast.get(id) ?? lastUserTs ?? stat.mtimeMs
    drafts.push({ key: `claude:${id}`, kind, labelSource, label: (custom ?? aiTitle ?? first?.text ?? '').replace(/\s+/g, ' ').slice(0, 70), activity, where: short(cwd ?? '') })
  }
}
// Codex: from the index.
const db = new DatabaseSync(join(LOCAL, 'codex', 'threads.sqlite'), { readOnly: true })
for (const row of db.prepare('select * from threads').all() as Record<string, unknown>[]) {
  if (!inFamily(row.cwd as string)) continue
  const title = (String(row.title ?? '').trim() || String(row.first_user_message ?? '').trim() || String(row.preview ?? '').trim())
  const source = String(row.source ?? '')
  const subagent = row.thread_source === 'subagent' || !!row.agent_role || (source.startsWith('{') && source.includes('"subagent"'))
  const first = firstPromptOf(title ? [title] : [])
  const name = typeof row.name === 'string' && row.name.trim() && !title.startsWith(row.name.trim()) ? row.name.trim() : null
  const kind = kindOf({ texts: title ? [title] : [], first, aiTitle: null, customTitle: name, subagent, exec: source === 'exec', projectedOriginator: row.originator === 'agent-transcript-parser' })
  drafts.push({ key: `codex:${row.id}`, kind, labelSource: labelSourceOf({ first, aiTitle: null, customTitle: name, cwd: String(row.cwd ?? '') || null }), label: (name ?? first?.text ?? title).replace(/\s+/g, ' ').slice(0, 70), activity: Number(row.recency_at_ms ?? row.updated_at_ms ?? 0), where: short(String(row.cwd)) })
}
// Codex rollouts the index has never seen (the adapter's union path): the
// same rules, read from the rollout head the way sources/codex.ts reads it:
// cwd, source and originator from session_meta, prompts from user_message
// events, activity from the last such event, else the recorded mtime.
const indexedIds = new Set((db.prepare('select id from threads').all() as Array<{ id: string }>).map(r => r.id))
const rollouts: string[] = []
const walkRollouts = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkRollouts(full)
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) rollouts.push(full)
  }
}
walkRollouts(join(LOCAL, 'codex', 'sessions'))
const seenUnindexed = new Set<string>()
for (const file of rollouts.sort()) {
  const id = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1] ?? ''
  if (!id || indexedIds.has(id) || seenUnindexed.has(id)) continue
  seenUnindexed.add(id)
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as Record<string, unknown>[]
  const meta = (records.find(r => r.type === 'session_meta')?.payload ?? {}) as Record<string, unknown>
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : null
  if (!inFamily(cwd)) continue
  const userEvents = records.filter(r => r.type === 'event_msg' && (r.payload as { type?: string })?.type === 'user_message')
  const users = userEvents.map(r => String((r.payload as { message?: unknown }).message ?? '')).filter(Boolean)
  const lastUserTs = [...userEvents].reverse().map(r => Date.parse(String(r.timestamp ?? ''))).find(Number.isFinite)
  const source = typeof meta.source === 'string' ? meta.source : meta.source ? JSON.stringify(meta.source) : ''
  const first = firstPromptOf(users)
  const kind = kindOf({ texts: users, first, aiTitle: null, customTitle: null, subagent: source.includes('"subagent"'), exec: source === 'exec', projectedOriginator: meta.originator === 'agent-transcript-parser' })
  const stat = JSON.parse(readFileSync(file + '.stat.json', 'utf8')) as { mtimeMs: number }
  drafts.push({ key: `codex:${id}`, kind, labelSource: labelSourceOf({ first, aiTitle: null, customTitle: null, cwd }), label: (first?.text ?? '').replace(/\s+/g, ' ').slice(0, 70), activity: lastUserTs ?? stat.mtimeMs, where: short(cwd ?? '') })
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
  // before the user types anything; that title counts as no title at all.
  const aiTitle = String(row.title ?? '').trim() === 'Agent Code terminal session' ? null : (String(row.title ?? '').trim() || null)
  const texts = first ? [first] : []
  const f = firstPromptOf(texts)
  const kind = kindOf({ texts, first: f, aiTitle, customTitle: null, subagent: !!row.parent_id, exec: false, projectedOriginator: false })
  drafts.push({ key: `opencode:${row.id}`, kind, labelSource: labelSourceOf({ first: f, aiTitle, customTitle: null, cwd: String(row.directory ?? '') || null }), label: (aiTitle ?? f?.text ?? '').replace(/\s+/g, ' ').slice(0, 70), activity: Number(row.time_updated), where: short(String(row.directory)) })
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
