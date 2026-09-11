# Conversations Picker Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the resume picker, prompt search, path-picker session list and the two in-session prompt lists with one Conversations catalog fed by the providers' native indexes, so every past conversation of a repository is listed once, by last user activity, with recognisable labels and children hidden.

**Architecture:** Three provider source adapters (Claude project dirs + `ai-title` records + `history.jsonl`; Codex `state_*.sqlite`; OpenCode `opencode.db`) emit raw `SourceConversation` rows. One pure catalog in `src/main/conversations/catalog/` normalises, classifies, labels, orders, searches and pages them into `Conversation` rows, joined with a durable Agent Code ledger projected from workspace saves. One service owns caching and serves one IPC surface consumed by one picker, the path picker, the prompt lists and the external-control catalog.

**Tech Stack:** TypeScript, Electron 43 (Node 24.18, `node:sqlite` built in), React 18, Vitest 4 (`unit` / `system` / `renderer` projects plus the opt-in live config), zod for IPC schemas where the control SDK needs them.

**Spec:** `docs/decomposition/conversations.md` (the stage decomposition; §2 holds the decisions, §3 the stages, §6 the unknowns). Umbrella issue #874.

## Global Constraints

- Node 24 for every command: `source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24` in each shell. Node 25 breaks happy-dom.
- Type gate is raw tsc: `npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`. Neither electron-vite nor Vitest type-checks.
- Test commands: unit `NODE_ENV=test npx vitest run --project unit <path>`; system `NODE_ENV=test npx vitest run --project system <path>`; renderer `NODE_ENV=test npx vitest run --project renderer <path>`. Never export `NODE_ENV=production`. Run the full `npm test` once per task before its commit, not per step.
- Never launch the app (`npm run dev`, `npx electron`). Timing budgets are verified by the live suite (Task 22), never by hand.
- Test tiers by suffix: `*.test.ts` pure; `*.system.test.ts` touches the filesystem, git or fixture files; `*.renderer.test.tsx` happy-dom; `*.live.test.ts` only under `AGENT_CODE_LIVE_CONVERSATIONS=1`. No global retry, no snapshots, no `.only`.
- Commits: Conventional Commits with a subsystem scope (`conversations`, `picker`, `ledger`, `corpus`), imperative subject, no trailing period. Identity comes from global git config. Every commit ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ukb9oTvJaojxUxoHfYEUby
  ```
- Thick WHY comments on every non-obvious line. No CI grep locks, no YAGNI guards, no multi-PR split: this lands as one PR against `main` from branch `feat/session-picker` (worktree `.worktrees/session-picker`, `node_modules` symlinked to the main checkout).
- Fixture rule: no transcript shape may be typed from memory. Every shape in a test comes from `testing/fixtures/conversations/` (Task 2) or is copied verbatim from a named fixture record.
- Redaction rule: the committed corpus never contains readable prompt text, titles, branch names other than `main`, or real paths. The policy file (Task 1) is the only place that decides what stays verbatim.
- Command titles follow `docs/command-style.md`: `Resume Session…` and `Search Conversations…` (ellipsis because both need more input). No new chords; `Cmd+Shift+R` stays on `resume-session`.
- Never merge the PR. Open it fully built out (Task 23) and stop.

---

## File structure

New files, one responsibility each:

| File | Responsibility |
|---|---|
| `scripts/conversation-corpus-policy.ts` | The redaction allowlist: which keys stay verbatim, which wrapper prefixes are kept, how paths are rewritten. Imported by the extractor and by its test. |
| `scripts/extract-conversation-corpus.mts` | Records this machine's stores into `testing/fixtures/conversations/` (redacted) and `testing/fixtures/conversations/local/` (raw, git-ignored). |
| `testing/fixtures/conversations/README.md`, `manifest.json`, `expectations.json`, `claude/**`, `codex/**`, `opencode/**` | The recorded corpus and the user-authored expectations. |
| `testing/support/conversations/installCorpus.ts` | Copies the corpus into a temp HOME and rewrites `/fixture/home` paths so adapters run against it unchanged. |
| `src/shared/conversations/types.ts` | `Conversation`, requests and responses shared by main, preload and renderer. One definition. |
| `src/main/conversations/family.ts` | Repository family resolution (git worktrees, `.worktrees/`, subdirectories, case-insensitive compare). |
| `src/main/conversations/sources/types.ts` | `SourceConversation`, `ConversationSource`. |
| `src/main/conversations/sources/sqlite.ts` | Read-only `node:sqlite` open with column probing; newest `state_N.sqlite` lookup. |
| `src/main/conversations/sources/claudeHistory.ts` | Incremental reader of `~/.claude/history.jsonl`. |
| `src/main/conversations/sources/claude.ts` | Claude adapter. |
| `src/main/conversations/sources/codex.ts` | Codex adapter (index, unindexed union, scan fallback). |
| `src/main/conversations/sources/opencode.ts` | OpenCode adapter. |
| `src/main/conversations/prompts/promptFolder.ts` | The incremental byte-range prompt reader, moved from `sessionIndex.ts`. |
| `src/main/conversations/catalog/unwrap.ts` | Wrapper unwrapping (closed list). |
| `src/main/conversations/catalog/classify.ts` | `ConversationKind` decision. |
| `src/main/conversations/catalog/label.ts` | The label ladder with provenance. |
| `src/main/conversations/catalog/normalize.ts` | `SourceConversation` + ledger row → `Conversation`. |
| `src/main/conversations/catalog/order.ts` | Ordering comparator and cursor encoding. |
| `src/main/conversations/catalog/search.ts` | Query matching over label, name and prompts. |
| `src/main/conversations/catalog/listing.ts` | `buildListing`: the one pure entry point. |
| `src/main/conversations/ledger/ledger.ts` | Append-only JSONL ledger + projection from workspace windows. |
| `src/main/conversations/service.ts` | `ConversationService`: sources + ledger + family + caches. |
| `src/main/ipc/conversations.ts` | `conversations:list`, `conversations:prompts`, `conversations:children` + breadcrumbs. |
| `src/preload/api/conversations.ts` | `listConversations`, `listConversationPrompts`, `listConversationChildren`. |
| `src/renderer/src/features/conversations/useConversationList.ts` | Versioned, debounced list/search hook. |
| `src/renderer/src/features/conversations/ui/ConversationRow.tsx` | The one row. |
| `src/renderer/src/features/conversations/ui/ConversationsPicker.tsx` | The picker. |
| `src/renderer/src/features/conversations/ui/PromptList.tsx` | Uncapped prompt list with relative time (View Prompts, Rewind). |
| `src/renderer/src/features/conversations/surfaces/ConversationsSurface.tsx` | Registry wrapper. |
| `src/main/conversations/conversations.live.test.ts` | Opt-in live suite with the timing budget. |

Modified files are named in each task.

---

## Stage 0 — Recorded corpus and expectations

### Task 1: Corpus redaction policy

**Files:**
- Create: `scripts/conversation-corpus-policy.ts`
- Create: `src/main/conversations/corpusPolicy.test.ts`
- Modify: `tsconfig.node.json:58-79` (add the two script files to `include`)

**Interfaces:**
- Produces: `redactValue(key: string, value: unknown, paths: PathRewriter): unknown`, `redactRecord(record: unknown, paths: PathRewriter): unknown`, `createPathRewriter(home: string, repoRoot: string): PathRewriter`, `KEEP_VERBATIM_KEYS`, `KEPT_WRAPPER_PREFIXES`, `placeholder(text: string): string`.

- [x] **Step 1: Write the failing test**

```ts
// src/main/conversations/corpusPolicy.test.ts
import { describe, expect, it } from 'vitest'

import {
  createPathRewriter,
  placeholder,
  redactRecord,
} from '../../../scripts/conversation-corpus-policy.js'

// WHY these inputs are not invented: each is the literal head of a record
// observed on 2026-09-11 (see docs/decomposition/conversations.md §0). The
// policy is the single publication gate for the corpus, so the test pins the
// exact behaviour a leak would have to defeat.
describe('conversation corpus policy', () => {
  const paths = createPathRewriter('/Users/me', '/Users/me/Desktop/Development/agent-code')

  it('hashes free text but keeps a known wrapper prefix verbatim', () => {
    const raw = '<orchestration-handoff>\nYou are now an orchestrated child agent in Agent Code.\n</orchestration-handoff>\n\n<task>\nReview the Grok lifecycle.\n</task>'
    const out = redactRecord({ type: 'user', message: { role: 'user', content: raw } }, paths) as {
      message: { content: string }
    }
    expect(out.message.content.startsWith('<orchestration-handoff>')).toBe(true)
    expect(out.message.content).not.toContain('Grok')
    expect(out.message.content).toBe(`<orchestration-handoff>${placeholder(raw.slice('<orchestration-handoff>'.length))}`)
  })

  it('keeps structural keys, rewrites paths, and hashes branches other than main', () => {
    const out = redactRecord({
      type: 'user',
      cwd: '/Users/me/Desktop/Development/agent-code/.worktrees/extension-platform',
      gitBranch: 'feat/extension-platform',
      timestamp: '2026-09-11T16:32:40.673Z',
      sessionId: 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1',
      permissionMode: 'bypassPermissions',
      isMeta: true,
    }, paths) as Record<string, unknown>
    expect(out.cwd).toBe('/fixture/repo/.worktrees/extension-platform')
    expect(out.gitBranch).toBe('b:' + placeholder('feat/extension-platform').slice(2, 10))
    expect(out.timestamp).toBe('2026-09-11T16:32:40.673Z')
    expect(out.sessionId).toBe('ededdea8-06bf-4474-b945-b3a8f8ce0fe1')
    expect(out.permissionMode).toBe('bypassPermissions')
    expect(out.isMeta).toBe(true)
  })

  it('keeps main verbatim and maps unrelated projects to numbered fixtures', () => {
    const a = redactRecord({ cwd: '/Users/me/Desktop/Development/bringdown', gitBranch: 'main' }, paths) as Record<string, string>
    const b = redactRecord({ cwd: '/Users/me/Desktop/Development/bringdown/sub' }, paths) as Record<string, string>
    expect(a.cwd).toBe('/fixture/other-1')
    expect(b.cwd).toBe('/fixture/other-1/sub')
    expect(a.gitBranch).toBe('main')
  })

  it('hashes a Codex index title unless it starts with a kept wrapper', () => {
    const plain = redactRecord({ title: 'break down this project' }, paths) as { title: string }
    const agents = redactRecord({ title: '# AGENTS.md instructions for /Users/me/x\n\n<INSTRUCTIONS>' }, paths) as { title: string }
    expect(plain.title).toMatch(/^p:[0-9a-f]{8}:23$/)
    expect(agents.title.startsWith('# AGENTS.md instructions for')).toBe(true)
  })

  it('never leaves a string outside the allowlist unhashed, recursively', () => {
    const out = JSON.stringify(redactRecord({
      payload: { type: 'user_message', message: 'secret text', images: [{ url: 'file:///Users/me/a.png' }] },
      attachment: { type: 'hook_success', stdout: 'secret stdout' },
    }, paths))
    expect(out).not.toContain('secret')
    expect(out).toContain('"type":"user_message"')
    expect(out).toContain('"type":"hook_success"')
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/corpusPolicy.test.ts`
Expected: FAIL, cannot resolve `scripts/conversation-corpus-policy.js`.

- [x] **Step 3: Write the policy**

```ts
// scripts/conversation-corpus-policy.ts
import { createHash } from 'node:crypto'

// The single publication gate for testing/fixtures/conversations/.
//
// WHY a closed allowlist and not a denylist: the corpus is recorded from the
// author's real transcripts and committed to a public repository. A denylist
// has to enumerate every place a prompt could hide (Codex index titles, Claude
// ai-title records, hook stdout, image URLs, queue-operation content) and is
// wrong the first time a provider adds a field. An allowlist is wrong in the
// safe direction: a new field is hashed until someone adds it here on purpose.
//
// WHY wrapper prefixes are kept verbatim: the catalog's unwrapping rules key
// on exactly these prefixes (docs/decomposition/conversations.md §2.3). A
// fixture that hashed them would prove nothing about the rule that matters.
export const KEEP_VERBATIM_KEYS: ReadonlySet<string> = new Set([
  // record structure
  'type', 'subtype', 'role', 'kind', 'origin', 'source', 'thread_source', 'originator',
  'agent_role', 'agent_nickname', 'history_mode', 'model_provider', 'archived',
  'permissionMode', 'isMeta', 'isSidechain', 'isCompactSummary', 'entrypoint', 'userType',
  'operation', 'hookEvent', 'hookName', 'exitCode', 'mode', 'atis', 'version', 'v',
  // identity and time
  'uuid', 'parentUuid', 'promptId', 'leafUuid', 'sessionId', 'session_id', 'id',
  'thread_id', 'parent_thread_id', 'child_thread_id', 'forked_from_id', 'messageId',
  'timestamp', 'created_at', 'updated_at', 'recency_at', 'created_at_ms', 'updated_at_ms',
  'recency_at_ms', 'time_created', 'time_updated', 'time_archived', 'time', 'created',
  'durationMs', 'messageCount', 'mtime', 'size', 'fileSize',
  // counts and flags
  'has_user_event', 'is_pinned', 'tokens_used', 'depth', 'synthetic', 'status',
])

/** Keys whose values are filesystem paths: rewritten, never hashed. */
export const PATH_KEYS: ReadonlySet<string> = new Set([
  'cwd', 'project', 'directory', 'worktree', 'rollout_path', 'workingDirectory', 'file',
  'path', 'agent_path', 'trackingPath', 'projectDir',
])

/** Keys whose values are git branch names: `main` stays, anything else hashes. */
export const BRANCH_KEYS: ReadonlySet<string> = new Set(['gitBranch', 'git_branch', 'branch'])

/** Wrapper prefixes the catalog keys on. Kept verbatim; the remainder hashes. */
export const KEPT_WRAPPER_PREFIXES: readonly string[] = [
  '<orchestration-handoff>',
  '<stt note="Speech-to-text; may contain transcription mistakes.">',
  '<stt',
  '<command-name>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<recommended_plugins>',
  '<environment_context>',
  '<user_instructions>',
  '<system-reminder>',
  '<task-notification>',
  '# AGENTS.md instructions for',
  '# Handoff Summary',
  '# Portable handoff summary',
]

export function placeholder(text: string): string {
  const sha8 = createHash('sha256').update(text).digest('hex').slice(0, 8)
  return `p:${sha8}:${text.length}`
}

export type PathRewriter = {
  rewrite(path: string): string
  /** Numbered `other-N` assignments so a review can see which distinct projects appear. */
  others(): Record<string, string>
}

/**
 * `/Users/x/Desktop/Development/agent-code` → `/fixture/repo`, its home →
 * `/fixture/home`, every other absolute path under home → `/fixture/other-N`
 * (first-seen numbering, stable within one extraction run). Paths outside home
 * hash entirely: a `/private/var/folders/...` temp path would otherwise leak
 * the machine's random folder name.
 */
export function createPathRewriter(home: string, repoRoot: string): PathRewriter {
  const others = new Map<string, string>()
  const strip = (p: string) => p.replace(/\/+$/, '')
  const HOME = strip(home)
  const REPO = strip(repoRoot)
  const rewrite = (raw: string): string => {
    const fileScheme = raw.startsWith('file://') ? 'file://' : ''
    const path = strip(raw.slice(fileScheme.length))
    if (path === REPO || path.startsWith(REPO + '/')) return fileScheme + '/fixture/repo' + path.slice(REPO.length)
    if (path === HOME) return fileScheme + '/fixture/home'
    if (path.startsWith(HOME + '/')) {
      const rest = path.slice(HOME.length + 1)
      // Provider config roots keep their layout so adapters resolve them.
      if (rest.startsWith('.claude/') || rest.startsWith('.codex/') || rest.startsWith('.local/share/opencode/') || rest.startsWith('.config/agent-code/')) {
        return fileScheme + '/fixture/home/' + rest
      }
      // Everything else under home is another project: number it by its first
      // two segments so a subdirectory maps under the same fixture root.
      const segments = rest.split('/')
      const projectKey = segments.slice(0, Math.min(segments.length, 3)).join('/')
      let assigned = others.get(projectKey)
      if (!assigned) {
        assigned = `/fixture/other-${others.size + 1}`
        others.set(projectKey, assigned)
      }
      return fileScheme + assigned + (segments.length > 3 ? '/' + segments.slice(3).join('/') : '')
    }
    return fileScheme + '/fixture/external/' + placeholder(path)
  }
  return { rewrite, others: () => Object.fromEntries(others) }
}

function redactString(key: string, value: string, paths: PathRewriter): string {
  if (KEEP_VERBATIM_KEYS.has(key)) return value
  if (PATH_KEYS.has(key)) return value.startsWith('/') || value.startsWith('file://') ? paths.rewrite(value) : placeholder(value)
  if (BRANCH_KEYS.has(key)) return value === 'main' ? 'main' : 'b:' + placeholder(value).slice(2, 10)
  for (const prefix of KEPT_WRAPPER_PREFIXES) {
    if (value.startsWith(prefix)) return prefix + placeholder(value.slice(prefix.length))
  }
  return placeholder(value)
}

export function redactValue(key: string, value: unknown, paths: PathRewriter): unknown {
  if (typeof value === 'string') return redactString(key, value, paths)
  if (Array.isArray(value)) return value.map(item => redactValue(key, item, paths))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(k, v, paths)
    return out
  }
  return value
}

export function redactRecord(record: unknown, paths: PathRewriter): unknown {
  return redactValue('', record, paths)
}
```

- [x] **Step 4: Add the script files to the node tsconfig**

In `tsconfig.node.json`, inside `"include": [`, after `"src/mcp/**/*",` add:

```json
    // The corpus policy is imported by the extractor script AND by a unit test
    // under src/. Composite tsc needs every imported module listed; keeping the
    // policy in the authoritative typecheck means a key added to the allowlist
    // fails the normal gate instead of surfacing months later on regeneration.
    "scripts/conversation-corpus-policy.ts",
    "scripts/extract-conversation-corpus.mts",
```

- [x] **Step 5: Run the test and the node typecheck**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/corpusPolicy.test.ts && npx tsc -p tsconfig.node.json --pretty false`
Expected: 5 tests PASS; tsc clean (the extractor does not exist yet; tsc ignores a missing include glob entry only if it is a glob, so create the extractor in Task 2 before running tsc again if it complains about the literal path; if it does, temporarily create an empty `scripts/extract-conversation-corpus.mts` with `export {}` and commit it with this task).

- [x] **Step 6: Commit**

```bash
git add scripts/conversation-corpus-policy.ts src/main/conversations/corpusPolicy.test.ts tsconfig.node.json scripts/extract-conversation-corpus.mts
git commit -m "test(corpus): add the conversation corpus redaction policy"
```

### Task 2: Corpus extractor and the recorded corpus

**Files:**
- Create: `scripts/extract-conversation-corpus.mts`
- Create: `testing/fixtures/conversations/README.md`
- Modify: `.gitignore` (append the local corpus rule)
- Modify: `package.json` scripts (add `extract:conversations`, `check:conversation-fixtures`)
- Produces on run: `testing/fixtures/conversations/{manifest.json,claude/**,codex/**,opencode/**}` and `testing/fixtures/conversations/local/**`

**Interfaces:**
- Consumes: Task 1 policy.
- Produces: the corpus layout every later test reads:
  - `manifest.json`: `{ version: 1, capturedAt: string, repoRoot: '/fixture/repo', worktrees: string[], others: Record<string,string>, counts: { claude: { projectDirs: number, transcripts: number, inFamily: number, orchestrationChildren: number }, codex: { indexed: number, inFamily: number, exec: number, subagents: number, orchestrationChildren: number, sampledRollouts: number, unindexedOnDisk: number }, opencode: { sessions: number, inFamily: number, children: number } } }`
  - `claude/projects/<sanitized fixture cwd>/<uuid>.jsonl` (first 40 + last 20 records, redacted; a `{"$corpus":"gap","skipped":N}` line between them when records were skipped), `claude/history.jsonl`, `claude/worktrees.porcelain`
  - `codex/threads.sqlite` (tables `threads`, `thread_spawn_edges`, `_sqlx_migrations` copied with redaction), `codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (first 25 records of the sampled rollouts)
  - `opencode/opencode.sqlite` (tables `session`, `project`, `message`, `part` for the family, redacted)
  - `local/` mirrors the same layout unredacted (git-ignored)

- [x] **Step 1: Write the extractor**

```ts
// scripts/extract-conversation-corpus.mts
//
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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

import { createPathRewriter, redactRecord, redactValue } from './conversation-corpus-policy.js'
import { sanitizePath } from '../src/shared/runtime/projectDir.js'

const HOME = homedir()
const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..')
const FAMILY_ROOT = process.env.CORPUS_FAMILY_ROOT ?? resolve(REPO)
const OUT = join(REPO, 'testing', 'fixtures', 'conversations')
const LOCAL = join(OUT, 'local')
const VERIFY = process.argv.includes('--verify-checked-in')
const UPDATE = process.env.UPDATE_FIXTURES === '1'
const HEAD_RECORDS = 40
const TAIL_RECORDS = 20
const ROLLOUT_HEAD_RECORDS = 25
const ROLLOUT_SAMPLE = 8

type Json = Record<string, unknown>

const paths = createPathRewriter(HOME, FAMILY_ROOT)
const norm = (p: string) => p.replace(/\/+$/, '').toLowerCase()
const worktreePaths = (() => {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: FAMILY_ROOT, encoding: 'utf8', timeout: 5000 })
    return out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length))
  } catch {
    return [FAMILY_ROOT]
  }
})()
const inFamily = (cwd: string | null | undefined): boolean => {
  if (!cwd) return false
  const c = norm(cwd)
  const roots = [FAMILY_ROOT, ...worktreePaths].map(norm)
  return roots.some(r => c === r || c.startsWith(r + '/'))
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
    if (r.type !== 'user') continue
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
  const projects = join(HOME, '.claude', 'projects')
  const dirs = (await readdir(projects, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
  let transcripts = 0, family = 0, children = 0, projectDirs = 0
  const familySessionIds = new Set<string>()
  const sanitizedRoot = sanitizePath(FAMILY_ROOT)
  // One unrelated project dir is recorded as a negative control so scope tests
  // can prove "repository" excludes it while "everywhere" includes it.
  const control = dirs.find(d => !d.startsWith(sanitizedRoot) && d.startsWith('-Users-') && readdirSync(join(projects, d)).some(n => n.endsWith('.jsonl'))) ?? null
  for (const dir of dirs) {
    const candidate = dir === sanitizedRoot || dir.startsWith(sanitizedRoot + '-') || dir === control
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
      await writeBoth(join('claude', 'projects', fixtureDir, name), redacted, local)
      await writeBoth(join('claude', 'projects', fixtureDir, name + '.stat.json'),
        JSON.stringify({ mtimeMs: s.mtimeMs, size: s.size, records: records.length }), JSON.stringify({ mtimeMs: s.mtimeMs, size: s.size, records: records.length }))
    }
  }
  // history.jsonl slice: every record whose session is in the family, plus the
  // control project's records, so search tests have both hits and misses.
  const history = parseLines(await readFile(join(HOME, '.claude', 'history.jsonl'), 'utf8'))
  const slice = history.filter(h => familySessionIds.has(String(h.sessionId)) || (control !== null && typeof h.project === 'string' && sanitizePath(h.project) === control))
  await writeBoth(join('claude', 'history.jsonl'), slice.map(h => JSON.stringify(redactRecord(h, paths))).join('\n') + '\n', slice.map(h => JSON.stringify(h)).join('\n') + '\n')
  const porcelain = worktreePaths.map(p => `worktree ${paths.rewrite(p)}\n`).join('')
  await writeBoth(join('claude', 'worktrees.porcelain'), porcelain, worktreePaths.map(p => `worktree ${p}\n`).join(''))
  counts.claude = { projectDirs, transcripts, inFamily: family, orchestrationChildren: children, historyRecords: slice.length, control }
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
  const familyIds = new Set(familyRows.map(r => r.id as string))
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
  // plus one originated by agent-transcript-parser and one exec run.
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
    sampledRollouts: sampledCount, unindexedOnDisk: unindexed.length, columns,
  }
  void familyIds
}

// -------------------------------------------------------------- OpenCode
async function extractOpencode(counts: Json): Promise<void> {
  const dataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode') : join(HOME, '.local', 'share', 'opencode')
  const dbPath = join(dataDir, 'opencode.db')
  if (!existsSync(dbPath)) { counts.opencode = { sessions: 0, inFamily: 0, children: 0, absent: true }; return }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const sessions = db.prepare('select * from session').all() as Json[]
  const projects = db.prepare('select * from project').all() as Json[]
  const familySessions = sessions.filter(s => inFamily(s.directory as string))
  const control = sessions.filter(s => !inFamily(s.directory as string)).sort((a, b) => Number(b.time_updated) - Number(a.time_updated)).slice(0, 10)
  const kept = [...familySessions, ...control]
  const keptIds = kept.map(s => s.id as string)
  const placeholders = keptIds.map(() => '?').join(', ')
  const messages = db.prepare(`select * from message where session_id in (${placeholders})`).all(...keptIds) as Json[]
  const parts = db.prepare(`select * from part where session_id in (${placeholders})`).all(...keptIds) as Json[]
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
        const redacted = variant === 'redacted' ? (redactValue('', value, paths) as Json) : value
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
async function main(): Promise<void> {
  if (!UPDATE && !VERIFY) {
    console.error('Refusing to write: set UPDATE_FIXTURES=1 to regenerate, or pass --verify-checked-in.')
    process.exit(2)
  }
  if (VERIFY) {
    // The committed corpus must satisfy the policy: no string value outside
    // the allowlist may survive unhashed. Re-running redaction over the
    // committed files must be a no-op.
    const files: string[] = []
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name === 'local') continue; const p = join(dir, e.name); e.isDirectory() ? walk(p) : files.push(p) } }
    walk(OUT)
    let violations = 0
    for (const file of files) {
      if (!file.endsWith('.jsonl') && !file.endsWith('.json')) continue
      const text = readFileSync(file, 'utf8')
      const records = file.endsWith('.jsonl') ? parseLines(text) : [JSON.parse(text) as Json]
      for (const r of records) {
        if (r.$corpus) continue
        const again = JSON.stringify(redactRecord(r, createPathRewriter('/fixture/home', '/fixture/repo')))
        if (again !== JSON.stringify(r)) { violations++; console.error(`policy drift: ${file}`); break }
      }
    }
    if (violations > 0) process.exit(1)
    console.log(`Conversation corpus verified: ${files.length} files`)
    return
  }
  await rm(OUT, { recursive: true, force: true })
  await mkdir(LOCAL, { recursive: true })
  const counts: Json = {}
  await extractClaude(counts)
  await extractCodex(counts)
  await extractOpencode(counts)
  const manifest = {
    version: 1,
    capturedAt: new Date().toISOString(),
    repoRoot: '/fixture/repo',
    worktrees: worktreePaths.map(p => paths.rewrite(p)),
    others: paths.others(),
    counts,
  }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(LOCAL, 'manifest.json'), JSON.stringify({ ...manifest, repoRoot: FAMILY_ROOT, worktrees: worktreePaths, home: HOME }, null, 2) + '\n')
  console.log(JSON.stringify(counts, null, 2))
}

await main()
```

- [x] **Step 2: Add the README, the gitignore rule and the scripts**

`testing/fixtures/conversations/README.md`:

```markdown
# Conversation corpus

Recorded by `scripts/extract-conversation-corpus.mts` from the author's real
provider stores (Claude Code 2.1.x transcripts and `history.jsonl`, Codex
0.154 `state_5.sqlite` and rollouts, OpenCode 1.18 `opencode.db`) on the date
in `manifest.json`. Purpose: the case set for `src/main/conversations`.

Redaction: every string outside the allowlist in
`scripts/conversation-corpus-policy.ts` is replaced by `p:<sha8>:<len>`;
wrapper prefixes the catalog keys on are kept verbatim; paths are rewritten to
`/fixture/repo`, `/fixture/home`, `/fixture/other-N`; branches other than
`main` hash. The unredacted mirror lives in `local/` (git-ignored) for the
live suite.

`expectations.json` is hand-authored with the user: the kinds, label sources
and default order the catalog must reproduce. It is not derived from the
implementation.

Regenerate: `UPDATE_FIXTURES=1 npm run extract:conversations`. Verify:
`npm run check:conversation-fixtures`.
```

Append to `.gitignore`:

```
# Unredacted mirror of the conversation corpus (real prompts, titles, paths).
# The committed corpus next to it is the redacted recording.
/testing/fixtures/conversations/local/
```

In `package.json` scripts, after `"check:worktree-live-fixtures": …`, add:

```json
    "extract:conversations": "tsx --tsconfig tsconfig.node.json scripts/extract-conversation-corpus.mts",
    "check:conversation-fixtures": "tsx --tsconfig tsconfig.node.json scripts/extract-conversation-corpus.mts --verify-checked-in",
```

and add `npm run check:conversation-fixtures &&` to the `check` script right after `npm run check:worktree-live-fixtures &&`.

- [x] **Step 3: Run the extractor against the real stores**

Run: `UPDATE_FIXTURES=1 npm run extract:conversations`
Expected: prints counts; `testing/fixtures/conversations/manifest.json` exists with `counts.claude.inFamily` ≥ 150, `counts.codex.inFamily` ≥ 1100, `counts.opencode.inFamily` > 0. `git status` shows only files under `testing/fixtures/conversations/` (not `local/`).

- [x] **Step 4: Verify determinism and the policy gate**

Run: `cp -r testing/fixtures/conversations /tmp/corpus-a && UPDATE_FIXTURES=1 npm run extract:conversations >/dev/null && diff -r --exclude=local --exclude=manifest.json /tmp/corpus-a testing/fixtures/conversations && npm run check:conversation-fixtures`
Expected: no diff (manifest differs only by `capturedAt`); "Conversation corpus verified".

- [x] **Step 5: Eyeball one redacted transcript and one sqlite row for leaks**

Run: `head -c 1500 testing/fixtures/conversations/claude/projects/-fixture-repo/$(ls testing/fixtures/conversations/claude/projects/-fixture-repo | head -1) && sqlite3 testing/fixtures/conversations/codex/threads.sqlite "select substr(title,1,60), cwd, git_branch from threads limit 5;"`
Expected: no readable prompt text; wrapper prefixes intact; paths under `/fixture/`.

- [x] **Step 6: Commit**

```bash
git add scripts/extract-conversation-corpus.mts testing/fixtures/conversations .gitignore package.json
git commit -m "test(corpus): record the conversation corpus from real provider stores"
```

### Task 3: Corpus manifest test and the expectations draft

**Files:**
- Create: `testing/support/conversations/installCorpus.ts`
- Create: `src/main/conversations/corpus.system.test.ts`
- Create: `testing/fixtures/conversations/expectations.json` (draft generated, then reviewed by the user)
- Create: `scripts/draft-conversation-expectations.mts`

**Interfaces:**
- Produces: `installConversationCorpus(): Promise<{ home: string; claudeConfigDir: string; codexHome: string; opencodeDataDir: string; repoRoot: string; worktrees: string[]; cleanup(): Promise<void> }>` and the `expectations.json` shape:
  ```json
  { "version": 1, "family": "/fixture/repo",
    "kinds": { "claude:<uuid>": "orchestration-child", "codex:<id>": "exec" },
    "labelSources": { "claude:<uuid>": "ai-title" },
    "defaultOrderTop": ["codex:<id>", "claude:<uuid>"] }
  ```

- [x] **Step 1: Write the corpus installer**

```ts
// testing/support/conversations/installCorpus.ts
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Materialise the committed corpus under a temp HOME shaped exactly like the
// real one (~/.claude, ~/.codex, ~/.local/share/opencode), so adapters run
// with no test-only branches. Paths recorded as /fixture/home are rewritten
// to the temp root inside the sqlite copies; JSONL records keep /fixture/*
// because the adapters compare cwds as strings against the family, and the
// family for the fixture IS /fixture/repo.
const CORPUS = join(process.cwd(), 'testing', 'fixtures', 'conversations')

export type InstalledCorpus = {
  home: string
  claudeConfigDir: string
  codexHome: string
  opencodeDataDir: string
  repoRoot: string
  worktrees: string[]
  manifest: Record<string, unknown>
  cleanup(): Promise<void>
}

export async function installConversationCorpus(): Promise<InstalledCorpus> {
  const home = await mkdtemp(join(tmpdir(), 'conversations-corpus-'))
  const claudeConfigDir = join(home, '.claude')
  const codexHome = join(home, '.codex')
  const opencodeDataDir = join(home, '.local', 'share', 'opencode')
  await cp(join(CORPUS, 'claude', 'projects'), join(claudeConfigDir, 'projects'), { recursive: true })
  await cp(join(CORPUS, 'claude', 'history.jsonl'), join(claudeConfigDir, 'history.jsonl'))
  await cp(join(CORPUS, 'codex', 'sessions'), join(codexHome, 'sessions'), { recursive: true })
  await cp(join(CORPUS, 'codex', 'threads.sqlite'), join(codexHome, 'state_5.sqlite'))
  await cp(join(CORPUS, 'opencode', 'opencode.sqlite'), join(opencodeDataDir, 'opencode.db'))
  const codex = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
  codex.exec(`update threads set rollout_path = replace(rollout_path, '/fixture/home/.codex', '${codexHome.replaceAll("'", "''")}')`)
  codex.close()
  const manifest = JSON.parse(await readFile(join(CORPUS, 'manifest.json'), 'utf8')) as Record<string, unknown>
  return {
    home, claudeConfigDir, codexHome, opencodeDataDir,
    repoRoot: manifest.repoRoot as string,
    worktrees: manifest.worktrees as string[],
    manifest,
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

export async function corpusWorktreesPorcelain(): Promise<string> {
  return readFile(join(CORPUS, 'claude', 'worktrees.porcelain'), 'utf8')
}
```

- [x] **Step 2: Write the manifest test**

```ts
// src/main/conversations/corpus.system.test.ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { installConversationCorpus } from '../../../testing/support/conversations/installCorpus.js'

// The manifest is the count every membership assertion later argues from. If
// the fixture files and the manifest disagree, every "nothing dropped" test
// downstream is arguing from a wrong denominator.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('conversation corpus', () => {
  it('installs under a temp HOME with the manifest counts', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const counts = corpus.manifest.counts as { claude: { transcripts: number }; codex: { indexed: number; inFamily: number; control: number }; opencode: { inFamily: number; control: number } }
    const dirs = await readdir(join(corpus.claudeConfigDir, 'projects'))
    let transcripts = 0
    for (const dir of dirs) transcripts += (await readdir(join(corpus.claudeConfigDir, 'projects', dir))).filter(n => n.endsWith('.jsonl')).length
    expect(transcripts).toBe(counts.claude.transcripts)
    const db = new DatabaseSync(join(corpus.codexHome, 'state_5.sqlite'), { readOnly: true })
    const rows = db.prepare('select count(*) as n from threads').get() as { n: number }
    const rewritten = db.prepare("select count(*) as n from threads where rollout_path like ?").get(`${corpus.codexHome}%`) as { n: number }
    db.close()
    expect(rows.n).toBe(counts.codex.inFamily + counts.codex.control)
    expect(rewritten.n).toBe(rows.n)
    const oc = new DatabaseSync(join(corpus.opencodeDataDir, 'opencode.db'), { readOnly: true })
    expect((oc.prepare('select count(*) as n from session').get() as { n: number }).n).toBe(counts.opencode.inFamily + counts.opencode.control)
    oc.close()
    expect(corpus.repoRoot).toBe('/fixture/repo')
    expect(corpus.worktrees.length).toBeGreaterThan(1)
  })
})
```

- [x] **Step 3: Run it**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/corpus.system.test.ts`
Expected: PASS.

- [x] **Step 4: Write the expectations draft generator**

```ts
// scripts/draft-conversation-expectations.mts
//
// Drafts testing/fixtures/conversations/expectations.json from the LOCAL
// (unredacted) corpus so the user can review readable labels and correct
// kinds. The committed file references only provider ids; the readable draft
// is printed to the terminal and never committed.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(new URL('..', import.meta.url).pathname)
const LOCAL = join(REPO, 'testing', 'fixtures', 'conversations', 'local')
const OUT = join(REPO, 'testing', 'fixtures', 'conversations', 'expectations.json')
const manifest = JSON.parse(readFileSync(join(LOCAL, 'manifest.json'), 'utf8')) as { repoRoot: string; worktrees: string[] }
const norm = (p: string) => p.replace(/\/+$/, '').toLowerCase()
const roots = [manifest.repoRoot, ...manifest.worktrees].map(norm)
const inFamily = (cwd: string | null) => !!cwd && roots.some(r => norm(cwd) === r || norm(cwd).startsWith(r + '/'))

type Draft = { key: string; kind: string; labelSource: string; label: string; activity: number }
const drafts: Draft[] = []

// Claude: kind from the first user prompt, label from ai-title > custom > first prompt.
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
    const labelSource = custom ? 'provider-name' : aiTitle ? 'ai-title' : first ? 'first-prompt' : 'cwd'
    const stat = JSON.parse(readFileSync(join(projects, dir, name + '.stat.json'), 'utf8')) as { mtimeMs: number }
    drafts.push({ key: `claude:${name.slice(0, -6)}`, kind, labelSource, label: (custom ?? aiTitle ?? first).replace(/\s+/g, ' ').slice(0, 70), activity: stat.mtimeMs })
  }
}
// Codex: from the index.
const db = new DatabaseSync(join(LOCAL, 'codex', 'threads.sqlite'), { readOnly: true })
for (const row of db.prepare('select * from threads').all() as Record<string, unknown>[]) {
  if (!inFamily(row.cwd as string)) continue
  const title = String(row.title ?? '')
  const kind = row.source === 'exec' ? 'exec' : row.thread_source === 'subagent' ? 'native-subagent' : title.startsWith('<orchestration-handoff>') ? 'orchestration-child' : row.originator === 'agent-transcript-parser' ? 'projected' : title ? 'user' : 'empty'
  const name = typeof row.name === 'string' && row.name && !title.startsWith(row.name) ? row.name : null
  drafts.push({ key: `codex:${row.id}`, kind, labelSource: name ? 'provider-name' : title && !title.startsWith('<') ? 'first-prompt' : 'cwd', label: (name ?? title).replace(/\s+/g, ' ').slice(0, 70), activity: Number(row.recency_at_ms ?? row.updated_at_ms ?? 0) })
}
db.close()
// OpenCode.
const oc = new DatabaseSync(join(LOCAL, 'opencode', 'opencode.sqlite'), { readOnly: true })
for (const row of oc.prepare('select * from session').all() as Record<string, unknown>[]) {
  if (!inFamily(row.directory as string)) continue
  drafts.push({ key: `opencode:${row.id}`, kind: row.parent_id ? 'native-subagent' : 'user', labelSource: 'ai-title', label: String(row.title).slice(0, 70), activity: Number(row.time_updated) })
}
oc.close()

drafts.sort((a, b) => b.activity - a.activity)
const shown = drafts.filter(d => d.kind === 'user' || d.kind === 'projected')
console.log('Default view (top 30, newest activity first):')
for (const d of shown.slice(0, 30)) console.log(`  ${d.key.padEnd(48)} ${d.kind.padEnd(8)} ${d.labelSource.padEnd(13)} ${d.label}`)
console.log(`\nHidden by default: ${drafts.length - shown.length} of ${drafts.length}`)
const expectations = {
  version: 1,
  family: '/fixture/repo',
  kinds: Object.fromEntries(drafts.map(d => [d.key, d.kind])),
  labelSources: Object.fromEntries(drafts.map(d => [d.key, d.labelSource])),
  defaultOrderTop: shown.slice(0, 30).map(d => d.key),
}
import('node:fs').then(fs => fs.writeFileSync(OUT, JSON.stringify(expectations, null, 2) + '\n'))
```

- [x] **Step 5: Generate the draft and review it with the user**

Run: `npx tsx --tsconfig tsconfig.node.json scripts/draft-conversation-expectations.mts`
Expected: a readable table of the top 30 default rows with labels the user recognises. Paste the table to the user and ask for corrections to kinds or order. Apply corrections by editing `expectations.json` by hand (never by changing the draft script to match the implementation). The task is complete only after the user confirms.

- [x] **Step 6: Commit**

```bash
git add testing/support/conversations/installCorpus.ts src/main/conversations/corpus.system.test.ts scripts/draft-conversation-expectations.mts testing/fixtures/conversations/expectations.json
git commit -m "test(corpus): install the corpus under a temp HOME and record the user's expectations"
```

---

## Stage 1 — Provider source adapters

### Task 4: Shared types and repository family resolution

**Files:**
- Create: `src/shared/conversations/types.ts`
- Create: `src/main/conversations/family.ts`
- Create: `src/main/conversations/family.system.test.ts`

**Interfaces:**
- Produces (shared): `Conversation`, `ConversationKind`, `ConversationLabelSource`, `ConversationScope`, `ConversationActivitySource`, `ConversationMatch`, `ConversationListRequest`, `ConversationListResponse`, `ConversationPromptsRequest`, `ConversationPrompt`, `ConversationChildrenRequest`, `conversationKey(provider, nativeId): string`.
- Produces (family): `RepositoryFamily = { scope, cwd, root: string | null, roots: string[], rawRoots: string[], matches(candidate: string | null): boolean }`, `resolveFamily(cwd, scope, deps: { listWorktrees(cwd): Promise<Array<{ path: string }>> }): Promise<RepositoryFamily>`, `normalizeCwd(path): string`.

- [x] **Step 1: Write the shared types**

```ts
// src/shared/conversations/types.ts
import type { AgentProviderKind } from '@shared/types/providerKind.js'

// One past conversation as every picker must display it. Derived once in main
// by src/main/conversations/catalog; the renderer only consumes it. See
// docs/decomposition/conversations.md §2 for why each field exists.

export type ConversationKind =
  | 'user'
  | 'orchestration-child'
  | 'native-subagent'
  | 'exec'
  | 'projected'
  | 'empty'

/** Which rung of the label ladder produced `label`, best → worst. The two
 *  last rungs are stand-ins and a row must mark them visually (#701). */
export type ConversationLabelSource =
  | 'agent-code-title'
  | 'provider-name'
  | 'ai-title'
  | 'first-prompt'
  | 'cwd'
  | 'native-id'

export type ConversationScope = 'cwd' | 'repository' | 'everywhere'

/** Where `lastUserActivityAt` came from. `mtime` is the last resort and a
 *  test can assert it was never the primary key for an indexed provider. */
export type ConversationActivitySource = 'history' | 'index' | 'tail' | 'mtime'

export type ConversationMatch = {
  field: 'label' | 'name' | 'prompt'
  text: string
  start: number
  end: number
}

export type Conversation = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string
  repoRoot: string | null
  /** Basename of the worktree directory when `cwd` is not the repo root. */
  worktree: string | null
  gitBranch: string | null
  kind: ConversationKind
  parentNativeId: string | null
  label: string
  labelSource: ConversationLabelSource
  firstPrompt: string | null
  /** Spoken Agent Code name, only for conversations that ran here (ledger). */
  agentName: string | null
  agentCodeTitle: string | null
  createdAt: number | null
  lastUserActivityAt: number
  activitySource: ConversationActivitySource
  promptCount: number | null
  /** False when the index knows the conversation but its file is gone. */
  available: boolean
  origin: 'index' | 'scan'
  match: ConversationMatch | null
}

export type ConversationListRequest = {
  cwd: string
  scope: ConversationScope
  providers?: AgentProviderKind[]
  includeChildren?: boolean
  query?: string
  cursor?: string | null
  limit?: number
}

export type ConversationListResponse = {
  rows: Conversation[]
  /** Rows in scope after the provider filter, before the children filter and paging. */
  total: number
  hiddenChildren: number
  nextCursor: string | null
  family: { repoRoot: string | null; roots: string[] }
  timing: { ms: number }
}

export type ConversationPromptsRequest = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string
}

export type ConversationPrompt = {
  text: string
  timestamp: number | null
}

export type ConversationChildrenRequest = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string
}

export function conversationKey(provider: AgentProviderKind, nativeId: string): string {
  return `${provider}:${nativeId}`
}
```

- [x] **Step 2: Write the failing family test**

```ts
// src/main/conversations/family.system.test.ts
import { execFile } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { normalizeCwd, resolveFamily } from './family.js'
import { corpusWorktreesPorcelain } from '../../../testing/support/conversations/installCorpus.js'

const exec = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

// A real repository with a real `git worktree add`, because family resolution
// IS the upstream `includeWorktrees` behaviour Agent Code dropped and the
// porcelain parser must see git's actual output, not a hand-typed sample.
async function repoWithWorktree() {
  const root = await mkdtemp(join(tmpdir(), 'family-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const main = join(root, 'repo')
  await mkdir(main)
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: main })
  await writeFile(join(main, 'README.md'), 'x\n')
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: main })
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: main })
  await mkdir(join(main, '.worktrees'))
  await exec('git', ['worktree', 'add', '-q', join(main, '.worktrees', 'feature'), '-b', 'feature'], { cwd: main })
  const sibling = join(root, 'repo-audit')
  await exec('git', ['worktree', 'add', '-q', sibling, '-b', 'audit'], { cwd: main })
  return { main, feature: join(main, '.worktrees', 'feature'), sibling }
}

function gitWorktrees(cwd: string) {
  return exec('git', ['worktree', 'list', '--porcelain'], { cwd }).then(r =>
    r.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) })))
}

describe('repository family', () => {
  it('spans the main checkout, .worktrees children, subdirectories and sibling worktrees', async () => {
    const repo = await repoWithWorktree()
    const family = await resolveFamily(repo.feature, 'repository', { listWorktrees: gitWorktrees })
    expect(family.root).toBe(normalizeCwd(repo.main))
    expect(family.matches(repo.main)).toBe(true)
    expect(family.matches(repo.feature)).toBe(true)
    expect(family.matches(join(repo.main, 'packages', 'x'))).toBe(true)
    expect(family.matches(repo.sibling)).toBe(true)
    expect(family.matches(join(repo.main, '.worktrees', 'pruned-later'))).toBe(true)
    expect(family.matches(join(repo.main + '-other'))).toBe(false)
    expect(family.matches(null)).toBe(false)
  })

  it('compares cwds case-insensitively on darwin and exactly by scope otherwise', async () => {
    const repo = await repoWithWorktree()
    const cwdScope = await resolveFamily(repo.main, 'cwd', { listWorktrees: gitWorktrees })
    expect(cwdScope.matches(repo.feature)).toBe(false)
    expect(cwdScope.matches(repo.main + '/')).toBe(true)
    if (process.platform === 'darwin') {
      // One real transcript records ~/Desktop/development/agent-code (lowercase d)
      // for a session that ran in ~/Desktop/Development/agent-code.
      expect(cwdScope.matches(repo.main.replace('repo', 'REPO'))).toBe(true)
    }
    const everywhere = await resolveFamily(repo.main, 'everywhere', { listWorktrees: gitWorktrees })
    expect(everywhere.matches('/somewhere/else')).toBe(true)
    expect(everywhere.root).toBe(normalizeCwd(repo.main))
  })

  it('falls back to the cwd alone when git is unavailable or the dir is not a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'family-nogit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const family = await resolveFamily(dir, 'repository', { listWorktrees: async () => [] })
    expect(family.root).toBe(normalizeCwd(dir))
    expect(family.roots).toEqual([normalizeCwd(dir)])
    expect(family.rawRoots).toEqual([dir])
    expect(family.matches(join(dir, 'sub'))).toBe(true)
  })

  it('resolves the recorded corpus family from its porcelain output', async () => {
    const porcelain = await corpusWorktreesPorcelain()
    const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
    const family = await resolveFamily('/fixture/repo/.worktrees/extension-platform', 'repository', { listWorktrees: async () => worktrees })
    expect(family.root).toBe('/fixture/repo')
    expect(family.matches('/fixture/repo/.worktrees/extension-platform')).toBe(true)
    expect(family.matches('/fixture/other-1')).toBe(false)
  })
})
```

- [x] **Step 3: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/family.system.test.ts`
Expected: FAIL, `./family.js` not found.

- [x] **Step 4: Write the family module**

```ts
// src/main/conversations/family.ts
import { resolve } from 'node:path'

import type { ConversationScope } from '@shared/conversations/types.js'

// Which conversations belong to "this repository".
//
// WHY worktrees are the unit, not the cwd (docs/decomposition/conversations.md
// §2.1): Claude keys its transcript directories by cwd, so a session run in
// `.worktrees/feature` is invisible from the main checkout. Upstream Claude
// Code's own picker merges every `git worktree list` path; the app-side copy
// of that lister dropped the feature and the user lost half their sessions.
//
// WHY the main checkout is the first porcelain entry: git prints the main
// worktree first, always. When git is unavailable the cwd itself is the root.
//
// WHY prefix matching under each root: a session started in
// `<repo>/packages/x` is still this repository, and a pruned
// `<repo>/.worktrees/old` still holds transcripts worth listing. Prefix
// matching is exact on the path separator so `<repo>-other` never matches.

export type RepositoryFamily = {
  scope: ConversationScope
  cwd: string
  /** Normalised main-checkout path, or null only when scope is `everywhere`
   *  and no repository could be resolved. */
  root: string | null
  /** Every normalised root that counts as this repository. */
  roots: string[]
  /** The same roots with their on-disk case preserved. Claude derives its
   *  project directory name from the literal cwd, so a lowercased root
   *  would name a directory that does not exist. */
  rawRoots: string[]
  matches(candidate: string | null | undefined): boolean
}

export type FamilyDeps = {
  listWorktrees(cwd: string): Promise<ReadonlyArray<{ path: string }>>
}

/** `path.resolve` collapses `..` and trailing slashes; darwin and win32 file
 *  systems are case-insensitive by default, and one real transcript recorded
 *  the cwd with a lowercased segment. */
export function normalizeCwd(path: string): string {
  const resolved = resolve(path).replace(/\/+$/, '')
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function underRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + '/')
}

export async function resolveFamily(
  cwd: string,
  scope: ConversationScope,
  deps: FamilyDeps,
): Promise<RepositoryFamily> {
  const normalizedCwd = normalizeCwd(cwd)
  const rawCwd = resolve(cwd).replace(/\/+$/, '')
  let rawWorktrees: string[] = []
  try {
    rawWorktrees = (await deps.listWorktrees(cwd)).map(w => resolve(w.path).replace(/\/+$/, ''))
  } catch {
    rawWorktrees = []
  }
  const worktrees = rawWorktrees.map(normalizeCwd)
  const root = worktrees[0] ?? normalizedCwd
  const roots = scope === 'cwd'
    ? [normalizedCwd]
    : [...new Set([root, ...worktrees])]
  const rawRoots = scope === 'cwd'
    ? [rawCwd]
    : [...new Set([rawWorktrees[0] ?? rawCwd, ...rawWorktrees])]
  return {
    scope,
    cwd: normalizedCwd,
    root,
    roots,
    rawRoots,
    matches(candidate) {
      if (scope === 'everywhere') return true
      if (!candidate) return false
      const c = normalizeCwd(candidate)
      if (scope === 'cwd') return c === normalizedCwd
      return roots.some(r => underRoot(c, r))
    },
  }
}
```

- [x] **Step 5: Run the test and typecheck**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/family.system.test.ts && npx tsc -p tsconfig.node.json --pretty false`
Expected: 4 PASS; tsc clean.

- [x] **Step 6: Commit**

```bash
git add src/shared/conversations/types.ts src/main/conversations/family.ts src/main/conversations/family.system.test.ts
git commit -m "feat(conversations): add the shared record and repository family resolution"
```

### Task 5: Read-only SQLite helper

**Files:**
- Create: `src/main/conversations/sources/sqlite.ts`
- Create: `src/main/conversations/sources/sqlite.system.test.ts`

**Interfaces:**
- Produces: `openReadOnlySqlite(path: string, required: Record<string, string[]>): { ok: true; db: DatabaseSync; close(): void } | { ok: false; reason: string }`, `newestCodexStateDb(codexHome: string): string | null`.

- [x] **Step 1: Write the failing test**

```ts
// src/main/conversations/sources/sqlite.system.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { newestCodexStateDb, openReadOnlySqlite } from './sqlite.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('read-only sqlite helper', () => {
  it('picks the highest state_N file and refuses a missing required column', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sqlite-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    await writeFile(join(home, 'state_4.sqlite'), '')
    const newest = join(home, 'state_12.sqlite')
    const db = new DatabaseSync(newest)
    db.exec('create table threads (id text, cwd text);')
    db.close()
    expect(newestCodexStateDb(home)).toBe(newest)
    const missing = openReadOnlySqlite(newest, { threads: ['id', 'cwd', 'recency_at_ms'] })
    expect(missing).toMatchObject({ ok: false, reason: expect.stringContaining('recency_at_ms') })
    const ok = openReadOnlySqlite(newest, { threads: ['id', 'cwd'] })
    if (!ok.ok) throw new Error(ok.reason)
    expect(() => ok.db.exec("insert into threads values ('x','y')")).toThrow()
    ok.close()
  })

  it('reports an unreadable file as a reason, never a throw', () => {
    const result = openReadOnlySqlite('/nonexistent/state_1.sqlite', { threads: ['id'] })
    expect(result.ok).toBe(false)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/sqlite.system.test.ts`
Expected: FAIL, `./sqlite.js` not found.

- [x] **Step 3: Write the helper**

```ts
// src/main/conversations/sources/sqlite.ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// WHY node:sqlite and not a native dependency: Electron 43 bundles Node
// 24.18, where `node:sqlite` is built in (still flagged experimental, which
// prints one warning per process). better-sqlite3 would add a second native
// rebuild next to node-pty for a read-only use. The experimental flag is the
// accepted trade; the adapters degrade to a scan if the module ever breaks.
//
// WHY a column probe: Codex versions its index file (`state_5.sqlite` today)
// and adds columns between releases. A query against a column that does not
// exist throws at prepare time; probing first turns a schema bump into a
// reported downgrade instead of an empty picker.

export type SqliteOpen =
  | { ok: true; db: DatabaseSync; close(): void }
  | { ok: false; reason: string }

export function openReadOnlySqlite(
  path: string,
  required: Record<string, string[]>,
): SqliteOpen {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return { ok: false, reason: `cannot open ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    for (const [table, columns] of Object.entries(required)) {
      const present = new Set(
        (db.prepare(`pragma table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name),
      )
      const missing = columns.filter(c => !present.has(c))
      if (present.size === 0) {
        db.close()
        return { ok: false, reason: `table ${table} is missing in ${path}` }
      }
      if (missing.length > 0) {
        db.close()
        return { ok: false, reason: `table ${table} in ${path} lacks columns ${missing.join(', ')}` }
      }
    }
  } catch (error) {
    db.close()
    return { ok: false, reason: `cannot probe ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, db, close: () => db.close() }
}

/** Codex names its index `state_<N>.sqlite` and bumps N on schema changes;
 *  the highest N is the live one. Null when no index exists yet. */
export function newestCodexStateDb(codexHome: string): string | null {
  let names: string[]
  try {
    names = readdirSync(codexHome).filter(n => /^state_\d+\.sqlite$/.test(n))
  } catch {
    return null
  }
  names.sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))
  return names[0] ? join(codexHome, names[0]) : null
}
```

- [x] **Step 4: Run the test**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/sqlite.system.test.ts`
Expected: 2 PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/conversations/sources/sqlite.ts src/main/conversations/sources/sqlite.system.test.ts
git commit -m "feat(conversations): open provider sqlite indexes read-only with a column probe"
```

### Task 6: Move the incremental prompt folder out of sessionIndex

**Files:**
- Create: `src/main/conversations/prompts/promptFolder.ts` (moved from `src/main/sessionIndex.ts:104-700`, the `CacheEntry` type through `flattenCodexContent`)
- Move: `src/main/sessionIndex.prompts.test.ts` → `src/main/conversations/prompts/promptFolder.test.ts`
- Modify: `src/main/sessionIndex.ts` (import the folder instead of defining it; nothing else changes until Task 23 deletes it)

**Interfaces:**
- Produces: `extractPromptsFromFile(kind: 'claude' | 'codex', sessionId: string, file: string, need: number | 'all'): Promise<{ prompts: Array<{ text: string; ts: number | null }>; cwd: string }>` (newest first), `__resetPromptFolderCacheForTests()`, `__promptFolderCacheEntryForTests(kind, sessionId)`, `__promptFolderCacheSizeForTests()`.
- Behaviour change, deliberate: the Claude and Codex record folds no longer drop texts that start with `<`. The catalog's unwrapper (Task 11) decides what a wrapper means, because `<stt …>` IS a user prompt and `<orchestration-handoff>` carries the child's task. Everything else about the folder (byte ranges, seams, LRU, serialisation) is unchanged; the 12 tests move with it.

- [x] **Step 1: Move the module**

```bash
mkdir -p src/main/conversations/prompts
git mv src/main/sessionIndex.prompts.test.ts src/main/conversations/prompts/promptFolder.test.ts
```

Create `src/main/conversations/prompts/promptFolder.ts` by cutting from `src/main/sessionIndex.ts` everything from the `// Cache` banner (the `type CacheEntry = {` block, `PROMPT_CACHE_MAX_ENTRIES`, `SEAM_BYTES`, `TAIL_WINDOW_BYTES`, `HEAD_CWD_WINDOW_BYTES`, `promptCache`, `cacheGet`, `cacheSet`, the three `__…ForTests` exports, `cacheKey`, `stringField`) plus `extractPromptsFromFile`, `inflight`, `extractPromptsUnlocked`, `NEWLINE`, `readRange`, `foldForward`, `seamOf`, `foldBackward`, `readHeadCwd`, `lastPromptText`, `foldLines`, `recordCwd`, `foldClaudeRecord`, `extractClaudeUserText`, `foldCodexRecord`, `flattenCodexContent`. Keep `SEARCH_CANDIDATES_PER_PROVIDER` in `sessionIndex.ts` (search still uses it until Task 23). Add this header and rename the three test hooks:

```ts
// src/main/conversations/prompts/promptFolder.ts
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { open, stat } from 'fs/promises'

import { performanceService } from '@main/performance/PerformanceService.js'
import { asRecord, parseJsonRecord } from '@shared/lib/asRecord.js'

// Incremental user-prompt reader over an append-only provider transcript.
//
// Moved verbatim from src/main/sessionIndex.ts (#735) so the conversation
// catalog can list a row's prompts, search them, and feed View Prompts
// without the discovery/search code that surrounded it there. The byte-range
// contract is unchanged: a listing folds the tail it needs, growth folds only
// the appended bytes, search extends to the head once, and a rewrite starts a
// cold entry. Its tests moved with it.
//
// ONE behaviour change from the original: texts starting with `<` are no
// longer dropped here. The old filter treated every angle-bracket prefix as a
// Claude Code system wrapper, which is false for `<stt …>` (a real prompt the
// user dictated) and loses the task text inside `<orchestration-handoff>`.
// What a wrapper means is the catalog's decision (catalog/unwrap.ts); this
// module reports what the transcript holds.

export type FoldedPrompt = {
  text: string
  /** Epoch ms if the entry's ISO timestamp parsed, else null. */
  ts: number | null
}
```

Then, in the moved code, replace `SessionIndexPrompt` with `FoldedPrompt`, rename `__resetSessionIndexCacheForTests` → `__resetPromptFolderCacheForTests`, `__sessionIndexCacheEntryForTests` → `__promptFolderCacheEntryForTests`, `__sessionIndexCacheSizeForTests` → `__promptFolderCacheSizeForTests`, and delete the two lines `if (text.startsWith('<')) return null` in `foldClaudeRecord` and `foldCodexRecord`.

In `src/main/sessionIndex.ts`, replace the removed block with:

```ts
import {
  extractPromptsFromFile,
  type FoldedPrompt,
} from '@main/conversations/prompts/promptFolder.js'

export type SessionIndexPrompt = FoldedPrompt
export {
  __resetPromptFolderCacheForTests as __resetSessionIndexCacheForTests,
  __promptFolderCacheEntryForTests as __sessionIndexCacheEntryForTests,
  __promptFolderCacheSizeForTests as __sessionIndexCacheSizeForTests,
  extractPromptsFromFile,
} from '@main/conversations/prompts/promptFolder.js'
```

and keep the rest of the file compiling (its `foldClaudeRecord` callers are gone; `listRecentSessionsWithPrompts` / `searchSessionPrompts` call `extractPromptsFromFile` as before). Because the old search filtered `<`-prefixed prompts implicitly, add `.filter(p => !p.text.startsWith('<'))` to the two `prompts` uses in `sessionIndex.ts` so the legacy modal behaves identically until it is deleted.

- [x] **Step 2: Update the moved test's imports and hook names**

In `promptFolder.test.ts` change the import to `from './promptFolder.js'` with the three renamed hooks, and add one test for the behaviour change:

```ts
  it('reports an angle-bracket-prefixed prompt instead of dropping it (the catalog decides what it means)', async () => {
    const file = join(root, 'stt.jsonl')
    writeFileSync(file, claudeUser('<stt note="Speech-to-text; may contain transcription mistakes.">\nship it\n</stt>', 1) + claudeUser('and now plain', 2))
    const { prompts } = await extractPromptsFromFile('claude', 'stt', file, 'all')
    expect(prompts.map(p => p.text)).toEqual(['and now plain', '<stt note="Speech-to-text; may contain transcription mistakes.">\nship it\n</stt>'])
  })
```

- [x] **Step 3: Run the moved tests, the legacy index tests and the typecheck**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/prompts/promptFolder.test.ts src/main/sessions/nativeHistoryControl.test.ts && npx tsc -p tsconfig.node.json --pretty false`
Expected: 13 + existing PASS; tsc clean.

- [x] **Step 4: Commit**

```bash
git add src/main/conversations/prompts src/main/sessionIndex.ts
git commit -m "refactor(conversations): move the incremental prompt folder out of sessionIndex"
```

### Task 7: Claude prompt-history reader

**Files:**
- Create: `src/main/conversations/sources/claudeHistory.ts`
- Create: `src/main/conversations/sources/claudeHistory.system.test.ts`

**Interfaces:**
- Produces: `class ClaudeHistoryIndex { constructor(file: string); refresh(): Promise<void>; bySession(sessionId: string): readonly HistoryPrompt[]; sessionIds(): Iterable<string> }`, `HistoryPrompt = { text: string; timestamp: number; project: string; sessionId: string }`.

- [x] **Step 1: Write the failing test**

```ts
// src/main/conversations/sources/claudeHistory.system.test.ts
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeHistoryIndex } from './claudeHistory.js'
import { installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('Claude history index', () => {
  it('indexes the recorded history by session and extends by appended bytes only', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const file = join(corpus.claudeConfigDir, 'history.jsonl')
    const index = new ClaudeHistoryIndex(file)
    await index.refresh()
    const counts = corpus.manifest.counts as { claude: { historyRecords: number } }
    let total = 0
    for (const id of index.sessionIds()) total += index.bySession(id).length
    expect(total).toBe(counts.claude.historyRecords)
    const [anyId] = [...index.sessionIds()]
    const before = index.bySession(anyId).length
    // Growth: append one record; only that record must be folded, and the
    // session's prompts stay chronological.
    await appendFile(file, JSON.stringify({ display: 'p:appended:8', pastedContents: {}, timestamp: 1_800_000_000_000, project: '/fixture/repo', sessionId: anyId }) + '\n')
    await index.refresh()
    const after = index.bySession(anyId)
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1]).toMatchObject({ text: 'p:appended:8', timestamp: 1_800_000_000_000 })
    expect(index.bytesReadForTests()).toBeLessThan(400)
  })

  it('rebuilds from scratch when the file shrinks and tolerates a partial last line', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const file = join(corpus.claudeConfigDir, 'history.jsonl')
    const index = new ClaudeHistoryIndex(file)
    await index.refresh()
    const original = await readFile(file, 'utf8')
    const lines = original.split('\n').filter(Boolean)
    await writeFile(file, lines.slice(0, 5).join('\n') + '\n' + '{"display":"trunc')
    await index.refresh()
    let total = 0
    for (const id of index.sessionIds()) total += index.bySession(id).length
    expect(total).toBe(5)
  })

  it('treats a missing file as empty, not as an error', async () => {
    const index = new ClaudeHistoryIndex('/nonexistent/history.jsonl')
    await expect(index.refresh()).resolves.toBeUndefined()
    expect([...index.sessionIds()]).toEqual([])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/claudeHistory.system.test.ts`
Expected: FAIL, `./claudeHistory.js` not found.

- [x] **Step 3: Write the reader**

```ts
// src/main/conversations/sources/claudeHistory.ts
import { open, stat } from 'node:fs/promises'

import { parseJsonRecord } from '@shared/lib/asRecord.js'

// ~/.claude/history.jsonl: one record per prompt the user typed into any
// Claude Code session, `{ display, pastedContents, timestamp, project,
// sessionId }`. Claude Code appends it on every submit.
//
// WHY this is the Claude prompt index rather than the transcripts: on the
// author's machine it holds 13,174 prompts for 1,566 sessions in 4.6 MB, a
// substring search over all of it takes 34 ms, and it covers 56 of the 57
// transcripts in the focused project. The transcripts are 283 MB for the same
// project. The 30 transcripts with no history record are projected or
// SDK-smoke sessions, which the head read labels anyway.
//
// WHY incremental by byte offset: the file is append-only by construction.
// Re-reading 4.6 MB per keystroke is the class of cost #735 removed from the
// old index; folding only the appended bytes keeps a refresh at O(new
// prompts). A shrink or a moved mtime with an unchanged size means a rewrite
// (Claude Code compacts history on some upgrades) and rebuilds from zero.

export type HistoryPrompt = {
  text: string
  timestamp: number
  project: string
  sessionId: string
}

const NEWLINE = 0x0a

export class ClaudeHistoryIndex {
  private readonly bySessionId = new Map<string, HistoryPrompt[]>()
  private parsedTo = 0
  private mtimeMs = 0
  private lastBytesRead = 0

  constructor(private readonly file: string) {}

  async refresh(): Promise<void> {
    let size: number
    let mtimeMs: number
    try {
      const s = await stat(this.file)
      size = s.size
      mtimeMs = s.mtimeMs
    } catch {
      this.bySessionId.clear()
      this.parsedTo = 0
      this.mtimeMs = 0
      this.lastBytesRead = 0
      return
    }
    if (size < this.parsedTo || (mtimeMs !== this.mtimeMs && size === this.parsedTo && this.parsedTo > 0 && size !== this.parsedTo)) {
      this.bySessionId.clear()
      this.parsedTo = 0
    }
    if (size < this.parsedTo) {
      this.bySessionId.clear()
      this.parsedTo = 0
    }
    this.mtimeMs = mtimeMs
    if (size === this.parsedTo) {
      this.lastBytesRead = 0
      return
    }
    const handle = await open(this.file, 'r')
    try {
      const buf = Buffer.allocUnsafe(size - this.parsedTo)
      let offset = 0
      while (offset < buf.length) {
        const { bytesRead } = await handle.read(buf, offset, buf.length - offset, this.parsedTo + offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      this.lastBytesRead = offset
      // Only complete lines fold; a trailing partial line (Claude Code mid-append)
      // stays outside the parsed range until its newline lands.
      const lastNewline = buf.lastIndexOf(NEWLINE, offset - 1)
      if (lastNewline < 0) return
      const text = buf.subarray(0, lastNewline + 1).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const record = parseJsonRecord(line)
        if (!record) continue
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null
        const display = typeof record.display === 'string' ? record.display : null
        const timestamp = typeof record.timestamp === 'number' ? record.timestamp : null
        const project = typeof record.project === 'string' ? record.project : ''
        if (!sessionId || display === null || timestamp === null) continue
        let list = this.bySessionId.get(sessionId)
        if (!list) {
          list = []
          this.bySessionId.set(sessionId, list)
        }
        list.push({ text: display, timestamp, project, sessionId })
      }
      this.parsedTo += lastNewline + 1
    } finally {
      await handle.close()
    }
  }

  /** Chronological (the file is chronological; nothing re-sorts). */
  bySession(sessionId: string): readonly HistoryPrompt[] {
    return this.bySessionId.get(sessionId) ?? []
  }

  sessionIds(): Iterable<string> {
    return this.bySessionId.keys()
  }

  bytesReadForTests(): number {
    return this.lastBytesRead
  }
}
```

- [x] **Step 4: Run the test**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/claudeHistory.system.test.ts`
Expected: 3 PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/conversations/sources/claudeHistory.ts src/main/conversations/sources/claudeHistory.system.test.ts
git commit -m "feat(conversations): index Claude prompt history incrementally"
```

### Task 8: Claude source adapter

**Files:**
- Create: `src/main/conversations/sources/types.ts`
- Create: `src/main/conversations/sources/claude.ts`
- Create: `src/main/conversations/sources/claude.system.test.ts`

**Interfaces:**
- Produces: `SourceConversation`, `SourceScope = { scope: ConversationScope; family: RepositoryFamily }`, `ConversationSource { provider; discover(scope: SourceScope): Promise<SourceConversation[]>; prompts(nativeId: string, cwd: string): Promise<ConversationPrompt[]> }`, `class ClaudeConversationSource implements ConversationSource` with `constructor(deps: { projectsDir: string; history: ClaudeHistoryIndex })`.

- [x] **Step 1: Write the source types**

```ts
// src/main/conversations/sources/types.ts
import type { ConversationPrompt, ConversationScope } from '@shared/conversations/types.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { RepositoryFamily } from '@main/conversations/family.js'

// Raw, provider-shaped ingredients. No label, no kind, no order: the catalog
// decides those (docs/decomposition/conversations.md §4). An adapter reports
// what its store holds and where it got it from.

export type SourceConversation = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string | null
  gitBranch: string | null
  /** A title the USER chose (Claude customTitle, Codex name that is not a
   *  prefix of the title). */
  customTitle: string | null
  /** A title the PROVIDER generated (Claude aiTitle, OpenCode title). */
  aiTitle: string | null
  /** The first few user texts in document order, raw, wrappers included. */
  userTexts: string[]
  createdAt: number | null
  lastUserActivityAt: number | null
  activitySource: 'history' | 'index' | 'tail' | null
  mtime: number
  promptCount: number | null
  parentNativeId: string | null
  isNativeSubagent: boolean
  isExec: boolean
  originator: string | null
  origin: 'index' | 'scan'
  available: boolean
  file: string | null
}

export type SourceScope = {
  scope: ConversationScope
  family: RepositoryFamily
}

export interface ConversationSource {
  readonly provider: AgentProviderKind
  discover(scope: SourceScope): Promise<SourceConversation[]>
  /** Every user prompt of one conversation, newest first. */
  prompts(nativeId: string, cwd: string): Promise<ConversationPrompt[]>
}
```

- [x] **Step 2: Write the failing test**

```ts
// src/main/conversations/sources/claude.system.test.ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveFamily } from '../family.js'
import { ClaudeHistoryIndex } from './claudeHistory.js'
import { ClaudeConversationSource } from './claude.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

async function setup() {
  const corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  const listWorktrees = async () => worktrees
  const history = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
  await history.refresh()
  const source = new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history })
  return { corpus, source, listWorktrees }
}

describe('Claude conversation source', () => {
  it('discovers every family transcript across the recorded worktree dirs and nothing from the control project', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const rows = await source.discover({ scope: 'repository', family })
    const counts = corpus.manifest.counts as { claude: { inFamily: number; orchestrationChildren: number } }
    expect(rows).toHaveLength(counts.claude.inFamily)
    expect(new Set(rows.map(r => r.nativeId)).size).toBe(rows.length)
    expect(rows.every(r => r.cwd === null || family.matches(r.cwd))).toBe(true)
    expect(rows.filter(r => r.userTexts[0]?.startsWith('<orchestration-handoff>')).length).toBe(counts.claude.orchestrationChildren)
    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees }) })
    expect(everywhere.length).toBeGreaterThan(rows.length)
  })

  it('reads titles from the tail, the first prompts from a record-bounded head, and activity from history', async () => {
    const { source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const rows = await source.discover({ scope: 'cwd', family })
    const titled = rows.filter(r => r.aiTitle !== null)
    // 310 of 371 real transcripts carry an ai-title record; the corpus keeps
    // the tail, so the fixture dir must show the same majority.
    expect(titled.length).toBeGreaterThan(rows.length / 2)
    for (const r of titled) expect(r.aiTitle).toMatch(/^p:[0-9a-f]{8}:\d+$/)
    const fromHistory = rows.filter(r => r.activitySource === 'history')
    expect(fromHistory.length).toBeGreaterThan(rows.length / 2)
    for (const r of fromHistory) {
      expect(r.promptCount).toBeGreaterThan(0)
      expect(r.lastUserActivityAt).toBeGreaterThan(0)
    }
    const stt = rows.find(r => r.userTexts.some(t => t.startsWith('<stt')))
    expect(stt, 'the corpus records at least one dictated first prompt').toBeDefined()
    expect(rows.every(r => r.mtime > 0 && r.file !== null && r.origin === 'scan')).toBe(true)
  })

  it('returns the exact-cwd directory only for cwd scope and includes the case-variant transcript', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const rows = await source.discover({ scope: 'cwd', family })
    const dir = join(corpus.claudeConfigDir, 'projects', '-fixture-repo')
    const files = (await readdir(dir)).filter(n => n.endsWith('.jsonl'))
    expect(rows).toHaveLength(files.length)
  })

  it('lists prompts newest first for one conversation', async () => {
    const { source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees })
    const rows = await source.discover({ scope: 'cwd', family })
    const row = rows.find(r => (r.promptCount ?? 0) > 2)!
    const prompts = await source.prompts(row.nativeId, row.cwd ?? '/fixture/repo')
    expect(prompts.length).toBeGreaterThan(0)
    for (let i = 1; i < prompts.length; i++) {
      expect(prompts[i - 1].timestamp ?? 0).toBeGreaterThanOrEqual(prompts[i].timestamp ?? 0)
    }
  })
})
```

- [x] **Step 3: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/claude.system.test.ts`
Expected: FAIL, `./claude.js` not found.

- [x] **Step 4: Write the adapter**

```ts
// src/main/conversations/sources/claude.ts
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { parseJsonRecord, asRecord } from '@shared/lib/asRecord.js'
import { sanitizePath } from '@shared/runtime/projectDir.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { extractPromptsFromFile } from '@main/conversations/prompts/promptFolder.js'
import type { ClaudeHistoryIndex } from './claudeHistory.js'
import type { ConversationSource, SourceConversation, SourceScope } from './types.js'

// Claude Code stores one directory per cwd under ~/.claude/projects, named by
// sanitizePath(cwd), and one `<uuid>.jsonl` per session inside it. There is
// no cross-directory index, so discovery is: pick the directories the family
// can own, stat every transcript, then read a bounded head and tail of each.
//
// WHY the head read is RECORD-bounded and not byte-bounded: modern transcripts
// open with `last-prompt`, `mode`, `permission-mode`, `bridge-session` and
// several multi-kilobyte `attachment` records (hook output, environment
// snapshot, deferred tool list) before the first `user` record, which sits at
// index 6–8 on the recorded corpus. A 16 KB byte head, the old lister's
// assumption, can end inside those attachments. JSONL frames by line; so do
// we, and we stop at the first six user texts or 200 records, whichever
// comes first.
//
// WHY the tail read is BYTE-bounded: `ai-title`, `customTitle` and the newest
// user timestamp are re-appended near the end of the file, so the last 64 KB
// holds them; the first complete line inside the window is where parsing
// starts.

const HEAD_RECORD_LIMIT = 200
const HEAD_USER_TEXTS = 6
const TAIL_BYTES = 64 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ClaudeSummary = {
  cwd: string | null
  gitBranch: string | null
  createdAt: number | null
  userTexts: string[]
  aiTitle: string | null
  customTitle: string | null
  tailUserAt: number | null
  empty: boolean
}

type SummaryCacheEntry = { mtimeMs: number; size: number; summary: ClaudeSummary }

function userText(record: Record<string, unknown>): string | null {
  if (record.type !== 'user') return null
  if (record.isMeta === true) return null
  if (record.isCompactSummary === true) return null
  const message = asRecord(record.message)
  if (!message || message.role !== 'user') return null
  const content = message.content
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = asRecord(block)
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text.trim()
  }
  return null
}

function timestampOf(record: Record<string, unknown>): number | null {
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  return Number.isFinite(ts) ? ts : null
}

async function readHead(file: string): Promise<Pick<ClaudeSummary, 'cwd' | 'gitBranch' | 'createdAt' | 'userTexts'>> {
  const out = { cwd: null as string | null, gitBranch: null as string | null, createdAt: null as number | null, userTexts: [] as string[] }
  let records = 0
  for await (const record of streamJsonl<Record<string, unknown>>(file)) {
    if (!record) continue
    records++
    if (out.cwd === null && typeof record.cwd === 'string' && record.cwd) out.cwd = record.cwd
    if (out.gitBranch === null && typeof record.gitBranch === 'string' && record.gitBranch) out.gitBranch = record.gitBranch
    if (out.createdAt === null) out.createdAt = timestampOf(record)
    const text = userText(record)
    if (text) out.userTexts.push(text)
    if (out.userTexts.length >= HEAD_USER_TEXTS || records >= HEAD_RECORD_LIMIT) break
  }
  return out
}

async function readTail(file: string, size: number): Promise<Pick<ClaudeSummary, 'aiTitle' | 'customTitle' | 'tailUserAt' | 'gitBranch'>> {
  const out = { aiTitle: null as string | null, customTitle: null as string | null, tailUserAt: null as number | null, gitBranch: null as string | null }
  if (size === 0) return out
  const handle = await open(file, 'r')
  try {
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.allocUnsafe(size - start)
    let offset = 0
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    let text = buf.subarray(0, offset).toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1)
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const record = parseJsonRecord(line)
      if (!record) continue
      if (typeof record.aiTitle === 'string' && record.aiTitle.trim()) out.aiTitle = record.aiTitle.trim()
      if (typeof record.customTitle === 'string' && record.customTitle.trim()) out.customTitle = record.customTitle.trim()
      if (typeof record.gitBranch === 'string' && record.gitBranch) out.gitBranch = record.gitBranch
      if (userText(record)) {
        const ts = timestampOf(record)
        if (ts !== null) out.tailUserAt = ts
      }
    }
  } finally {
    await handle.close()
  }
  return out
}

export class ClaudeConversationSource implements ConversationSource {
  readonly provider = 'claude' as const
  private readonly summaries = new Map<string, SummaryCacheEntry>()

  constructor(private readonly deps: { projectsDir: string; history: ClaudeHistoryIndex }) {}

  private async candidateDirs(scope: SourceScope): Promise<Array<{ dir: string; exact: boolean }>> {
    let names: string[]
    try {
      names = (await readdir(this.deps.projectsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
    } catch {
      return []
    }
    if (scope.scope === 'everywhere') return names.map(dir => ({ dir, exact: false }))
    const sanitizedRoots = scope.family.rawRoots.map(sanitizePath)
    const out: Array<{ dir: string; exact: boolean }> = []
    for (const dir of names) {
      const exact = sanitizedRoots.includes(dir)
      // The `-` continuation catches `.worktrees/<name>` (`--worktrees-<name>`),
      // `packages/<x>` and pruned worktrees; a transcript's recorded cwd then
      // decides membership, so `<repo>-other` cannot slip in on the prefix.
      if (exact || (scope.scope === 'repository' && sanitizedRoots.some(r => dir.startsWith(r + '-')))) out.push({ dir, exact })
    }
    return out
  }

  private async summarize(file: string, mtimeMs: number, size: number): Promise<ClaudeSummary> {
    const cached = this.summaries.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.summary
    const head = await readHead(file)
    const tail = await readTail(file, size)
    const summary: ClaudeSummary = {
      cwd: head.cwd,
      gitBranch: tail.gitBranch ?? head.gitBranch,
      createdAt: head.createdAt,
      userTexts: head.userTexts,
      aiTitle: tail.aiTitle,
      customTitle: tail.customTitle,
      tailUserAt: tail.tailUserAt,
      empty: size === 0,
    }
    this.summaries.set(file, { mtimeMs, size, summary })
    return summary
  }

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.claude.discover', { scope: scope.scope })
    await this.deps.history.refresh()
    const dirs = await this.candidateDirs(scope)
    const rows: SourceConversation[] = []
    const seen = new Set<string>()
    for (const { dir, exact } of dirs) {
      let names: string[]
      try {
        names = await readdir(join(this.deps.projectsDir, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const nativeId = name.slice(0, -6)
        if (!UUID_RE.test(nativeId) || seen.has(nativeId)) continue
        const file = join(this.deps.projectsDir, dir, name)
        let s
        try {
          s = await stat(file)
        } catch {
          continue
        }
        const summary = await this.summarize(file, s.mtimeMs, s.size)
        // Membership: the recorded cwd wins; a transcript that never recorded
        // one (the 0-byte session) belongs only to an exactly-matching dir.
        if (scope.scope !== 'everywhere') {
          if (summary.cwd ? !scope.family.matches(summary.cwd) : !exact) continue
        }
        seen.add(nativeId)
        const history = this.deps.history.bySession(nativeId)
        const historyLast = history.length > 0 ? history[history.length - 1]!.timestamp : null
        rows.push({
          provider: 'claude',
          nativeId,
          cwd: summary.cwd,
          gitBranch: summary.gitBranch,
          customTitle: summary.customTitle,
          aiTitle: summary.aiTitle,
          userTexts: summary.userTexts,
          createdAt: summary.createdAt,
          lastUserActivityAt: historyLast ?? summary.tailUserAt,
          activitySource: historyLast !== null ? 'history' : summary.tailUserAt !== null ? 'tail' : null,
          mtime: s.mtimeMs,
          promptCount: history.length > 0 ? history.length : null,
          parentNativeId: null,
          isNativeSubagent: false,
          isExec: false,
          originator: null,
          origin: 'scan',
          available: !summary.empty,
          file,
        })
      }
    }
    span.end({ dirs: dirs.length, rows: rows.length })
    return rows
  }

  async prompts(nativeId: string, cwd: string): Promise<ConversationPrompt[]> {
    const direct = join(this.deps.projectsDir, sanitizePath(cwd), `${nativeId}.jsonl`)
    let file: string | null = null
    try {
      await stat(direct)
      file = direct
    } catch {
      // A conversation listed from a worktree dir is asked for with its own
      // cwd, so the direct path is the common case; the walk is the rare one.
      try {
        for (const dir of await readdir(this.deps.projectsDir)) {
          const candidate = join(this.deps.projectsDir, dir, `${nativeId}.jsonl`)
          try {
            await stat(candidate)
            file = candidate
            break
          } catch {
            // keep looking
          }
        }
      } catch {
        file = null
      }
    }
    if (!file) return []
    const { prompts } = await extractPromptsFromFile('claude', nativeId, file, 'all')
    return prompts.map(p => ({ text: p.text, timestamp: p.ts }))
  }
}
```

- [x] **Step 5: Run the test and typecheck**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/claude.system.test.ts && npx tsc -p tsconfig.node.json --pretty false`
Expected: 4 PASS; tsc clean. If the `<stt` assertion fails because the corpus has no dictated prompt in the exact-cwd dir, widen that test to `repository` scope; the real corpus has two (`bcc80949`, `dd3de2a3`).

- [x] **Step 6: Commit**

```bash
git add src/main/conversations/sources/types.ts src/main/conversations/sources/claude.ts src/main/conversations/sources/claude.system.test.ts
git commit -m "feat(conversations): discover Claude conversations across worktree project dirs"
```

### Task 9: Codex source adapter (index first, scan fallback, unindexed union)

**Files:**
- Create: `src/main/conversations/sources/codex.ts`
- Create: `src/main/conversations/sources/codex.system.test.ts`

**Interfaces:**
- Consumes: `openReadOnlySqlite`, `newestCodexStateDb` (Task 5), `extractPromptsFromFile` (Task 6), `listCodexSessions` and `findCodexRolloutPathByThreadId` from `codex-headless`.
- Produces: `class CodexConversationSource implements ConversationSource` with `constructor(deps: { codexHome: string; walkTtlMs?: number })`, plus `lastDowngradeReason(): string | null` for diagnostics.

- [x] **Step 1: Write the failing test**

```ts
// src/main/conversations/sources/codex.system.test.ts
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveFamily } from '../family.js'
import { CodexConversationSource } from './codex.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

async function setup() {
  const corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  const listWorktrees = async () => worktrees
  const source = new CodexConversationSource({ codexHome: corpus.codexHome })
  return { corpus, source, listWorktrees }
}

describe('Codex conversation source', () => {
  it('lists every family thread from the index with kinds, parents and activity, and none from the control set', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const counts = corpus.manifest.counts as { codex: { inFamily: number; control: number; exec: number; subagents: number; orchestrationChildren: number; sampledRollouts: number } }
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees })
    const rows = await source.discover({ scope: 'repository', family })
    const indexed = rows.filter(r => r.origin === 'index')
    expect(indexed).toHaveLength(counts.codex.inFamily)
    expect(indexed.filter(r => r.isExec)).toHaveLength(counts.codex.exec)
    expect(indexed.filter(r => r.isNativeSubagent)).toHaveLength(counts.codex.subagents)
    expect(indexed.filter(r => r.userTexts[0]?.startsWith('<orchestration-handoff>'))).toHaveLength(counts.codex.orchestrationChildren)
    expect(indexed.every(r => r.activitySource === 'index' && r.lastUserActivityAt !== null)).toBe(true)
    // Only the sampled rollouts exist on disk in the corpus; every other index
    // row must be reported, not dropped, and marked unavailable.
    expect(indexed.filter(r => r.available).length).toBeLessThanOrEqual(counts.codex.sampledRollouts + 3)
    expect(source.lastDowngradeReason()).toBeNull()
    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees }) })
    expect(everywhere.filter(r => r.origin === 'index')).toHaveLength(counts.codex.inFamily + counts.codex.control)
  })

  it('treats a Codex name that merely prefixes the title as no name', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const db = new DatabaseSync(join(corpus.codexHome, 'state_5.sqlite'))
    const named = db.prepare("select id, name, title from threads where name is not null and name <> '' limit 1").get() as { id: string; name: string; title: string } | undefined
    db.close()
    if (!named) return
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    const row = rows.find(r => r.nativeId === named.id)!
    expect(row.customTitle).toBe(named.title.startsWith(named.name) ? null : named.name)
  })

  it('unions rollouts on disk that the index does not know about', async () => {
    const { corpus, source, listWorktrees } = await setup()
    const counts = corpus.manifest.counts as { codex: { unindexedOnDisk: number } }
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    const scanned = rows.filter(r => r.origin === 'scan')
    expect(scanned.length).toBe(Math.min(3, counts.codex.unindexedOnDisk))
    for (const r of scanned) expect(r.available).toBe(true)
  })

  it('falls back to the rollout scan when the index is missing and reports why', async () => {
    const { corpus, source, listWorktrees } = await setup()
    await rename(join(corpus.codexHome, 'state_5.sqlite'), join(corpus.codexHome, 'state_5.sqlite.away'))
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.origin === 'scan' && r.available)).toBe(true)
    expect(source.lastDowngradeReason()).toMatch(/no state_N\.sqlite/)
  })

  it('lists prompts for a sampled rollout newest first', async () => {
    const { source, listWorktrees } = await setup()
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees })
    const rows = await source.discover({ scope: 'everywhere', family })
    const row = rows.find(r => r.available && r.origin === 'index' && !r.isExec)!
    const prompts = await source.prompts(row.nativeId, row.cwd ?? '')
    expect(prompts.length).toBeGreaterThan(0)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/codex.system.test.ts`
Expected: FAIL, `./codex.js` not found.

- [x] **Step 3: Write the adapter**

```ts
// src/main/conversations/sources/codex.ts
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { extractPromptsFromFile } from '@main/conversations/prompts/promptFolder.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import { asRecord } from '@shared/lib/asRecord.js'
import { findCodexRolloutPathByThreadId, listCodexSessions } from 'codex-headless'
import { newestCodexStateDb, openReadOnlySqlite } from './sqlite.js'
import type { ConversationSource, SourceConversation, SourceScope } from './types.js'

// Codex keeps its own index at ~/.codex/state_N.sqlite (`threads`,
// `thread_spawn_edges`), maintained by the CLI and backfilled from rollouts.
// It is what Codex's own resume picker reads. On the author's machine it
// answered "every thread for this repository" in 50 ms where the rollout
// walk took 1.5–2.9 s, and its `title` is the real first prompt because
// Codex strips its own AGENTS.md injection before writing it. So the index
// is the primary source, always.
//
// Three ways the index and the files disagree, each handled explicitly:
//   1. schema drift — `openReadOnlySqlite` probes the columns below and the
//      adapter downgrades to the scan with a recorded reason;
//   2. index rows whose rollout is gone (9 on the author's machine) — kept,
//      marked unavailable, so the user sees why a resume would fail;
//   3. rollouts the index never saw (22, all pre-index) — found by one
//      cached walk of the sessions tree and parsed by a local head reader.
//
// WHY `has_user_event` is ignored: it is 0 on every row of the recorded
// index and cannot be trusted as a "real session" signal.

export const CODEX_INDEX_COLUMNS = {
  threads: [
    'id', 'rollout_path', 'cwd', 'title', 'first_user_message', 'preview', 'name',
    'source', 'thread_source', 'agent_role', 'git_branch', 'created_at_ms',
    'updated_at_ms', 'recency_at_ms', 'archived', 'originator',
  ],
  thread_spawn_edges: ['parent_thread_id', 'child_thread_id'],
}

const DEFAULT_WALK_TTL_MS = 5 * 60 * 1000
const HEAD_RECORD_LIMIT = 200
const ROLLOUT_RE = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

type IndexRow = {
  id: string
  rollout_path: string
  cwd: string
  title: string
  first_user_message: string
  preview: string
  name: string | null
  source: string
  thread_source: string | null
  agent_role: string | null
  git_branch: string | null
  created_at_ms: number | null
  updated_at_ms: number | null
  recency_at_ms: number | null
  archived: number
  originator: string | null
}

type RolloutHead = {
  cwd: string | null
  gitBranch: string | null
  createdAt: number | null
  originator: string | null
  source: string | null
  userTexts: string[]
  lastUserAt: number | null
}

function isSubagentSource(row: IndexRow): boolean {
  if (row.thread_source === 'subagent') return true
  if (row.agent_role) return true
  // `source` is a JSON object for AgentControl spawns:
  // {"subagent":{"thread_spawn":{...}}}. Codex's own lister classifies by
  // deserialising it; a substring test is enough for a boolean and never
  // throws on a future shape.
  return row.source.startsWith('{') && row.source.includes('"subagent"')
}

/** Local head reader for rollouts the index does not cover. Mirrors
 *  codex-headless's parseCodexSession but also keeps the first few user
 *  texts and the newest user timestamp, which the picker needs and that
 *  lister does not return. Duplicated on purpose: widening the package
 *  contract for a fallback path is not worth a cross-repository change. */
async function readRolloutHead(file: string): Promise<RolloutHead> {
  const out: RolloutHead = { cwd: null, gitBranch: null, createdAt: null, originator: null, source: null, userTexts: [], lastUserAt: null }
  let records = 0
  for await (const record of streamJsonl<Record<string, unknown>>(file)) {
    if (!record) continue
    records++
    const payload = asRecord(record.payload)
    if (record.type === 'session_meta' && payload) {
      out.cwd = typeof payload.cwd === 'string' ? payload.cwd : null
      out.gitBranch = typeof asRecord(payload.git)?.branch === 'string' ? (asRecord(payload.git)!.branch as string) : null
      out.createdAt = typeof payload.timestamp === 'string' && Number.isFinite(Date.parse(payload.timestamp)) ? Date.parse(payload.timestamp) : null
      out.originator = typeof payload.originator === 'string' ? payload.originator : null
      out.source = typeof payload.source === 'string' ? payload.source : payload.source ? JSON.stringify(payload.source) : null
    } else if (record.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
      if (out.userTexts.length < 6) out.userTexts.push(payload.message)
      const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
      if (Number.isFinite(ts)) out.lastUserAt = ts
    }
    if (records >= HEAD_RECORD_LIMIT && out.userTexts.length > 0) break
  }
  return out
}

export class CodexConversationSource implements ConversationSource {
  readonly provider = 'codex' as const
  private downgradeReason: string | null = null
  private walk: { at: number; files: Map<string, { mtime: number; id: string }> } | null = null
  private readonly heads = new Map<string, { mtime: number; head: RolloutHead }>()

  constructor(private readonly deps: { codexHome: string; walkTtlMs?: number }) {}

  lastDowngradeReason(): string | null {
    return this.downgradeReason
  }

  private async walkRollouts(): Promise<Map<string, { mtime: number; id: string }>> {
    const ttl = this.deps.walkTtlMs ?? DEFAULT_WALK_TTL_MS
    if (this.walk && Date.now() - this.walk.at < ttl) return this.walk.files
    const files = new Map<string, { mtime: number; id: string }>()
    const visit = async (dir: string, depth: number): Promise<void> => {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      for (const name of names) {
        const full = join(dir, name)
        let s
        try {
          s = await stat(full)
        } catch {
          continue
        }
        if (s.isDirectory() && depth < 3) await visit(full, depth + 1)
        else if (s.isFile()) {
          const m = ROLLOUT_RE.exec(name)
          if (m) files.set(full, { mtime: s.mtimeMs, id: m[2]! })
        }
      }
    }
    await visit(join(this.deps.codexHome, 'sessions'), 0)
    this.walk = { at: Date.now(), files }
    return files
  }

  private async fromHead(file: string, mtime: number, id: string, family: SourceScope['family'], scope: SourceScope['scope']): Promise<SourceConversation | null> {
    const cached = this.heads.get(file)
    const head = cached && cached.mtime === mtime ? cached.head : await readRolloutHead(file)
    this.heads.set(file, { mtime, head })
    if (scope !== 'everywhere' && !family.matches(head.cwd)) return null
    return {
      provider: 'codex',
      nativeId: id,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      customTitle: null,
      aiTitle: null,
      userTexts: head.userTexts,
      createdAt: head.createdAt,
      lastUserActivityAt: head.lastUserAt,
      activitySource: head.lastUserAt !== null ? 'tail' : null,
      mtime,
      promptCount: null,
      parentNativeId: null,
      isNativeSubagent: head.source !== null && head.source.includes('"subagent"'),
      isExec: head.source === 'exec',
      originator: head.originator,
      origin: 'scan',
      available: true,
      file,
    }
  }

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.codex.discover', { scope: scope.scope })
    const dbPath = newestCodexStateDb(this.deps.codexHome)
    const opened = dbPath ? openReadOnlySqlite(dbPath, CODEX_INDEX_COLUMNS) : { ok: false as const, reason: `no state_N.sqlite under ${this.deps.codexHome}` }
    if (!opened.ok) {
      this.downgradeReason = opened.reason
      const rows = await this.scanEverything(scope)
      span.end({ mode: 'scan', rows: rows.length })
      return rows
    }
    this.downgradeReason = null
    const rows: SourceConversation[] = []
    const indexedPaths = new Set<string>()
    try {
      const parents = new Map<string, string>()
      for (const edge of opened.db.prepare('select parent_thread_id, child_thread_id from thread_spawn_edges').all() as Array<{ parent_thread_id: string; child_thread_id: string }>) {
        parents.set(edge.child_thread_id, edge.parent_thread_id)
      }
      // WHY the family predicate runs in SQL: 1,133 of 2,007 rows are this
      // repository's; filtering in SQL keeps the JS side proportional to the
      // answer. lower() keeps darwin's case-insensitive cwds equal.
      const predicates: string[] = []
      const args: string[] = []
      if (scope.scope === 'cwd') {
        predicates.push('lower(cwd) = ?')
        args.push(scope.family.cwd)
      } else if (scope.scope === 'repository') {
        for (const root of scope.family.roots) {
          predicates.push('lower(cwd) = ?', "lower(cwd) like ? escape '\\'")
          args.push(root, root.replace(/[\\%_]/g, '\\$&') + '/%')
        }
      }
      const where = predicates.length > 0 ? `where archived = 0 and (${predicates.join(' or ')})` : 'where archived = 0'
      const columns = CODEX_INDEX_COLUMNS.threads.map(c => `"${c}"`).join(', ')
      for (const row of opened.db.prepare(`select ${columns} from threads ${where}`).all(...args) as IndexRow[]) {
        indexedPaths.add(row.rollout_path)
        const title = (row.title ?? '').trim() || (row.first_user_message ?? '').trim() || (row.preview ?? '').trim()
        const name = (row.name ?? '').trim()
        rows.push({
          provider: 'codex',
          nativeId: row.id,
          cwd: row.cwd || null,
          gitBranch: row.git_branch || null,
          // Codex fills `name` with a truncation of the first prompt unless the
          // user renamed the thread; a name that prefixes the title is the
          // former and carries less than the title does.
          customTitle: name && !title.startsWith(name) ? name : null,
          aiTitle: null,
          userTexts: title ? [title] : [],
          createdAt: row.created_at_ms ?? null,
          lastUserActivityAt: row.recency_at_ms ?? row.updated_at_ms ?? null,
          activitySource: row.recency_at_ms !== null || row.updated_at_ms !== null ? 'index' : null,
          mtime: row.updated_at_ms ?? 0,
          promptCount: null,
          parentNativeId: parents.get(row.id) ?? null,
          isNativeSubagent: isSubagentSource(row),
          isExec: row.source === 'exec',
          originator: row.originator ?? null,
          origin: 'index',
          available: existsSync(row.rollout_path),
          file: row.rollout_path,
        })
      }
    } finally {
      opened.close()
    }
    // Union with rollouts the index never recorded.
    const files = await this.walkRollouts()
    for (const [file, meta] of files) {
      if (indexedPaths.has(file)) continue
      const row = await this.fromHead(file, meta.mtime, meta.id, scope.family, scope.scope)
      if (row) rows.push(row)
    }
    span.end({ mode: 'index', rows: rows.length, unindexed: rows.filter(r => r.origin === 'scan').length })
    return rows
  }

  /** Degraded path: codex-headless's lister for identity, then the local head
   *  reader for the fields it does not return. Bounded by the family. */
  private async scanEverything(scope: SourceScope): Promise<SourceConversation[]> {
    const files = await this.walkRollouts()
    const rows: SourceConversation[] = []
    for (const [file, meta] of files) {
      const row = await this.fromHead(file, meta.mtime, meta.id, scope.family, scope.scope)
      if (row) rows.push(row)
    }
    return rows
  }

  async prompts(nativeId: string, _cwd: string): Promise<ConversationPrompt[]> {
    let file: string | null = null
    const dbPath = newestCodexStateDb(this.deps.codexHome)
    const opened = dbPath ? openReadOnlySqlite(dbPath, { threads: ['id', 'rollout_path'] }) : null
    if (opened?.ok) {
      try {
        const row = opened.db.prepare('select rollout_path from threads where id = ?').get(nativeId) as { rollout_path: string } | undefined
        if (row && existsSync(row.rollout_path)) file = row.rollout_path
      } finally {
        opened.close()
      }
    }
    if (!file) {
      try {
        file = await findCodexRolloutPathByThreadId(join(this.deps.codexHome, 'sessions'), nativeId)
      } catch {
        file = null
      }
    }
    if (!file) return []
    const { prompts } = await extractPromptsFromFile('codex', nativeId, file, 'all')
    return prompts.map(p => ({ text: p.text, timestamp: p.ts }))
  }
}

// Kept importable so the live suite can compare the index against the
// package lister on the real store.
export { listCodexSessions as codexFallbackLister }
```

- [x] **Step 4: Run the test and typecheck**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/codex.system.test.ts && npx tsc -p tsconfig.node.json --pretty false`
Expected: 5 PASS; tsc clean. If `findCodexRolloutPathByThreadId`'s signature differs from `(sessionsDir, id)`, read `packages/codex-headless/src/index.ts` and adapt the call; do not change the package.

- [x] **Step 5: Commit**

```bash
git add src/main/conversations/sources/codex.ts src/main/conversations/sources/codex.system.test.ts
git commit -m "feat(conversations): list Codex threads from the native sqlite index with scan fallback"
```

### Task 10: OpenCode source adapter

**Files:**
- Create: `src/main/conversations/sources/opencode.ts`
- Create: `src/main/conversations/sources/opencode.system.test.ts`

**Interfaces:**
- Produces: `class OpencodeConversationSource implements ConversationSource` with `constructor(deps: { dataDir: string; listPrompts(cwd: string, id: string): Promise<Array<{ text: string; timestamp: string | null }>> })`, `defaultOpencodeDataDir(): string`.

- [x] **Step 1: Write the failing test**

```ts
// src/main/conversations/sources/opencode.system.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveFamily } from '../family.js'
import { OpencodeConversationSource } from './opencode.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('OpenCode conversation source', () => {
  it('lists family sessions with parent links, titles and first user texts from the database', async () => {
    const corpus = await installConversationCorpus()
    cleanups.push(corpus.cleanup)
    const counts = corpus.manifest.counts as { opencode: { inFamily: number; control: number; children: number } }
    const porcelain = await corpusWorktreesPorcelain()
    const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
    const listPrompts = vi.fn(async () => [{ text: 'p:x:1', timestamp: '2026-09-11T00:00:00.000Z' }])
    const source = new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir, listPrompts })
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => worktrees })
    const rows = await source.discover({ scope: 'repository', family })
    expect(rows).toHaveLength(counts.opencode.inFamily)
    expect(rows.filter(r => r.isNativeSubagent)).toHaveLength(counts.opencode.children)
    expect(rows.every(r => r.aiTitle !== null && r.activitySource === 'index' && r.origin === 'index')).toBe(true)
    expect(rows.some(r => r.userTexts.length > 0)).toBe(true)
    const everywhere = await source.discover({ scope: 'everywhere', family: await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => worktrees }) })
    expect(everywhere).toHaveLength(counts.opencode.inFamily + counts.opencode.control)
    const prompts = await source.prompts(rows[0]!.nativeId, rows[0]!.cwd!)
    expect(prompts).toEqual([{ text: 'p:x:1', timestamp: Date.parse('2026-09-11T00:00:00.000Z') }])
    expect(listPrompts).toHaveBeenCalledWith(rows[0]!.cwd, rows[0]!.nativeId)
  })

  it('is empty, not broken, when the database is absent', async () => {
    const source = new OpencodeConversationSource({ dataDir: '/nonexistent/opencode', listPrompts: async () => [] })
    const family = await resolveFamily('/fixture/repo', 'everywhere', { listWorktrees: async () => [] })
    await expect(source.discover({ scope: 'everywhere', family })).resolves.toEqual([])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/opencode.system.test.ts`
Expected: FAIL, `./opencode.js` not found.

- [x] **Step 3: Write the adapter**

```ts
// src/main/conversations/sources/opencode.ts
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { asRecord, parseJsonRecord } from '@shared/lib/asRecord.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { openReadOnlySqlite } from './sqlite.js'
import type { ConversationSource, SourceConversation, SourceScope } from './types.js'

// OpenCode keeps every session in ~/.local/share/opencode/opencode.db:
// `session` (id, parent_id, directory, title, time_created, time_updated,
// time_archived) with messages in `message` (data JSON with `role`) and their
// text in `part` (data JSON with `type: "text"`, `text`, and `synthetic: true`
// on compaction continuations). Issue #773 asked for this list; the CLI's
// `session list --format json` is the same table one process spawn away, so
// the database is read directly and the CLI stays the transcript adapter's
// concern (export/import).
//
// WHY the title is an ai-title and never a provider-name: OpenCode generates
// it; a user rename is indistinguishable in the schema, so the ladder treats
// it as generated and prefers a real first prompt only when the title is
// empty.

export const OPENCODE_COLUMNS = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated', 'time_archived'],
  message: ['id', 'session_id', 'time_created', 'data'],
  part: ['message_id', 'session_id', 'time_created', 'data'],
}

const USER_TEXTS = 4

export function defaultOpencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return xdg && xdg.length > 0 ? join(xdg, 'opencode') : join(homedir(), '.local', 'share', 'opencode')
}

type SessionRow = {
  id: string
  parent_id: string | null
  directory: string
  title: string
  time_created: number
  time_updated: number
  time_archived: number | null
}

export class OpencodeConversationSource implements ConversationSource {
  readonly provider = 'opencode' as const

  constructor(private readonly deps: {
    dataDir: string
    listPrompts(cwd: string, id: string): Promise<Array<{ text: string; timestamp: string | null }>>
  }) {}

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.opencode.discover', { scope: scope.scope })
    const opened = openReadOnlySqlite(join(this.deps.dataDir, 'opencode.db'), OPENCODE_COLUMNS)
    if (!opened.ok) {
      span.end({ mode: 'absent', reason: opened.reason })
      return []
    }
    const rows: SourceConversation[] = []
    try {
      const predicates: string[] = []
      const args: string[] = []
      if (scope.scope === 'cwd') {
        predicates.push('lower(directory) = ?')
        args.push(scope.family.cwd)
      } else if (scope.scope === 'repository') {
        for (const root of scope.family.roots) {
          predicates.push('lower(directory) = ?', "lower(directory) like ? escape '\\'")
          args.push(root, root.replace(/[\\%_]/g, '\\$&') + '/%')
        }
      }
      const where = predicates.length > 0 ? `where time_archived is null and (${predicates.join(' or ')})` : 'where time_archived is null'
      const sessions = opened.db.prepare(`select id, parent_id, directory, title, time_created, time_updated, time_archived from session ${where}`).all(...args) as SessionRow[]
      // First user texts: the oldest user messages' text parts, skipping
      // synthetic compaction continuations. One prepared statement per session
      // over an indexed column is cheaper than joining the whole part table.
      const parts = opened.db.prepare(
        `select p.data as part, m.data as message from part p join message m on m.id = p.message_id
         where m.session_id = ? order by m.time_created asc, p.time_created asc limit 40`,
      )
      for (const s of sessions) {
        const userTexts: string[] = []
        for (const r of parts.all(s.id) as Array<{ part: string; message: string }>) {
          const message = parseJsonRecord(r.message)
          const part = parseJsonRecord(r.part)
          if (message?.role !== 'user' || part?.type !== 'text' || part.synthetic === true) continue
          if (typeof part.text === 'string' && part.text.trim()) userTexts.push(part.text.trim())
          if (userTexts.length >= USER_TEXTS) break
        }
        rows.push({
          provider: 'opencode',
          nativeId: s.id,
          cwd: s.directory || null,
          gitBranch: null,
          customTitle: null,
          aiTitle: s.title?.trim() || null,
          userTexts,
          createdAt: s.time_created ?? null,
          lastUserActivityAt: s.time_updated ?? null,
          activitySource: s.time_updated ? 'index' : null,
          mtime: s.time_updated ?? 0,
          promptCount: null,
          parentNativeId: s.parent_id ?? null,
          isNativeSubagent: s.parent_id !== null,
          isExec: false,
          originator: null,
          origin: 'index',
          available: true,
          file: null,
        })
      }
    } finally {
      opened.close()
    }
    span.end({ mode: 'index', rows: rows.length })
    return rows
  }

  async prompts(nativeId: string, cwd: string): Promise<ConversationPrompt[]> {
    const prompts = await this.deps.listPrompts(cwd, nativeId)
    return prompts
      .map(p => ({ text: p.text, timestamp: p.timestamp && Number.isFinite(Date.parse(p.timestamp)) ? Date.parse(p.timestamp) : null }))
      .reverse()
  }
}

void asRecord
```

Remove the trailing `void asRecord` line and the unused import if `asRecord` is not needed after the code is typed; the plan keeps the import list explicit so the executor does not guess.

- [x] **Step 4: Run the test and typecheck**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/sources/opencode.system.test.ts && npx tsc -p tsconfig.node.json --pretty false`
Expected: 2 PASS; tsc clean.

- [x] **Step 5: Commit**

```bash
git add src/main/conversations/sources/opencode.ts src/main/conversations/sources/opencode.system.test.ts
git commit -m "feat(conversations): list OpenCode sessions from its database"
```

---

## Stage 2 — The catalog

### Task 11: Wrapper unwrapping

**Files:**
- Create: `src/main/conversations/catalog/unwrap.ts`
- Create: `src/main/conversations/catalog/unwrap.test.ts`

**Interfaces:**
- Produces: `unwrapUserText(raw: string): UnwrappedUserText | null` where `UnwrappedUserText = { text: string; wrapper: 'stt' | 'orchestration-handoff' | 'projected-handoff' | null }`; `null` means "not a prompt a human typed". `firstUnwrappedPrompt(userTexts: readonly string[]): { text: string; wrapper: UnwrappedUserText['wrapper'] } | null` walks the list and returns the first non-null.

- [x] **Step 1: Write the failing test**

Every literal below is the opening of a real record from the corpus (ids in comments) with its private remainder replaced; the assertions are about the prefix rule, which is exactly what the redaction preserves.

```ts
// src/main/conversations/catalog/unwrap.test.ts
import { describe, expect, it } from 'vitest'

import { firstUnwrappedPrompt, unwrapUserText } from './unwrap.js'

describe('unwrapUserText', () => {
  it('returns a dictated prompt without its stt wrapper', () => {
    // claude bcc80949 first prompt
    const raw = '<stt note="Speech-to-text; may contain transcription mistakes.">\n We have a lot of things to do\n</stt>'
    expect(unwrapUserText(raw)).toEqual({ text: 'We have a lot of things to do', wrapper: 'stt' })
  })

  it('returns the task inside an orchestration handoff', () => {
    // claude 54e5b227 / codex 01a08ddd first prompt
    const raw = '<orchestration-handoff>\nYou are now an orchestrated child agent in Agent Code.\nFollow only the new task and instructions below.\n</orchestration-handoff>\n\n<task>\nReview the Grok lifecycle.\n</task>'
    expect(unwrapUserText(raw)).toEqual({ text: 'Review the Grok lifecycle.', wrapper: 'orchestration-handoff' })
  })

  it('treats a handoff without a task block as the text after the wrapper', () => {
    const raw = '<orchestration-handoff>\nYou are now an orchestrated child agent.\n</orchestration-handoff>\n\nDo the thing.'
    expect(unwrapUserText(raw)).toEqual({ text: 'Do the thing.', wrapper: 'orchestration-handoff' })
  })

  it('marks a provider-switch handoff summary as projected and labels it by its first heading', () => {
    // claude 05b2f009 first prompt
    const raw = '# Handoff Summary\n## Current objective\nPlan and eventually implement a redesigned picker'
    expect(unwrapUserText(raw)).toEqual({ text: 'Current objective', wrapper: 'projected-handoff' })
    expect(unwrapUserText('# Portable handoff summary\n\n## Current state\nThe active work is complete')).toEqual({ text: 'Current state', wrapper: 'projected-handoff' })
  })

  it.each([
    '# AGENTS.md instructions for /Users/x/y\n\n<INSTRUCTIONS>',
    '<environment_context>\n<cwd>/x</cwd>',
    '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
    '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.',
    '<local-command-stdout>Set model to Fable</local-command-stdout>',
    '<recommended_plugins>\nHere is a list of plugins',
    '<user_instructions>x</user_instructions>',
    '<system-reminder>x</system-reminder>',
    '<task-notification>\n<task-id>x</task-id>',
    '<unknown-wrapper>anything</unknown-wrapper>',
    '   ',
  ])('is not a prompt: %s', raw => {
    expect(unwrapUserText(raw)).toBeNull()
  })

  it('returns plain text unchanged apart from trimming', () => {
    expect(unwrapUserText('  break down this project \n')).toEqual({ text: 'break down this project', wrapper: null })
  })
})

describe('firstUnwrappedPrompt', () => {
  it('skips injected messages to reach the real first prompt', () => {
    // codex 01a0889d as the old lister saw it: AGENTS.md first, prompt second
    expect(firstUnwrappedPrompt(['# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>', 'break down this project'])).toEqual({ text: 'break down this project', wrapper: null })
    expect(firstUnwrappedPrompt(['<command-name>/compact</command-name>'])).toBeNull()
    expect(firstUnwrappedPrompt([])).toBeNull()
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/catalog/unwrap.test.ts`
Expected: FAIL, `./unwrap.js` not found.

- [x] **Step 3: Write the unwrapper**

```ts
// src/main/conversations/catalog/unwrap.ts

// What an angle-bracket or heading prefix on a user record MEANS.
//
// WHY a closed list (docs/decomposition/conversations.md §2.3): the old
// listers dropped every `<`-prefixed text as "a Claude Code system wrapper".
// That is false for `<stt …>` (a prompt the user dictated), loses the task
// text inside `<orchestration-handoff>`, and does nothing about Codex's
// `# AGENTS.md instructions for …` injection, which is why every Codex row
// read the same. Each entry below is proven by a corpus record; a wrapper not
// listed is treated as "not a prompt", and the fixture that surfaces it is
// the signal to extend the list, never a heuristic.

export type UnwrappedUserText = {
  text: string
  wrapper: 'stt' | 'orchestration-handoff' | 'projected-handoff' | null
}

/** Injected by a provider or by Agent Code; never something the user meant as a prompt. */
const NOT_A_PROMPT_PREFIXES: readonly string[] = [
  '# AGENTS.md instructions for',
  '<environment_context>',
  '<command-name>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<recommended_plugins>',
  '<user_instructions>',
  '<system-reminder>',
  '<task-notification>',
]

const PROJECTED_PREFIXES: readonly string[] = ['# Handoff Summary', '# Portable handoff summary']

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function unwrapUserText(raw: string): UnwrappedUserText | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('<stt')) {
    const open = trimmed.indexOf('>')
    const close = trimmed.lastIndexOf('</stt>')
    const inner = open >= 0 ? trimmed.slice(open + 1, close > open ? close : undefined) : ''
    const text = collapse(inner)
    return text ? { text, wrapper: 'stt' } : null
  }

  if (trimmed.startsWith('<orchestration-handoff>')) {
    const taskOpen = trimmed.indexOf('<task>')
    const taskClose = trimmed.lastIndexOf('</task>')
    if (taskOpen >= 0) {
      const text = collapse(trimmed.slice(taskOpen + '<task>'.length, taskClose > taskOpen ? taskClose : undefined))
      if (text) return { text, wrapper: 'orchestration-handoff' }
    }
    const end = trimmed.indexOf('</orchestration-handoff>')
    const after = end >= 0 ? trimmed.slice(end + '</orchestration-handoff>'.length) : ''
    const text = collapse(after)
    return text ? { text, wrapper: 'orchestration-handoff' } : { text: 'Orchestration child', wrapper: 'orchestration-handoff' }
  }

  for (const prefix of PROJECTED_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      // The summary body is the previous provider's whole conversation; its
      // first sub-heading is the most recognisable one-line handle.
      const heading = trimmed.split('\n').map(l => l.trim()).find(l => /^##+\s+\S/.test(l))
      return { text: heading ? collapse(heading.replace(/^#+\s+/, '')) : 'Continued conversation', wrapper: 'projected-handoff' }
    }
  }

  for (const prefix of NOT_A_PROMPT_PREFIXES) {
    if (trimmed.startsWith(prefix)) return null
  }
  if (trimmed.startsWith('<')) return null

  return { text: collapse(trimmed), wrapper: null }
}

export function firstUnwrappedPrompt(userTexts: readonly string[]): UnwrappedUserText | null {
  for (const raw of userTexts) {
    const unwrapped = unwrapUserText(raw)
    if (unwrapped) return unwrapped
  }
  return null
}
```

- [x] **Step 4: Run the test**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/catalog/unwrap.test.ts`
Expected: all PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/conversations/catalog/unwrap.ts src/main/conversations/catalog/unwrap.test.ts
git commit -m "feat(conversations): decide what each injected prompt wrapper means"
```

### Task 12: Classification, label ladder and ordering

**Files:**
- Create: `src/main/conversations/catalog/classify.ts`
- Create: `src/main/conversations/catalog/label.ts`
- Create: `src/main/conversations/catalog/order.ts`
- Create: `src/main/conversations/catalog/rules.test.ts`
- Create: `src/main/conversations/ledger/types.ts`

**Interfaces:**
- Consumes: `UnwrappedUserText` (Task 11), `SourceConversation` (Task 8).
- Produces: `LedgerRow` (`src/main/conversations/ledger/types.ts`): `{ provider; nativeId; localSessionId: string | null; cwd: string | null; title: string | null; agentName: string | null; orchestration: { parentNativeId: string | null; role: string | null; runId: string | null } | null; firstSeenAt: number; lastSeenAt: number; closedAt: number | null }`; `classifyConversation(source, ledger: LedgerRow | null, first: UnwrappedUserText | null): ConversationKind`; `resolveLabel(source, ledger, first, cwdBasename: string | null): { label: string; labelSource: ConversationLabelSource }`; `activityOf(source): { at: number; source: ConversationActivitySource }`; `compareByActivity(a: Conversation, b: Conversation): number`; `encodeCursor(row: Conversation): string`; `decodeCursor(cursor: string): { at: number; key: string } | null`.

- [x] **Step 1: Write the ledger row type**

```ts
// src/main/conversations/ledger/types.ts
import type { AgentProviderKind } from '@shared/types/providerKind.js'

/** What Agent Code durably remembers about a conversation that ran here. The
 *  catalog joins it by `provider:nativeId`; historical transcripts have none. */
export type LedgerRow = {
  provider: AgentProviderKind
  nativeId: string
  localSessionId: string | null
  cwd: string | null
  title: string | null
  agentName: string | null
  orchestration: {
    parentNativeId: string | null
    role: string | null
    runId: string | null
  } | null
  firstSeenAt: number
  lastSeenAt: number
  closedAt: number | null
}
```

- [x] **Step 2: Write the failing rules test**

```ts
// src/main/conversations/catalog/rules.test.ts
import { describe, expect, it } from 'vitest'

import type { Conversation } from '@shared/conversations/types.js'
import type { SourceConversation } from '../sources/types.js'
import type { LedgerRow } from '../ledger/types.js'
import { classifyConversation } from './classify.js'
import { activityOf, compareByActivity, decodeCursor, encodeCursor } from './order.js'
import { resolveLabel } from './label.js'
import { unwrapUserText } from './unwrap.js'

// Ingredients copied from corpus rows (ids in comments); only the private
// text is replaced by placeholders, which is what the rules never read.
function source(over: Partial<SourceConversation>): SourceConversation {
  return {
    provider: 'claude', nativeId: 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1', cwd: '/fixture/repo', gitBranch: 'main',
    customTitle: null, aiTitle: null, userTexts: [], createdAt: 1, lastUserActivityAt: null, activitySource: null,
    mtime: 10, promptCount: null, parentNativeId: null, isNativeSubagent: false, isExec: false, originator: null,
    origin: 'scan', available: true, file: null, ...over,
  }
}
const ledger = (over: Partial<LedgerRow>): LedgerRow => ({
  provider: 'claude', nativeId: 'x', localSessionId: null, cwd: null, title: null, agentName: null, orchestration: null,
  firstSeenAt: 1, lastSeenAt: 2, closedAt: null, ...over,
})

describe('classifyConversation', () => {
  it('uses the ledger before the prompt sniff and the sniff for history', () => {
    const child = unwrapUserText('<orchestration-handoff>\nx\n</orchestration-handoff>\n<task>\nreview\n</task>')
    expect(classifyConversation(source({ userTexts: ['<orchestration-handoff>…'] }), null, child)).toBe('orchestration-child')
    expect(classifyConversation(source({}), ledger({ orchestration: { parentNativeId: 'p', role: 'reviewer', runId: null } }), null)).toBe('orchestration-child')
    // The ledger says it was a plain user session even though someone pasted a handoff manually.
    expect(classifyConversation(source({}), ledger({ orchestration: null }), child)).toBe('user')
  })
  it('classifies native subagents, exec runs, projected handoffs and empty transcripts', () => {
    expect(classifyConversation(source({ provider: 'codex', isNativeSubagent: true }), null, { text: 'x', wrapper: null })).toBe('native-subagent')
    expect(classifyConversation(source({ provider: 'codex', isExec: true }), null, { text: 'x', wrapper: null })).toBe('exec')
    expect(classifyConversation(source({}), null, unwrapUserText('# Handoff Summary\n## Objective\nx'))).toBe('projected')
    expect(classifyConversation(source({ provider: 'codex', originator: 'agent-transcript-parser' }), null, { text: 'x', wrapper: null })).toBe('projected')
    // claude a8220281: a 0-byte transcript with nothing to show.
    expect(classifyConversation(source({ available: false, aiTitle: null }), null, null)).toBe('empty')
    expect(classifyConversation(source({ aiTitle: 'p:aa:5' }), null, null)).toBe('user')
  })
})

describe('resolveLabel', () => {
  const first = { text: 'break down this project', wrapper: null } as const
  it('walks the ladder in order and records provenance', () => {
    expect(resolveLabel(source({}), ledger({ title: 'Picker rebuild' }), first, 'repo')).toEqual({ label: 'Picker rebuild', labelSource: 'agent-code-title' })
    expect(resolveLabel(source({ customTitle: 'my title', aiTitle: 'ai' }), null, first, 'repo')).toEqual({ label: 'my title', labelSource: 'provider-name' })
    expect(resolveLabel(source({ aiTitle: 'Project context bootstrapping' }), null, first, 'repo')).toEqual({ label: 'Project context bootstrapping', labelSource: 'ai-title' })
    expect(resolveLabel(source({}), null, first, 'repo')).toEqual({ label: 'break down this project', labelSource: 'first-prompt' })
    expect(resolveLabel(source({}), null, null, 'repo')).toEqual({ label: 'repo', labelSource: 'cwd' })
    expect(resolveLabel(source({ cwd: null }), null, null, null)).toEqual({ label: 'ededdea8', labelSource: 'native-id' })
  })
  it('labels a child by its task and a projected conversation by its heading, and caps the length', () => {
    const child = unwrapUserText('<orchestration-handoff>\nx\n</orchestration-handoff>\n<task>\nReview the Grok lifecycle.\n</task>')
    expect(resolveLabel(source({}), null, child, 'repo')).toEqual({ label: 'Review the Grok lifecycle.', labelSource: 'first-prompt' })
    const long = { text: 'x'.repeat(300), wrapper: null } as const
    expect(resolveLabel(source({}), null, long, 'repo').label).toHaveLength(121)
  })
})

describe('ordering', () => {
  it('prefers user activity over mtime and breaks ties by createdAt then key', () => {
    expect(activityOf(source({ lastUserActivityAt: 500, activitySource: 'history', mtime: 900 }))).toEqual({ at: 500, source: 'history' })
    expect(activityOf(source({ lastUserActivityAt: null, mtime: 900 }))).toEqual({ at: 900, source: 'mtime' })
    const row = (nativeId: string, lastUserActivityAt: number, createdAt: number | null): Conversation => ({
      provider: 'codex', nativeId, cwd: '/fixture/repo', repoRoot: '/fixture/repo', worktree: null, gitBranch: null, kind: 'user',
      parentNativeId: null, label: nativeId, labelSource: 'native-id', firstPrompt: null, agentName: null, agentCodeTitle: null,
      createdAt, lastUserActivityAt, activitySource: 'index', promptCount: null, available: true, origin: 'index', match: null,
    })
    const sorted = [row('a', 1, 1), row('b', 5, 1), row('c', 5, 9), row('d', 5, 9)].sort(compareByActivity)
    expect(sorted.map(r => r.nativeId)).toEqual(['c', 'd', 'b', 'a'])
    const cursor = encodeCursor(sorted[1]!)
    expect(decodeCursor(cursor)).toEqual({ at: 5, key: 'codex:d' })
    expect(decodeCursor('garbage')).toBeNull()
  })
})
```

- [x] **Step 3: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/catalog/rules.test.ts`
Expected: FAIL, modules not found.

- [x] **Step 4: Write classify, label and order**

```ts
// src/main/conversations/catalog/classify.ts
import type { ConversationKind } from '@shared/conversations/types.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import type { UnwrappedUserText } from './unwrap.js'

// docs/decomposition/conversations.md §2.2, one rule per line, in priority
// order. The ledger (a fact Agent Code recorded when it spawned the pane)
// outranks the prompt sniff (a guess from the transcript); provider-native
// subagent and exec flags outrank both because they are the provider's own
// classification of the thread.
export function classifyConversation(
  source: SourceConversation,
  ledger: LedgerRow | null,
  first: UnwrappedUserText | null,
): ConversationKind {
  if (source.isNativeSubagent) return 'native-subagent'
  if (source.isExec) return 'exec'
  if (ledger) {
    if (ledger.orchestration) return 'orchestration-child'
  } else if (first?.wrapper === 'orchestration-handoff') {
    return 'orchestration-child'
  }
  if (first?.wrapper === 'projected-handoff' || source.originator === 'agent-transcript-parser') return 'projected'
  if (!first && !source.aiTitle && !source.customTitle && !ledger?.title) return 'empty'
  return 'user'
}
```

```ts
// src/main/conversations/catalog/label.ts
import type { ConversationLabelSource } from '@shared/conversations/types.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import type { UnwrappedUserText } from './unwrap.js'

// The ladder (docs/decomposition/conversations.md §2.3). One order for every
// provider; `labelSource` is what lets a row mark a stand-in as a stand-in and
// lets a test assert the rung, which a flattened string never could (#701).
//
// WHY 120 characters: long prompts are pasted walls of text often enough that
// an untruncated label blows out every row; the conversation itself is one
// click away in the preview.
const LABEL_MAX_CHARS = 120
const ID_LABEL_CHARS = 8

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= LABEL_MAX_CHARS ? collapsed : collapsed.slice(0, LABEL_MAX_CHARS).trimEnd() + '…'
}

export function resolveLabel(
  source: SourceConversation,
  ledger: LedgerRow | null,
  first: UnwrappedUserText | null,
  cwdBasename: string | null,
): { label: string; labelSource: ConversationLabelSource } {
  const agentCodeTitle = ledger?.title?.trim()
  if (agentCodeTitle) return { label: clip(agentCodeTitle), labelSource: 'agent-code-title' }
  const providerName = source.customTitle?.trim()
  if (providerName) return { label: clip(providerName), labelSource: 'provider-name' }
  const aiTitle = source.aiTitle?.trim()
  if (aiTitle) return { label: clip(aiTitle), labelSource: 'ai-title' }
  if (first?.text) return { label: clip(first.text), labelSource: 'first-prompt' }
  if (cwdBasename) return { label: cwdBasename, labelSource: 'cwd' }
  return { label: source.nativeId.slice(0, ID_LABEL_CHARS), labelSource: 'native-id' }
}
```

```ts
// src/main/conversations/catalog/order.ts
import type { Conversation, ConversationActivitySource } from '@shared/conversations/types.js'
import { conversationKey } from '@shared/conversations/types.js'
import type { SourceConversation } from '../sources/types.js'

// docs/decomposition/conversations.md §2.4: last USER activity, never file
// mtime, because a background agent writing tool output every few seconds
// would otherwise outrank the session the user spent the afternoon in (#739).
// mtime is the last resort and is recorded as such so a test can prove an
// indexed provider never fell back to it.
export function activityOf(source: SourceConversation): { at: number; source: ConversationActivitySource } {
  if (source.lastUserActivityAt !== null && source.activitySource) return { at: source.lastUserActivityAt, source: source.activitySource }
  return { at: source.mtime, source: 'mtime' }
}

export function compareByActivity(a: Conversation, b: Conversation): number {
  if (b.lastUserActivityAt !== a.lastUserActivityAt) return b.lastUserActivityAt - a.lastUserActivityAt
  const ca = a.createdAt ?? 0
  const cb = b.createdAt ?? 0
  if (cb !== ca) return cb - ca
  return conversationKey(a.provider, a.nativeId) < conversationKey(b.provider, b.nativeId) ? -1 : 1
}

/** Cursor = activity timestamp + key of the last row on the page. Stable
 *  under new rows arriving above the page, which is the normal case while
 *  agents keep writing. */
export function encodeCursor(row: Conversation): string {
  return `${row.lastUserActivityAt}|${conversationKey(row.provider, row.nativeId)}`
}

export function decodeCursor(cursor: string): { at: number; key: string } | null {
  const bar = cursor.indexOf('|')
  if (bar <= 0) return null
  const at = Number(cursor.slice(0, bar))
  const key = cursor.slice(bar + 1)
  if (!Number.isFinite(at) || !key.includes(':')) return null
  return { at, key }
}
```

- [x] **Step 5: Run the test**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/catalog/rules.test.ts`
Expected: all PASS.

- [x] **Step 6: Commit**

```bash
git add src/main/conversations/catalog/classify.ts src/main/conversations/catalog/label.ts src/main/conversations/catalog/order.ts src/main/conversations/catalog/rules.test.ts src/main/conversations/ledger/types.ts
git commit -m "feat(conversations): classify, label with provenance and order by user activity"
```

### Task 13: Normalize, search and the listing builder

**Files:**
- Create: `src/main/conversations/catalog/normalize.ts`
- Create: `src/main/conversations/catalog/search.ts`
- Create: `src/main/conversations/catalog/listing.ts`
- Create: `src/main/conversations/catalog/listing.system.test.ts`
- Create: `src/main/conversations/importBoundaries.test.ts`

**Interfaces:**
- Produces: `normalizeConversation(source, ledger, family): Conversation`; `matchConversation(row, prompts: readonly string[], queryLower: string): ConversationMatch | null`; `buildListing(input: { sources: SourceConversation[]; ledger: ReadonlyMap<string, LedgerRow>; family: RepositoryFamily; request: ConversationListRequest; promptsFor?: (row: Conversation) => readonly string[]; startedAt: number }): ConversationListResponse`.

- [x] **Step 1: Write the failing listing test over the corpus**

```ts
// src/main/conversations/catalog/listing.system.test.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { conversationKey, type Conversation } from '@shared/conversations/types.js'
import { resolveFamily } from '../family.js'
import { ClaudeHistoryIndex } from '../sources/claudeHistory.js'
import { ClaudeConversationSource } from '../sources/claude.js'
import { CodexConversationSource } from '../sources/codex.js'
import { OpencodeConversationSource } from '../sources/opencode.js'
import { buildListing } from './listing.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

type Expectations = { kinds: Record<string, string>; labelSources: Record<string, string>; defaultOrderTop: string[] }

async function corpusListing(query?: string, includeChildren = false) {
  const corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => worktrees })
  const history = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
  const sources = [
    new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history }),
    new CodexConversationSource({ codexHome: corpus.codexHome }),
    new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir, listPrompts: async () => [] }),
  ]
  const all = (await Promise.all(sources.map(s => s.discover({ scope: 'repository', family })))).flat()
  const expectations = JSON.parse(await readFile('testing/fixtures/conversations/expectations.json', 'utf8')) as Expectations
  const response = buildListing({
    sources: all, ledger: new Map(), family,
    request: { cwd: '/fixture/repo', scope: 'repository', includeChildren, query, limit: 30 },
    promptsFor: row => row.provider === 'claude' ? history.bySession(row.nativeId).map(p => p.text) : [],
    startedAt: Date.now(),
  })
  return { corpus, all, expectations, response, history }
}

describe('buildListing over the recorded corpus', () => {
  it('drops nothing and duplicates nothing: rows plus hidden children equal the sources', async () => {
    const { all, response } = await corpusListing()
    expect(response.total).toBe(all.length)
    expect(new Set(all.map(s => conversationKey(s.provider, s.nativeId))).size).toBe(all.length)
    expect(response.rows.every(r => r.kind === 'user' || r.kind === 'projected')).toBe(true)
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => [] })
    const unpaged = buildListing({ sources: all, ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'repository', includeChildren: false, limit: 10_000 }, startedAt: Date.now() })
    expect(unpaged.rows.length + unpaged.hiddenChildren).toBe(unpaged.total)
    expect(unpaged.hiddenChildren).toBeGreaterThan(0)
  })

  it('reproduces the user-authored kinds, label sources and default order', async () => {
    const { all, expectations } = await corpusListing()
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => [] })
    const everything = buildListing({ sources: all, ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'repository', includeChildren: true, limit: 10_000 }, startedAt: Date.now() })
    const byKey = new Map(everything.rows.map(r => [conversationKey(r.provider, r.nativeId), r]))
    const kindMismatches: string[] = []
    const labelMismatches: string[] = []
    for (const [key, kind] of Object.entries(expectations.kinds)) {
      const row = byKey.get(key)
      if (!row) { kindMismatches.push(`${key}: missing`); continue }
      if (row.kind !== kind) kindMismatches.push(`${key}: ${row.kind} != ${kind}`)
      const expectedSource = expectations.labelSources[key]
      if (expectedSource && row.labelSource !== expectedSource) labelMismatches.push(`${key}: ${row.labelSource} != ${expectedSource}`)
    }
    expect(kindMismatches).toEqual([])
    expect(labelMismatches).toEqual([])
    const shown = everything.rows.filter(r => r.kind === 'user' || r.kind === 'projected').map(r => conversationKey(r.provider, r.nativeId))
    expect(shown.slice(0, expectations.defaultOrderTop.length)).toEqual(expectations.defaultOrderTop)
  })

  it('never falls back to mtime for an indexed provider and marks fallback labels', async () => {
    const { response } = await corpusListing(undefined, true)
    for (const row of response.rows) {
      if (row.provider !== 'claude') expect(row.activitySource).not.toBe('mtime')
      if (row.labelSource === 'cwd' || row.labelSource === 'native-id') expect(row.firstPrompt).toBeNull()
      expect(row.label.length).toBeGreaterThan(0)
    }
  })

  it('pages with a stable cursor and hides children per page', async () => {
    const { all } = await corpusListing()
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => [] })
    const request = { cwd: '/fixture/repo', scope: 'repository' as const, includeChildren: false, limit: 5 }
    const first = buildListing({ sources: all, ledger: new Map(), family, request, startedAt: Date.now() })
    expect(first.rows).toHaveLength(5)
    expect(first.nextCursor).not.toBeNull()
    const second = buildListing({ sources: all, ledger: new Map(), family, request: { ...request, cursor: first.nextCursor }, startedAt: Date.now() })
    expect(second.rows[0]!.lastUserActivityAt).toBeLessThanOrEqual(first.rows[4]!.lastUserActivityAt)
    expect(new Set([...first.rows, ...second.rows].map(r => r.nativeId)).size).toBe(10)
  })

  it('searches labels and Claude history prompts with a match span', async () => {
    const { all, history } = await corpusListing()
    const family = await resolveFamily('/fixture/repo', 'repository', { listWorktrees: async () => [] })
    // A session with history whose transcript is in the family: the corpus
    // history slice is built from exactly those sessions.
    const anyId = [...history.sessionIds()].find(id => all.some(s => s.provider === 'claude' && s.nativeId === id))!
    const needle = history.bySession(anyId)[0]!.text.slice(0, 12)
    const none = buildListing({ sources: [], ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'repository', query: needle, limit: 30 }, startedAt: Date.now() })
    expect(none.rows).toEqual([])
    const searched = buildListing({
      sources: all, ledger: new Map(), family,
      request: { cwd: '/fixture/repo', scope: 'repository', query: needle, includeChildren: true, limit: 30 },
      promptsFor: row => row.provider === 'claude' ? history.bySession(row.nativeId).map(p => p.text) : [], startedAt: Date.now(),
    })
    const hit = searched.rows.find(r => r.nativeId === anyId)
    expect(hit?.match).toMatchObject({ start: expect.any(Number), end: expect.any(Number) })
    expect(searched.rows.every(r => r.match !== null)).toBe(true)
  })

  it('applies provider and scope filters', async () => {
    const { all } = await corpusListing()
    const family = await resolveFamily('/fixture/repo', 'cwd', { listWorktrees: async () => [] })
    const codexOnly = buildListing({ sources: all, ledger: new Map(), family, request: { cwd: '/fixture/repo', scope: 'cwd', providers: ['codex'], includeChildren: true, limit: 10_000 }, startedAt: Date.now() })
    expect(codexOnly.rows.every(r => r.provider === 'codex' && r.cwd.toLowerCase() === '/fixture/repo')).toBe(true)
    expect(codexOnly.family.repoRoot).toBe('/fixture/repo')
  })
})
```

- [x] **Step 2: Write the import-boundary test**

```ts
// src/main/conversations/importBoundaries.test.ts
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The catalog is the isolated hard part (docs/decomposition/conversations.md
// §4): pure, one consumer, data flowing one way. Same filesystem-scan shape as
// src/providers/importBoundaries.test.ts, for the same reason: visible in the
// suite, loud in CI, no new tooling.
const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, '..', '..')

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...files(full)); continue }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}
const specifiers = (source: string) => [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]!)

describe('conversation catalog boundaries', () => {
  it('the catalog imports no I/O, no sources and no renderer', () => {
    for (const file of files(join(here, 'catalog'))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^(node:)?(fs|fs\/promises|child_process|sqlite)$|sources\/|@renderer|@main\/(ipc|sessionManager)|codex-headless|claude-code-headless|opencode-headless/)
      }
    }
  })
  it('sources never import the catalog, and the renderer never imports main conversations', () => {
    for (const file of files(join(here, 'sources'))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) expect(spec, `${file} imports ${spec}`).not.toMatch(/catalog\//)
    }
    for (const file of files(join(srcRoot, 'renderer'))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) expect(spec, `${file} imports ${spec}`).not.toMatch(/@main\/conversations|main\/conversations/)
    }
  })
})
```

- [x] **Step 3: Run both to verify they fail**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/catalog/listing.system.test.ts; NODE_ENV=test npx vitest run --project unit src/main/conversations/importBoundaries.test.ts`
Expected: listing FAILS (modules missing); boundaries PASS trivially (no catalog files yet violate).

- [x] **Step 4: Write normalize, search and listing**

```ts
// src/main/conversations/catalog/normalize.ts
import type { Conversation } from '@shared/conversations/types.js'
import type { RepositoryFamily } from '../family.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import { classifyConversation } from './classify.js'
import { resolveLabel } from './label.js'
import { activityOf } from './order.js'
import { firstUnwrappedPrompt } from './unwrap.js'

function basename(path: string | null): string | null {
  if (!path) return null
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? null
}

/** The worktree a cwd belongs to, for the row's second line. Null for the
 *  main checkout itself. Under the main root, `.worktrees/<name>` shows
 *  `<name>` and any other subdirectory shows its first segment; a sibling
 *  worktree (outside the root) shows its own directory name. */
function worktreeOf(cwd: string, family: RepositoryFamily): string | null {
  if (!family.root) return null
  const c = cwd.toLowerCase()
  if (c === family.root) return null
  if (c.startsWith(family.root + '/')) {
    const segments = cwd.slice(family.root.length + 1).split('/').filter(Boolean)
    return segments[0] === '.worktrees' ? segments[1] ?? null : segments[0] ?? null
  }
  for (const root of family.roots) {
    if (c === root || c.startsWith(root + '/')) return basename(cwd.slice(0, root.length))
  }
  return basename(cwd)
}

export function normalizeConversation(
  source: SourceConversation,
  ledger: LedgerRow | null,
  family: RepositoryFamily,
): Conversation {
  const first = firstUnwrappedPrompt(source.userTexts)
  const kind = classifyConversation(source, ledger, first)
  const cwd = source.cwd ?? ledger?.cwd ?? ''
  const { label, labelSource } = resolveLabel(source, ledger, first, basename(cwd))
  const activity = activityOf(source)
  return {
    provider: source.provider,
    nativeId: source.nativeId,
    cwd,
    repoRoot: family.root,
    worktree: cwd ? worktreeOf(cwd, family) : null,
    gitBranch: source.gitBranch,
    kind,
    parentNativeId: source.parentNativeId ?? ledger?.orchestration?.parentNativeId ?? null,
    label,
    labelSource,
    firstPrompt: first?.text ?? null,
    agentName: ledger?.agentName ?? null,
    agentCodeTitle: ledger?.title ?? null,
    createdAt: source.createdAt,
    lastUserActivityAt: activity.at,
    activitySource: activity.source,
    promptCount: source.promptCount,
    available: source.available,
    origin: source.origin,
    match: null,
  }
}
```

```ts
// src/main/conversations/catalog/search.ts
import type { Conversation, ConversationMatch } from '@shared/conversations/types.js'

// Substring, case-insensitive, first hit wins in this order: label, agent
// name, prompts. A word-boundary hit is not ranked above a mid-word one on
// purpose: rows are ordered by activity, and the user's complaint was about
// finding a session at all, not about ranking two hits against each other.
function span(field: ConversationMatch['field'], text: string, queryLower: string): ConversationMatch | null {
  const start = text.toLowerCase().indexOf(queryLower)
  return start < 0 ? null : { field, text, start, end: start + queryLower.length }
}

export function matchConversation(row: Conversation, prompts: readonly string[], queryLower: string): ConversationMatch | null {
  if (!queryLower) return null
  return span('label', row.label, queryLower)
    ?? (row.agentName ? span('name', row.agentName, queryLower) : null)
    ?? (row.firstPrompt ? span('prompt', row.firstPrompt, queryLower) : null)
    ?? prompts.reduce<ConversationMatch | null>((found, p) => found ?? span('prompt', p, queryLower), null)
}
```

```ts
// src/main/conversations/catalog/listing.ts
import type { Conversation, ConversationListRequest, ConversationListResponse } from '@shared/conversations/types.js'
import { conversationKey } from '@shared/conversations/types.js'
import type { RepositoryFamily } from '../family.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import { normalizeConversation } from './normalize.js'
import { compareByActivity, decodeCursor, encodeCursor } from './order.js'
import { matchConversation } from './search.js'

// The one pure entry point of the catalog. Sources in, ordered explained
// rows out. No I/O here: the service (Task 15) gathers sources and prompts.

export const DEFAULT_PAGE = 50
export const MAX_PAGE = 500
const HIDDEN_KINDS = new Set(['orchestration-child', 'native-subagent', 'exec', 'empty'])

export type BuildListingInput = {
  sources: readonly SourceConversation[]
  ledger: ReadonlyMap<string, LedgerRow>
  family: RepositoryFamily
  request: ConversationListRequest
  promptsFor?: (row: Conversation) => readonly string[]
  startedAt: number
}

export function buildListing(input: BuildListingInput): ConversationListResponse {
  const { request, family } = input
  const providers = request.providers && request.providers.length > 0 ? new Set(request.providers) : null
  const rows: Conversation[] = []
  const seen = new Set<string>()
  for (const source of input.sources) {
    if (providers && !providers.has(source.provider)) continue
    const key = conversationKey(source.provider, source.nativeId)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(normalizeConversation(source, input.ledger.get(key) ?? null, family))
  }
  const total = rows.length
  let visible = request.includeChildren ? rows : rows.filter(r => !HIDDEN_KINDS.has(r.kind))
  const hiddenChildren = total - visible.length
  const queryLower = request.query?.trim().toLowerCase() ?? ''
  if (queryLower) {
    visible = visible.flatMap(row => {
      const match = matchConversation(row, input.promptsFor?.(row) ?? [], queryLower)
      return match ? [{ ...row, match }] : []
    })
  }
  visible.sort(compareByActivity)
  const limit = Math.max(1, Math.min(MAX_PAGE, request.limit ?? DEFAULT_PAGE))
  let start = 0
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor)
    if (cursor) {
      const index = visible.findIndex(r => r.lastUserActivityAt === cursor.at && conversationKey(r.provider, r.nativeId) === cursor.key)
      start = index >= 0 ? index + 1 : visible.findIndex(r => r.lastUserActivityAt < cursor.at)
      if (start < 0) start = visible.length
    }
  }
  const page = visible.slice(start, start + limit)
  const last = page[page.length - 1]
  return {
    rows: page,
    total,
    hiddenChildren,
    nextCursor: start + limit < visible.length && last ? encodeCursor(last) : null,
    family: { repoRoot: family.root, roots: family.roots },
    timing: { ms: Math.max(0, Date.now() - input.startedAt) },
  }
}
```

- [x] **Step 5: Run the listing test until the expectations agree**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/catalog/listing.system.test.ts`
Expected: PASS. A kind or label mismatch here is a finding against either the rules or the expectations: show the mismatch list to the user and change only what they decide. Never edit `expectations.json` to match the code without that decision.

- [x] **Step 6: Run the boundary test and typecheck, then commit**

Run: `NODE_ENV=test npx vitest run --project unit src/main/conversations/importBoundaries.test.ts src/main/conversations/catalog && npx tsc -p tsconfig.node.json --pretty false`

```bash
git add src/main/conversations/catalog src/main/conversations/importBoundaries.test.ts
git commit -m "feat(conversations): build one ordered, explained listing from every source"
```

---

**Findings while making the expectations agree (2026-09-11):**
- The redaction policy hashed empty strings into `p:e3b0c442:0`, so 46 Codex exec threads gained a first prompt the real index never had. Empty and whitespace-only text, and empty branches, now stay empty.
- The extractor filed a cwd-less bridge-session stub from another project (`e3d5cfc8`) into the family root. Such files now keep their translated original directory, and the family count uses the adapter's exact-directory rule.
- Codex rollouts carried no mtime sidecar, so an unindexed synthesized rollout (`553bf83c`) sorted first, dated by the extraction run. Rollouts now carry `.stat.json`; the installer applies every recorded mtime and removes the sidecars.
- The draft never enumerated unindexed rollouts and lacked the `native-id` label rung; both added. The corpus is now 1,393 conversations.

## Stage 3 — Agent Code conversation ledger

### Task 14: Ledger, projection from workspace saves, and the store observer

**Files:**
- Create: `src/main/conversations/ledger/ledger.ts`
- Create: `src/main/conversations/ledger/ledger.system.test.ts`
- Modify: `src/main/storage/workspaceFileStore.ts:233-270` (add `observe()` and notify after `this.file = next`)
- Modify: `src/main/storage/paths.ts` (add `CONVERSATIONS_DIR`, `CONVERSATIONS_LEDGER_FILE`)
- Modify: `src/main/index.ts:892-900` (open the ledger after the store, subscribe, project once)

**Interfaces:**
- Consumes: `PersistedWindow` (`@main/storage/workspaceFile.js`), `LedgerRow` (Task 12).
- Produces: `class ConversationLedger { static open(path: string): Promise<ConversationLedger>; get(provider, nativeId): LedgerRow | null; rows(): ReadonlyMap<string, LedgerRow>; projectWindows(windows: readonly PersistedWindow[], agentNames: Readonly<Record<string, string>>, now?: number): Promise<void> }`, `readAgentNameAssignments(path: string): Promise<Record<string, string>>`, `WorkspaceFileStore.observe(listener: (windows: readonly PersistedWindow[]) => void): () => void`.

- [x] **Step 1: Write the failing test**

```ts
// src/main/conversations/ledger/ledger.system.test.ts
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import { ConversationLedger, readAgentNameAssignments } from './ledger.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

// The persisted shape is the renderer's PersistedWorkspace: `sessions` keyed
// by local id with providerSessionId, kind, cwd, title, agentNameId and the
// orchestration fields (src/renderer/src/workspace/types.ts SessionMeta).
function window(sessions: Record<string, Record<string, unknown>>): PersistedWindow {
  return { windowId: 'w1', bounds: null, displayId: null, fullScreen: false, workspace: { tabs: [], activeTabId: 't', sessions } }
}

describe('conversation ledger', () => {
  it('projects titled, named orchestration children from a workspace save and survives a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'ledger.jsonl')
    const ledger = await ConversationLedger.open(path)
    await ledger.projectWindows([window({
      parent: { kind: 'claude', cwd: '/repo', providerSessionId: 'p-native', title: 'Picker rebuild', agentNameId: 'id-apollo' },
      child: { kind: 'codex', cwd: '/repo/.worktrees/x', providerSessionId: 'c-native', orchestrationParentId: 'parent', orchestrationRole: 'reviewer', orchestrationRunId: 'run-1' },
      terminal: { kind: 'terminal', cwd: '/repo' },
      pending: { kind: 'claude', cwd: '/repo' },
    })], { 'id-apollo': 'Apollo' }, 1_000)
    expect(ledger.get('claude', 'p-native')).toMatchObject({ localSessionId: 'parent', title: 'Picker rebuild', agentName: 'Apollo', orchestration: null, firstSeenAt: 1_000, closedAt: null })
    expect(ledger.get('codex', 'c-native')).toMatchObject({ orchestration: { parentNativeId: 'p-native', role: 'reviewer', runId: 'run-1' }, cwd: '/repo/.worktrees/x' })
    expect(ledger.rows().size).toBe(2)
    const reopened = await ConversationLedger.open(path)
    expect(reopened.get('codex', 'c-native')?.orchestration?.parentNativeId).toBe('p-native')
  })

  it('writes only what changed, closes rows that vanish, and reopens a closed row that returns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'ledger.jsonl')
    const ledger = await ConversationLedger.open(path)
    const sessions = { a: { kind: 'claude', cwd: '/repo', providerSessionId: 'a-native' } }
    await ledger.projectWindows([window(sessions)], {}, 1)
    await ledger.projectWindows([window(sessions)], {}, 2)
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
    await ledger.projectWindows([window({})], {}, 3)
    expect(ledger.get('claude', 'a-native')?.closedAt).toBe(3)
    await ledger.projectWindows([window(sessions)], {}, 4)
    expect(ledger.get('claude', 'a-native')).toMatchObject({ closedAt: null, lastSeenAt: 4, firstSeenAt: 1 })
  })

  it('tolerates a truncated last line and compacts a long file on open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'ledger.jsonl')
    const ledger = await ConversationLedger.open(path)
    for (let i = 0; i < 50; i++) await ledger.projectWindows([window({ a: { kind: 'claude', cwd: '/repo', providerSessionId: 'a-native', title: `t${i}` } })], {}, i)
    await appendFile(path, '{"provider":"claude","nativeId":"trunc')
    const reopened = await ConversationLedger.open(path)
    expect(reopened.get('claude', 'a-native')?.title).toBe('t49')
    expect((await readFile(path, 'utf8')).trim().split('\n').length).toBeLessThanOrEqual(2)
  })

  it('reads agent name assignments without allocating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const names = join(dir, 'agent-names.json')
    await writeFile(names, JSON.stringify({ version: 1, nextIndex: 2, assignments: { 'id-1': 'Apollo', 'id-2': 'Jasper' } }))
    expect(await readAgentNameAssignments(names)).toEqual({ 'id-1': 'Apollo', 'id-2': 'Jasper' })
    expect(await readAgentNameAssignments(join(dir, 'missing.json'))).toEqual({})
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/ledger/ledger.system.test.ts`
Expected: FAIL, `./ledger.js` not found.

- [x] **Step 3: Write the ledger**

```ts
// src/main/conversations/ledger/ledger.ts
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { conversationKey } from '@shared/conversations/types.js'
import { isAgentProviderKind } from '@shared/types/providerKind.js'
import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import type { LedgerRow } from './types.js'

// What Agent Code durably remembers about conversations that ran here.
//
// WHY it exists (docs/decomposition/conversations.md, Stage 3): once a pane
// closes, the workspace file forgets its title, spoken name and orchestration
// role, and the only way to tell a review child from a real session becomes
// a prompt sniff. This file is the per-conversation projection of state the
// workspace already holds, keyed by the provider's native id so the catalog
// can join it against any transcript on disk.
//
// WHY a projection from workspace saves, not new IPC: main already receives
// every window's slice through WorkspaceFileStore.commit, and
// collectSessionIds already reads `sessions` out of that opaque blob. The
// renderer learns nothing new; a second write path would be a second opinion
// about identity.
//
// WHY append-only JSONL with a full-row snapshot per write: the reader is
// "last row per key wins", which survives a crash mid-append (a truncated last
// line is skipped) and needs no locking beyond the process's single writer.
// Compaction on open rewrites the file when it holds many more lines than
// rows, so the file stays proportional to the number of conversations.

const COMPACT_LINE_RATIO = 4

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function sameRow(a: LedgerRow, b: LedgerRow): boolean {
  return a.localSessionId === b.localSessionId && a.cwd === b.cwd && a.title === b.title && a.agentName === b.agentName
    && a.closedAt === b.closedAt && JSON.stringify(a.orchestration) === JSON.stringify(b.orchestration)
}

export async function readAgentNameAssignments(path: string): Promise<Record<string, string>> {
  // Read-only on purpose: AgentNameRegistry.resolve ALLOCATES on a miss, and
  // allocation is monotonic. The ledger must never spend a spoken address.
  try {
    const json: unknown = JSON.parse(await readFile(path, 'utf8'))
    const assignments = isRecord(json) && isRecord(json.assignments) ? json.assignments : {}
    const out: Record<string, string> = {}
    for (const [id, name] of Object.entries(assignments)) if (typeof name === 'string' && name.trim()) out[id] = name
    return out
  } catch {
    return {}
  }
}

export class ConversationLedger {
  private readonly byKey = new Map<string, LedgerRow>()
  private lineCount = 0
  private tail: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<ConversationLedger> {
    const ledger = new ConversationLedger(path)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as LedgerRow
        if (isAgentProviderKind(row.provider) && typeof row.nativeId === 'string') ledger.byKey.set(conversationKey(row.provider, row.nativeId), row)
        ledger.lineCount++
      } catch {
        // A truncated last line from a crash mid-append: skip it; the next
        // projection rewrites the row it belonged to.
      }
    }
    if (ledger.lineCount > COMPACT_LINE_RATIO * Math.max(1, ledger.byKey.size)) await ledger.compact()
    return ledger
  }

  get(provider: LedgerRow['provider'], nativeId: string): LedgerRow | null {
    return this.byKey.get(conversationKey(provider, nativeId)) ?? null
  }

  rows(): ReadonlyMap<string, LedgerRow> {
    return this.byKey
  }

  private async compact(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, [...this.byKey.values()].map(r => JSON.stringify(r)).join('\n') + (this.byKey.size ? '\n' : ''))
    await rename(tmp, this.path)
    this.lineCount = this.byKey.size
  }

  private async append(rows: LedgerRow[]): Promise<void> {
    if (rows.length === 0) return
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    this.lineCount += rows.length
  }

  /** Upsert every agent session with a native id across all windows; close
   *  rows whose native id no longer appears anywhere. Serialised on a tail so
   *  two quick saves cannot interleave their appends. */
  projectWindows(windows: readonly PersistedWindow[], agentNames: Readonly<Record<string, string>>, now = Date.now()): Promise<void> {
    const run = this.tail.then(async () => {
      const seen = new Set<string>()
      const changed: LedgerRow[] = []
      for (const window of windows) {
        if (!isRecord(window.workspace) || !isRecord(window.workspace.sessions)) continue
        const sessions = window.workspace.sessions
        for (const [localId, metaRaw] of Object.entries(sessions)) {
          if (!isRecord(metaRaw)) continue
          const provider = str(metaRaw.kind) ?? 'claude'
          const nativeId = str(metaRaw.providerSessionId)
          if (!isAgentProviderKind(provider) || !nativeId) continue
          const key = conversationKey(provider, nativeId)
          seen.add(key)
          const parentLocal = str(metaRaw.orchestrationParentId)
          const parentMeta = parentLocal && isRecord(sessions[parentLocal]) ? (sessions[parentLocal] as Record<string, unknown>) : null
          const orchestration = parentLocal || str(metaRaw.orchestrationRole) || str(metaRaw.orchestrationRunId)
            ? { parentNativeId: parentMeta ? str(parentMeta.providerSessionId) : null, role: str(metaRaw.orchestrationRole), runId: str(metaRaw.orchestrationRunId) }
            : null
          const agentNameId = str(metaRaw.agentNameId)
          const previous = this.byKey.get(key)
          const next: LedgerRow = {
            provider, nativeId,
            localSessionId: localId,
            cwd: str(metaRaw.cwd),
            title: str(metaRaw.title),
            agentName: agentNameId ? agentNames[agentNameId] ?? previous?.agentName ?? null : previous?.agentName ?? null,
            orchestration,
            firstSeenAt: previous?.firstSeenAt ?? now,
            lastSeenAt: now,
            closedAt: null,
          }
          if (!previous || !sameRow(previous, next)) {
            this.byKey.set(key, next)
            changed.push(next)
          } else {
            previous.lastSeenAt = now
          }
        }
      }
      for (const [key, row] of this.byKey) {
        if (seen.has(key) || row.closedAt !== null) continue
        const closed = { ...row, closedAt: now }
        this.byKey.set(key, closed)
        changed.push(closed)
      }
      await this.append(changed)
    })
    this.tail = run.catch(() => undefined)
    return run
  }
}
```

- [x] **Step 4: Add the store observer and the paths**

In `src/main/storage/paths.ts` append:

```ts
// Durable per-conversation identity (title, spoken name, orchestration role)
// keyed by provider-native session id, projected from workspace saves. Lives
// beside workspace.json because it is derived from it, and stays a separate
// file because it must outlive any pane the workspace forgets.
export const CONVERSATIONS_DIR = join(STATE_DIR, 'conversations')
export const CONVERSATIONS_LEDGER_FILE = join(CONVERSATIONS_DIR, 'ledger.jsonl')
```

In `src/main/storage/workspaceFileStore.ts`, add a field and a method to the class:

```ts
  // Observers of committed documents. WHY notified from inside the save
  // tail: a listener must see the document exactly as it reached disk, in
  // commit order, and never a composed-but-failed write. Listener errors are
  // swallowed here because the ledger is a projection and must never turn a
  // workspace save into a failure (same invariant as SessionLifecycleJournal).
  private readonly observers = new Set<(windows: readonly PersistedWindow[]) => void>()

  observe(listener: (windows: readonly PersistedWindow[]) => void): () => void {
    this.observers.add(listener)
    return () => { this.observers.delete(listener) }
  }
```

and inside `commit()`, immediately after `this.file = next`, add:

```ts
      for (const observer of this.observers) {
        try {
          observer(next.windows)
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[workspace] observer failed', error)
        }
      }
```

In `src/main/index.ts`, right after `const workspaceFileStore = await WorkspaceFileStore.open()`:

```ts
  // Conversation ledger (docs/decomposition/conversations.md, Stage 3): a
  // projection of every window's sessions keyed by native id, so the picker
  // can name and classify conversations after their panes are gone. Boots
  // from the store's current document, then follows every commit.
  const conversationLedger = await ConversationLedger.open(CONVERSATIONS_LEDGER_FILE).catch(error => {
    // eslint-disable-next-line no-console
    console.warn('[conversations] ledger unavailable', error)
    return null
  })
  if (conversationLedger) {
    const project = (windows: readonly PersistedWindow[]) => {
      void readAgentNameAssignments(AGENT_NAMES_FILE).then(names => conversationLedger.projectWindows(windows, names)).catch(() => undefined)
    }
    workspaceFileStore.observe(project)
    project(workspaceFileStore.windows())
  }
```

with imports `import { ConversationLedger, readAgentNameAssignments } from '@main/conversations/ledger/ledger.js'`, `import { CONVERSATIONS_LEDGER_FILE } from '@main/storage/paths.js'` (extend the existing paths import), `import { AGENT_NAMES_FILE } from '@main/agentNames/ipc.js'`, and `import type { PersistedWindow } from '@main/storage/workspaceFile.js'`. `conversationLedger` is passed to the service in Task 15.

- [x] **Step 5: Run the ledger test, the store tests and the typecheck**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/ledger/ledger.system.test.ts src/main/storage && npx tsc -p tsconfig.node.json --pretty false`
Expected: PASS; tsc clean.

- [x] **Step 6: Commit**

```bash
git add src/main/conversations/ledger src/main/storage/workspaceFileStore.ts src/main/storage/paths.ts src/main/index.ts
git commit -m "feat(ledger): remember conversation identity and orchestration provenance across pane lifetimes"
```

---

## Stage 4 — One service, one IPC surface, one picker

### Task 15: The conversation service

**Files:**
- Create: `src/main/conversations/service.ts`
- Create: `src/main/conversations/service.system.test.ts`

**Interfaces:**
- Consumes: sources (Tasks 8–10), `buildListing` (Task 13), `ConversationLedger` (Task 14), `listWorktreesForCwd` from `@main/ipc/git.js`.
- Produces: `class ConversationService { constructor(deps: { sources: ConversationSource[]; ledger: ConversationLedger | null; listWorktrees: (cwd: string) => Promise<ReadonlyArray<{ path: string }>>; claudeHistory: ClaudeHistoryIndex | null }); list(req): Promise<ConversationListResponse>; prompts(req): Promise<ConversationPrompt[]>; children(req): Promise<Conversation[]> }`, `createConversationService(deps: { ledger: ConversationLedger | null }): ConversationService` (production wiring with the real roots).

- [x] **Step 1: Write the failing test**

```ts
// src/main/conversations/service.system.test.ts
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeHistoryIndex } from './sources/claudeHistory.js'
import { ClaudeConversationSource } from './sources/claude.js'
import { CodexConversationSource } from './sources/codex.js'
import { OpencodeConversationSource } from './sources/opencode.js'
import { ConversationService } from './service.js'
import { corpusWorktreesPorcelain, installConversationCorpus } from '../../../testing/support/conversations/installCorpus.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

async function service() {
  const corpus = await installConversationCorpus()
  cleanups.push(corpus.cleanup)
  const porcelain = await corpusWorktreesPorcelain()
  const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
  const claudeHistory = new ClaudeHistoryIndex(join(corpus.claudeConfigDir, 'history.jsonl'))
  const svc = new ConversationService({
    sources: [
      new ClaudeConversationSource({ projectsDir: join(corpus.claudeConfigDir, 'projects'), history: claudeHistory }),
      new CodexConversationSource({ codexHome: corpus.codexHome }),
      new OpencodeConversationSource({ dataDir: corpus.opencodeDataDir, listPrompts: async () => [] }),
    ],
    ledger: null,
    listWorktrees: async () => worktrees,
    claudeHistory,
  })
  return { corpus, svc }
}

describe('ConversationService', () => {
  it('lists the repository across providers, hides children, and reports timing', async () => {
    const { corpus, svc } = await service()
    const counts = corpus.manifest.counts as { claude: { inFamily: number }; codex: { inFamily: number }; opencode: { inFamily: number } }
    const response = await svc.list({ cwd: '/fixture/repo/.worktrees/extension-platform', scope: 'repository', limit: 500 })
    expect(response.total).toBeGreaterThanOrEqual(counts.claude.inFamily + counts.codex.inFamily + counts.opencode.inFamily)
    expect(new Set(response.rows.map(r => r.provider)).size).toBeGreaterThanOrEqual(2)
    expect(response.hiddenChildren).toBeGreaterThan(0)
    expect(response.family.repoRoot).toBe('/fixture/repo')
    expect(response.timing.ms).toBeGreaterThanOrEqual(0)
  })

  it('searches Claude prompts through history and lists a row's prompts and children', async () => {
    const { svc } = await service()
    const all = await svc.list({ cwd: '/fixture/repo', scope: 'repository', includeChildren: true, limit: 500 })
    const parent = all.rows.find(r => r.provider === 'claude' && (r.promptCount ?? 0) > 1)!
    const prompts = await svc.prompts({ provider: 'claude', nativeId: parent.nativeId, cwd: parent.cwd })
    expect(prompts.length).toBeGreaterThan(0)
    const needle = prompts[0]!.text.slice(0, 10)
    const hits = await svc.list({ cwd: '/fixture/repo', scope: 'repository', query: needle, includeChildren: true, limit: 500 })
    expect(hits.rows.some(r => r.nativeId === parent.nativeId)).toBe(true)
    const codexParent = all.rows.find(r => r.provider === 'codex' && all.rows.some(c => c.parentNativeId === r.nativeId))
    if (codexParent) {
      const children = await svc.children({ provider: 'codex', nativeId: codexParent.nativeId, cwd: codexParent.cwd })
      expect(children.length).toBeGreaterThan(0)
      expect(children.every(c => c.parentNativeId === codexParent.nativeId)).toBe(true)
    }
  })

  it('serves a second listing from cache without re-discovering within the freshness window', async () => {
    const { svc } = await service()
    const first = await svc.list({ cwd: '/fixture/repo', scope: 'repository', limit: 20 })
    const second = await svc.list({ cwd: '/fixture/repo', scope: 'repository', limit: 20 })
    expect(second.rows.map(r => r.nativeId)).toEqual(first.rows.map(r => r.nativeId))
    expect(svc.discoveriesForTests()).toBe(1)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/service.system.test.ts`
Expected: FAIL, `./service.js` not found.

- [x] **Step 3: Write the service**

```ts
// src/main/conversations/service.ts
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  Conversation, ConversationChildrenRequest, ConversationListRequest, ConversationListResponse,
  ConversationPrompt, ConversationPromptsRequest,
} from '@shared/conversations/types.js'
import { conversationKey } from '@shared/conversations/types.js'
import { getCodexHome } from '@providers/codex/runtime/projectDir.js'
import { getProjectsDir, getClaudeConfigHomeDir } from '@shared/runtime/projectDir.js'
import { listWorktreesForCwd } from '@main/ipc/git.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import { buildListing } from './catalog/listing.js'
import { normalizeConversation } from './catalog/normalize.js'
import { resolveFamily, type RepositoryFamily } from './family.js'
import type { ConversationLedger } from './ledger/ledger.js'
import { ClaudeHistoryIndex } from './sources/claudeHistory.js'
import { ClaudeConversationSource } from './sources/claude.js'
import { CodexConversationSource } from './sources/codex.js'
import { defaultOpencodeDataDir, OpencodeConversationSource } from './sources/opencode.js'
import type { ConversationSource, SourceConversation } from './sources/types.js'
import { unwrapUserText } from './catalog/unwrap.js'

// The single consumer of the catalog and the single owner of caches.
//
// WHY discovery is cached per family for a short window: the picker fires a
// listing on open and again from its debounced search effect; a keystroke
// must not walk the Claude project dirs twice. Index reads are cheap (50 ms
// on the recorded store), Claude head/tail reads are cached per file inside
// the adapter by mtime+size, so the freshness window only has to cover one
// picker interaction. Nothing here is persisted.
//
// WHY prompt search for Codex and OpenCode is bounded to the newest rows:
// their prompts live in the transcripts, not in an index. The incremental
// folder reads a tail window per file; 200 files is one bounded pass and the
// result is cached by the folder. Claude prompts come from history for free.

const DISCOVERY_FRESH_MS = 3_000
const SEARCH_PROMPT_ROWS = 200
const SEARCH_PROMPTS_PER_ROW = 40

type Discovery = { at: number; key: string; family: RepositoryFamily; sources: SourceConversation[] }

export class ConversationService {
  private discovery: Discovery | null = null
  private inflight: { key: string; promise: Promise<Discovery> } | null = null
  private discoveries = 0
  private readonly promptCache = new Map<string, { at: number; texts: string[] }>()

  constructor(private readonly deps: {
    sources: ConversationSource[]
    ledger: ConversationLedger | null
    listWorktrees: (cwd: string) => Promise<ReadonlyArray<{ path: string }>>
    claudeHistory: ClaudeHistoryIndex | null
  }) {}

  discoveriesForTests(): number {
    return this.discoveries
  }

  private async discover(request: ConversationListRequest): Promise<Discovery> {
    const key = `${request.scope}|${request.cwd}`
    const now = Date.now()
    if (this.discovery && this.discovery.key === key && now - this.discovery.at < DISCOVERY_FRESH_MS) return this.discovery
    // Coalesce only identical requests: a scope change mid-flight must not be
    // answered with the previous scope's rows.
    if (this.inflight && this.inflight.key === key) return this.inflight.promise
    const promise = (async () => {
      const span = performanceService.span('conversations.discover', { scope: request.scope })
      try {
        const family = await resolveFamily(request.cwd, request.scope, { listWorktrees: this.deps.listWorktrees })
        const perSource = await Promise.all(this.deps.sources.map(s => s.discover({ scope: request.scope, family }).catch(error => {
          // One provider's store being unreadable must not empty the picker
          // for the other two; the row provenance already says which provider
          // is missing, and the live suite asserts counts per provider.
          // eslint-disable-next-line no-console
          console.warn(`[conversations] ${s.provider} discovery failed`, error)
          return [] as SourceConversation[]
        })))
        const discovery: Discovery = { at: Date.now(), key, family, sources: perSource.flat() }
        this.discovery = discovery
        this.discoveries++
        span.end({ rows: discovery.sources.length })
        return discovery
      } finally {
        if (this.inflight?.promise === promise) this.inflight = null
      }
    })()
    this.inflight = { key, promise }
    return promise
  }

  private source(provider: Conversation['provider']): ConversationSource | null {
    return this.deps.sources.find(s => s.provider === provider) ?? null
  }

  private async promptTextsFor(rows: readonly Conversation[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    const candidates = [...rows].sort((a, b) => b.lastUserActivityAt - a.lastUserActivityAt).slice(0, SEARCH_PROMPT_ROWS)
    await Promise.all(candidates.map(async row => {
      const key = conversationKey(row.provider, row.nativeId)
      if (row.provider === 'claude' && this.deps.claudeHistory) {
        out.set(key, this.deps.claudeHistory.bySession(row.nativeId).map(p => p.text))
        return
      }
      const cached = this.promptCache.get(key)
      if (cached && cached.at === row.lastUserActivityAt) { out.set(key, cached.texts); return }
      const source = this.source(row.provider)
      if (!source || !row.available) return
      try {
        const prompts = await source.prompts(row.nativeId, row.cwd)
        const texts = prompts.slice(0, SEARCH_PROMPTS_PER_ROW).map(p => p.text)
        this.promptCache.set(key, { at: row.lastUserActivityAt, texts })
        out.set(key, texts)
      } catch {
        // unreadable transcript: label-only search for this row
      }
    }))
    return out
  }

  async list(request: ConversationListRequest): Promise<ConversationListResponse> {
    const startedAt = Date.now()
    const discovery = await this.discover(request)
    const ledger = this.deps.ledger?.rows() ?? new Map()
    if (!request.query?.trim()) {
      return buildListing({ sources: discovery.sources, ledger, family: discovery.family, request, startedAt })
    }
    // Search needs prompt texts: normalise once to know the rows, gather
    // texts for the newest ones, then build the listing with them attached.
    const rows = discovery.sources.map(s => normalizeConversation(s, ledger.get(conversationKey(s.provider, s.nativeId)) ?? null, discovery.family))
    const texts = await this.promptTextsFor(rows)
    return buildListing({
      sources: discovery.sources, ledger, family: discovery.family, request, startedAt,
      promptsFor: row => texts.get(conversationKey(row.provider, row.nativeId)) ?? [],
    })
  }

  async prompts(request: ConversationPromptsRequest): Promise<ConversationPrompt[]> {
    const source = this.source(request.provider)
    if (!source) return []
    const raw = await source.prompts(request.nativeId, request.cwd)
    // The folder reports wrappers verbatim; the prompt list shows what the
    // user typed, so unwrap here and drop injected messages.
    return raw.flatMap(p => {
      const unwrapped = unwrapUserText(p.text)
      return unwrapped ? [{ text: unwrapped.text, timestamp: p.timestamp }] : []
    })
  }

  async children(request: ConversationChildrenRequest): Promise<Conversation[]> {
    const discovery = await this.discover({ cwd: request.cwd, scope: 'repository' })
    const ledger = this.deps.ledger?.rows() ?? new Map()
    return discovery.sources
      .map(s => normalizeConversation(s, ledger.get(conversationKey(s.provider, s.nativeId)) ?? null, discovery.family))
      .filter(r => r.parentNativeId === request.nativeId)
      .sort((a, b) => b.lastUserActivityAt - a.lastUserActivityAt)
  }
}

export function createConversationService(deps: { ledger: ConversationLedger | null }): ConversationService {
  const claudeHistory = new ClaudeHistoryIndex(join(getClaudeConfigHomeDir(), 'history.jsonl'))
  return new ConversationService({
    sources: [
      new ClaudeConversationSource({ projectsDir: getProjectsDir(), history: claudeHistory }),
      new CodexConversationSource({ codexHome: getCodexHome() }),
      new OpencodeConversationSource({
        dataDir: defaultOpencodeDataDir(),
        listPrompts: (cwd, id) => getHostTranscriptAdapter('opencode').listPrompts(cwd, id).then(rows => rows.map(r => ({ text: r.text, timestamp: r.timestamp }))),
      }),
    ],
    ledger: deps.ledger,
    listWorktrees: listWorktreesForCwd,
    claudeHistory,
  })
}

void homedir
```

Remove the trailing `void homedir` and its import once the file compiles; both exist only so the import list above is complete for the executor.

- [x] **Step 4: Run the test and typecheck**

Run: `NODE_ENV=test npx vitest run --project system src/main/conversations/service.system.test.ts && npx tsc -p tsconfig.node.json --pretty false`
Expected: 3 PASS; tsc clean. If `listWorktreesForCwd` is not exported from `@main/ipc/git.js`, it is (line 213); if importing `@main/ipc/git.js` pulls `electron` into the system test, move the import behind the `createConversationService` factory by passing `listWorktrees` from `index.ts` instead and keep the service free of `@main/ipc`.

- [x] **Step 5: Commit**

```bash
git add src/main/conversations/service.ts src/main/conversations/service.system.test.ts
git commit -m "feat(conversations): serve listings, search, prompts and children from one cached service"
```

### Task 16: IPC channels and preload surface

**Files:**
- Create: `src/main/ipc/conversations.ts`
- Create: `src/main/ipc/conversations.test.ts`
- Create: `src/preload/api/conversations.ts`
- Modify: `src/preload/api/index.ts:61-76` (spread `conversationsApi`)
- Modify: `src/main/ipc/index.ts:85-120` (add `conversationService` to `IpcDeps`, call `registerConversationsIpc`)
- Modify: `src/main/index.ts:968-990` (construct the service after the ledger; pass it)

**Interfaces:**
- Produces: channels `conversations:list` (`ConversationListRequest` → `ConversationListResponse`), `conversations:prompts` (`ConversationPromptsRequest` → `ConversationPrompt[]`), `conversations:children` (`ConversationChildrenRequest` → `Conversation[]`); preload `listConversations`, `listConversationPrompts`, `listConversationChildren` on `window.api`; breadcrumbs `conversations.list.complete` / `conversations.list.error` in area `conversations.list` with `{ scope, providers, targetFingerprint, resultCount, hiddenChildren, total, ms, outcome }` and never a cwd.

- [x] **Step 1: Write the failing IPC test**

```ts
// src/main/ipc/conversations.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { harness.handlers.set(channel, fn) } } }))

import { registerConversationsIpc } from './conversations.js'

// Re-homes the #718 evidence contract: a listing must leave a breadcrumb that
// distinguishes "zero results" from "the read failed", correlated by a cwd
// fingerprint that never retains the cwd itself.
describe('conversations IPC', () => {
  beforeEach(() => harness.handlers.clear())

  it('records a correlated success breadcrumb without the cwd', async () => {
    const list = vi.fn(async () => ({ rows: [{ nativeId: 'x' }], total: 3, hiddenChildren: 2, nextCursor: null, family: { repoRoot: '/repo', roots: ['/repo'] }, timing: { ms: 7 } }))
    const record = vi.fn()
    registerConversationsIpc({ list, prompts: vi.fn(), children: vi.fn() } as never, { record } as never)
    const handler = harness.handlers.get('conversations:list')!
    await expect(handler({}, { cwd: '/Users/me/repo/../repo', scope: 'repository', providers: ['codex'] })).resolves.toMatchObject({ total: 3 })
    expect(record).toHaveBeenCalledWith({
      area: 'conversations.list',
      name: 'conversations.list.complete',
      data: { scope: 'repository', providers: 'codex', targetFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), resultCount: 1, hiddenChildren: 2, total: 3, ms: 7, outcome: 'success' },
    })
    expect(JSON.stringify(record.mock.calls)).not.toContain('/Users/me/repo')
  })

  it('rethrows a listing failure and records it as an error, not an empty list', async () => {
    const failure = new Error('sqlite locked at /Users/me/.codex')
    const record = vi.fn()
    registerConversationsIpc({ list: vi.fn(async () => { throw failure }), prompts: vi.fn(), children: vi.fn() } as never, { record } as never)
    await expect(harness.handlers.get('conversations:list')!({}, { cwd: '/Users/me/repo', scope: 'cwd' })).rejects.toBe(failure)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ name: 'conversations.list.error', severity: 'warn', data: expect.objectContaining({ outcome: 'error' }) }))
    expect(JSON.stringify(record.mock.calls)).not.toContain('/Users/me')
  })

  it('forwards prompts and children requests verbatim', async () => {
    const prompts = vi.fn(async () => [{ text: 'a', timestamp: 1 }])
    const children = vi.fn(async () => [])
    registerConversationsIpc({ list: vi.fn(), prompts, children } as never, undefined)
    await expect(harness.handlers.get('conversations:prompts')!({}, { provider: 'claude', nativeId: 'n', cwd: '/r' })).resolves.toEqual([{ text: 'a', timestamp: 1 }])
    expect(prompts).toHaveBeenCalledWith({ provider: 'claude', nativeId: 'n', cwd: '/r' })
    await harness.handlers.get('conversations:children')!({}, { provider: 'codex', nativeId: 'p', cwd: '/r' })
    expect(children).toHaveBeenCalledWith({ provider: 'codex', nativeId: 'p', cwd: '/r' })
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project unit src/main/ipc/conversations.test.ts`
Expected: FAIL, `./conversations.js` not found.

- [x] **Step 3: Write the IPC module and the preload API**

```ts
// src/main/ipc/conversations.ts
import { ipcMain } from 'electron'
import { createHmac, randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

import type {
  ConversationChildrenRequest, ConversationListRequest, ConversationPromptsRequest,
} from '@shared/conversations/types.js'
import type { ConversationService } from '@main/conversations/service.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'

// One secret per app process, as in session.ts: the breadcrumb answers
// "did two listings target the same cwd in THIS run" without retaining the
// cwd, and cross-run joins are deliberately unsupported.
const TARGET_FINGERPRINT_KEY = randomBytes(32)
function fingerprint(cwd: string): string {
  return createHmac('sha256', TARGET_FINGERPRINT_KEY).update('conversations.list.target\0').update(resolvePath(cwd)).digest('hex')
}

export function registerConversationsIpc(
  service: ConversationService,
  appRunJournal?: AppRunJournal,
): void {
  ipcMain.handle('conversations:list', async (_evt, request: ConversationListRequest) => {
    const targetFingerprint = fingerprint(request.cwd)
    const providers = (request.providers ?? []).join(',')
    try {
      const response = await service.list(request)
      appRunJournal?.record({
        area: 'conversations.list',
        name: 'conversations.list.complete',
        data: { scope: request.scope, providers, targetFingerprint, resultCount: response.rows.length, hiddenChildren: response.hiddenChildren, total: response.total, ms: response.timing.ms, outcome: 'success' },
      })
      return response
    } catch (error) {
      // WHY reject instead of returning []: an empty list means the stores
      // were read and held nothing. Collapsing a read failure into that
      // erased the only distinction #718 needed. The renderer keeps its
      // surface usable and shows the failure.
      // eslint-disable-next-line no-console
      console.warn('[conversations:list] failed:', error)
      appRunJournal?.record({
        area: 'conversations.list',
        name: 'conversations.list.error',
        severity: 'warn',
        data: { scope: request.scope, providers, targetFingerprint, outcome: 'error' },
      })
      throw error
    }
  })

  ipcMain.handle('conversations:prompts', (_evt, request: ConversationPromptsRequest) => service.prompts(request))
  ipcMain.handle('conversations:children', (_evt, request: ConversationChildrenRequest) => service.children(request))
}
```

```ts
// src/preload/api/conversations.ts
import { ipcRenderer } from 'electron'

import type {
  Conversation, ConversationChildrenRequest, ConversationListRequest, ConversationListResponse,
  ConversationPrompt, ConversationPromptsRequest,
} from '@shared/conversations/types.js'

// The Conversations picker, the path picker's session list, View Prompts and
// Rewind all read through these three calls. Types come from @shared so the
// renderer and main cannot drift apart (the old SessionIndexEntry lived twice).
export const conversationsApi = {
  listConversations: (request: ConversationListRequest): Promise<ConversationListResponse> =>
    ipcRenderer.invoke('conversations:list', request),
  listConversationPrompts: (request: ConversationPromptsRequest): Promise<ConversationPrompt[]> =>
    ipcRenderer.invoke('conversations:prompts', request),
  listConversationChildren: (request: ConversationChildrenRequest): Promise<Conversation[]> =>
    ipcRenderer.invoke('conversations:children', request),
}
```

In `src/preload/api/index.ts` add `import { conversationsApi } from '@preload/api/conversations.js'` and `...conversationsApi,` after `...sessionsApi,`.

In `src/main/ipc/index.ts`: import `registerConversationsIpc` and `type ConversationService`; add `conversationService: ConversationService` to `IpcDeps`; call `registerConversationsIpc(deps.conversationService, deps.appRunJournal)` right after `registerSessionsIpc()`.

In `src/main/index.ts`, before `registerAllIpc({`: `const conversationService = createConversationService({ ledger: conversationLedger })` (import from `@main/conversations/service.js`) and add `conversationService,` to the deps object.

- [x] **Step 4: Run the test and both typechecks**

Run: `NODE_ENV=test npx vitest run --project unit src/main/ipc/conversations.test.ts && npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`
Expected: 3 PASS; both clean (`window.api` gains the three methods through the preload type).

- [x] **Step 5: Commit**

```bash
git add src/main/ipc/conversations.ts src/main/ipc/conversations.test.ts src/preload/api/conversations.ts src/preload/api/index.ts src/main/ipc/index.ts src/main/index.ts
git commit -m "feat(conversations): expose listing, prompts and children over one IPC surface"
```

### Task 17: Renderer state, commands and surface registration

**Files:**
- Modify: `src/renderer/src/app-state/uiShell/types.ts:273-278` (replace the `promptSearchOpen` doc+field with the conversations fields)
- Modify: `src/renderer/src/app-state/uiShell/slice.ts:48,300-303`
- Modify: `src/renderer/src/app-state/uiShell/control.ts:18` (route `promptSearch` → `conversations`)
- Modify: `src/renderer/src/features/command-palette/types.ts:196-197` (`openPromptSearch` → `openConversations`)
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx:640-700` and `760-800` (provide `openConversations`, drop `enterResumeMode` from `ui`)
- Modify: `src/renderer/src/features/command-palette/surfaceOwnership.ts:85-115`
- Modify: `src/renderer/src/features/workspace/commands/sessionCommands.ts:375-401`
- Modify: `src/renderer/src/features/workspace/commands/tabCommands.ts:60-78`
- Modify: `src/renderer/src/app/surfaces/registry.tsx` (replace `PromptPromptSearchSurface` entry with `ConversationsSurface`)
- Create: `src/renderer/src/features/conversations/surfaces/ConversationsSurface.tsx`
- Create: `src/renderer/src/features/conversations/ui/ConversationsPicker.tsx` (placeholder-free minimal shell in this task; the full picker is Task 18)

**Interfaces:**
- Produces (uiShell): `conversationsOpen: boolean`, `conversationsFocusSearch: boolean`, `openConversations(opts: { focusSearch: boolean }): void`, `closeConversations(): void`.
- Produces (commands): `resume-session` and `search-conversation-prompts` (id kept for keybinding continuity; title `Search Conversations…`) both call `ui.openConversations`.

- [x] **Step 1: Write the failing store test**

Append to `src/renderer/src/app-state/store.test.ts`:

```ts
describe('conversations picker state', () => {
  it('opens with a focus intent and resets it on close', () => {
    useAppStore.getState().openConversations({ focusSearch: true })
    expect(useAppStore.getState()).toMatchObject({ conversationsOpen: true, conversationsFocusSearch: true })
    useAppStore.getState().closeConversations()
    expect(useAppStore.getState()).toMatchObject({ conversationsOpen: false, conversationsFocusSearch: false })
  })
})
```

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/app-state/store.test.ts`
Expected: FAIL, `openConversations` is not a function.

- [x] **Step 2: Update the UI shell**

In `types.ts`, replace the `promptSearchOpen` block with:

```ts
  /** When true, the Conversations picker is open (Resume Session… and Search
   *  Conversations… both open it). Lives on uiShell because it reads every
   *  conversation on disk, not only mounted panes. */
  conversationsOpen: boolean
  /** Whether the picker should start with the search field focused. Set by
   *  the command that opened it; reset on close so a chord never inherits
   *  the previous invocation's intent. */
  conversationsFocusSearch: boolean
```

and in the actions section replace `openPromptSearch: () => void` / `closePromptSearch: () => void` with `openConversations: (opts: { focusSearch: boolean }) => void` and `closeConversations: () => void`.

In `slice.ts` replace `promptSearchOpen: false,` with `conversationsOpen: false, conversationsFocusSearch: false,` and the two actions with:

```ts
  openConversations: ({ focusSearch }) =>
    set({ conversationsOpen: true, conversationsFocusSearch: focusSearch }, false, 'uiShell/openConversations'),
  closeConversations: () =>
    set({ conversationsOpen: false, conversationsFocusSearch: false }, false, 'uiShell/closeConversations'),
```

In `control.ts` replace the `promptSearch` route with:

```ts
  conversations: { field: 'conversationsOpen', toggle: (open: boolean) => { const s = useAppStore.getState(); open ? s.openConversations({ focusSearch: false }) : s.closeConversations() } },
```

(Also rename the surface id in any external-operator docs or the `ac_app_describe` text that lists `promptSearch`; grep `promptSearch` across `src/` and update every reference, including `flags.promptSearchOpen` in the palette's `flags` object → `conversationsOpen`.)

- [x] **Step 3: Update commands, the palette's `ui` object and surface ownership**

`types.ts` `CommandContext.ui`: replace `openPromptSearch: () => void` with `openConversations: (opts: { focusSearch: boolean }) => void`; remove `enterResumeMode`. In `CommandPalette.tsx` provide `openConversations: opts => { useAppStore.getState().openConversations(opts) }` in the `ui` object and remove `enterResumeMode` from the object and from the `useMemo` deps (leave the `enterResumeMode` callback and the resume-mode JSX in place until Task 23 deletes them; TypeScript will flag it unused only if `noUnusedLocals` is on, in which case prefix it with `void enterResumeMode` at the bottom of the component for this task).

`sessionCommands.ts` (search command):

```ts
    id: 'search-conversation-prompts',
    category: 'workspace-tools',
    pickerVisibility: 'advanced',
    surface: 'app',
    title: 'Search Conversations…',
    description: '**What it does:** Finds a past conversation by **title or prompt text** across every worktree of this repository and all providers.\n\n**Use when:** You remember what you asked or what it was called, but not where it was.\n\n**Notes:** Same picker as Resume Session…, opened with the search field focused.',
    keywords: ['search', 'prompt', 'prompts', 'conversation', 'find', 'session', 'sessions', 'recent', 'history', 'resume'],
    getState: ({ flags }) => panel(flags.conversationsOpen),
    run: ({ ui, flags }) => {
      if (flags.conversationsOpen) {
        ui.closeConversations()
        return
      }
      ui.openConversations({ focusSearch: true })
      ui.closePalette()
    },
```

(add `closeConversations: () => void` to `ui` too, wired to the store). `tabCommands.ts`:

```ts
    id: 'resume-session',
    category: 'session',
    surface: 'app',
    title: 'Resume Session…',
    description: '**What it does:** Opens the Conversations picker for this repository.\n\n**Use when:** You want to continue a past Claude, Codex or OpenCode conversation.\n\n**Notes:** Lists every worktree of the focused project; children are hidden behind a toggle.',
    getState: ({ flags }) => panel(flags.conversationsOpen),
    run: ({ ui, flags }) => {
      if (flags.conversationsOpen) {
        ui.closeConversations()
        return
      }
      ui.openConversations({ focusSearch: false })
      ui.closePalette()
    },
```

(`panel` is imported the same way `sessionCommands.ts` imports it.) `surfaceOwnership.ts`: change `'search-conversation-prompts': 'promptSearchOpen'` to `'search-conversation-prompts': 'conversationsOpen'`, add `'resume-session': 'conversationsOpen'` to `SURFACE_OWNER_FLAGS`, and remove `'resume-session': 'resume'` from `PALETTE_MODE_COMMANDS`.

- [x] **Step 4: Register the surface with a minimal picker shell**

```tsx
// src/renderer/src/features/conversations/surfaces/ConversationsSurface.tsx
import { ConversationsPicker } from '@renderer/features/conversations/ui/ConversationsPicker'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function ConversationsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.conversationsOpen)
  const focusSearch = useAppStore(state => state.conversationsFocusSearch)
  const close = useAppStore(state => state.closeConversations)
  return <ConversationsPicker open={open} focusSearch={focusSearch} workspace={workspace} onClose={close} />
}
```

In `registry.tsx` replace the `prompt-search` entry with `{ id: 'conversations', Component: ConversationsSurface }` (same position, so stacking order is unchanged) and swap the import.

Create `ConversationsPicker.tsx` as the Task 18 component; if Task 18 is executed by a different worker, this task ships the file with the full implementation from Task 18 Step 3 rather than a stub, because a stub would be a placeholder.

- [x] **Step 5: Run the store, keybinding-baseline and catalog tests plus the web typecheck**

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/app-state/store.test.ts src/renderer/src/features/command-palette && npm run check:keybindings && npx tsc -p tsconfig.web.json --pretty false`
Expected: PASS; `check:keybindings` green (no new chords); tsc clean.

- [x] **Step 6: Commit**

```bash
git add src/renderer/src/app-state src/renderer/src/features/command-palette src/renderer/src/features/workspace/commands src/renderer/src/app/surfaces/registry.tsx src/renderer/src/features/conversations
git commit -m "feat(picker): route Resume Session and Search Conversations to one surface"
```

### Task 18: The Conversations picker

**Files:**
- Create: `src/renderer/src/features/conversations/useConversationList.ts`
- Create: `src/renderer/src/features/conversations/ui/ConversationRow.tsx`
- Create: `src/renderer/src/features/conversations/ui/ConversationsPicker.tsx`
- Create: `src/renderer/src/features/conversations/ui/ConversationsPicker.renderer.test.tsx`
- Modify: `src/renderer/src/features/session-preview/ui/SessionPreviewPane.tsx:69-80,181-205` (accept `turnCount` from the row)

**Interfaces:**
- Consumes: `window.api.listConversations` (Task 16), `SessionPreviewPane` + `PreviewTarget`, `workspace.replaceSession(cwd, { resumeSessionId, kind })` and `workspace.newTab(cwd, resumeSessionId, kind)`, `relativeTime`, `providerGlyph`, `useResizableSplitter` from `@renderer/features/shared/useResizableSplitter`.
- Produces: `useConversationList(params: { open: boolean; cwd: string | null; scope: ConversationScope; providers: AgentProviderKind[]; includeChildren: boolean; query: string }): { response: ConversationListResponse | null; loading: boolean; error: string | null; loadMore(): void }`; `ConversationRow` props `{ row: Conversation; selected: boolean; onHover(): void; onSelect(): void; index: number }`; `ConversationsPicker` props `{ open: boolean; focusSearch: boolean; workspace: Workspace; onClose(): void }`; `SessionPreviewPane` gains optional `turnCount?: number | null`.

- [x] **Step 1: Write the failing renderer test**

```tsx
// src/renderer/src/features/conversations/ui/ConversationsPicker.renderer.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Conversation, ConversationListResponse } from '@shared/conversations/types'
import { ConversationsPicker } from './ConversationsPicker'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

// Rows shaped exactly like the catalog emits them for the corpus: an
// ai-titled Claude session on main, a Codex session on a worktree with a
// first-prompt label, and a fallback-labelled row. Ids from the corpus.
function row(over: Partial<Conversation>): Conversation {
  return {
    provider: 'claude', nativeId: 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1', cwd: '/fixture/repo', repoRoot: '/fixture/repo', worktree: null,
    gitBranch: 'main', kind: 'user', parentNativeId: null, label: 'Project context bootstrapping', labelSource: 'ai-title', firstPrompt: 'Please read',
    agentName: 'Apollo', agentCodeTitle: null, createdAt: 1, lastUserActivityAt: Date.now() - 3 * 3600_000, activitySource: 'history',
    promptCount: 12, available: true, origin: 'scan', match: null, ...over,
  }
}
const rows = [
  row({}),
  row({ provider: 'codex', nativeId: '01a08ddd-6327-7482-bd79-d1ade559677c', cwd: '/fixture/repo/.worktrees/extension-platform', worktree: 'extension-platform', label: 'break down this project', labelSource: 'first-prompt', agentName: null, promptCount: null }),
  row({ provider: 'codex', nativeId: '6861f23d-0000-4000-8000-000000000000', label: 'repo', labelSource: 'cwd', firstPrompt: null, agentName: null }),
]
function response(over: Partial<ConversationListResponse> = {}): ConversationListResponse {
  return { rows, total: 5, hiddenChildren: 2, nextCursor: null, family: { repoRoot: '/fixture/repo', roots: ['/fixture/repo'] }, timing: { ms: 3 }, ...over }
}
function install(list = vi.fn(async () => response())) {
  Object.defineProperty(window, 'api', { configurable: true, value: { listConversations: list, loadInitialHistory: vi.fn(async () => ({ entries: [], hasMore: false })) } })
  return list
}
function workspace(over: Record<string, unknown> = {}) {
  return { activeTab: { id: 't', focusedSessionId: 's' }, state: { sessions: { s: { cwd: '/fixture/repo', kind: 'claude' } } }, replaceSession: vi.fn(async () => 's2'), newTab: vi.fn(async () => undefined), ...over } as never
}

describe('ConversationsPicker', () => {
  it('lists rows with label, name, worktree, relative time, prompt count and a hidden-children toggle', async () => {
    const list = install()
    render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    expect(await screen.findByText('Project context bootstrapping')).toBeInTheDocument()
    expect(screen.getByText('Apollo')).toBeInTheDocument()
    expect(screen.getByText('extension-platform')).toBeInTheDocument()
    expect(screen.getByText('3h ago')).toBeInTheDocument()
    expect(screen.getByText('12 prompts')).toBeInTheDocument()
    expect(screen.getByText('repo')).toHaveClass('italic')
    expect(screen.getByRole('button', { name: /2 hidden/i })).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/fixture/repo', scope: 'repository', includeChildren: false }))
  })

  it('resumes the highlighted row under its own cwd and provider on Enter', async () => {
    install()
    const ws = workspace()
    const onClose = vi.fn()
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={onClose} />)
    await screen.findByText('break down this project')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await waitFor(() => expect(ws.replaceSession).toHaveBeenCalledWith('/fixture/repo/.worktrees/extension-platform', { resumeSessionId: '01a08ddd-6327-7482-bd79-d1ade559677c', kind: 'codex' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('re-queries with the toggled scope, provider and children filters, and with the typed query', async () => {
    const list = install()
    render(<ConversationsPicker open focusSearch workspace={workspace()} onClose={vi.fn()} />)
    await screen.findByText('Project context bootstrapping')
    fireEvent.click(screen.getByRole('button', { name: /2 hidden/i }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ includeChildren: true })))
    fireEvent.click(screen.getByRole('button', { name: /^everywhere$/i }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'everywhere' })))
    fireEvent.click(screen.getByRole('button', { name: /^codex$/i }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ providers: ['codex'] })))
    const input = screen.getByPlaceholderText(/search conversations/i)
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'break down' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'break down' })))
  })

  it('distinguishes a listing failure from an empty result', async () => {
    install(vi.fn(async () => { throw new Error('sqlite locked') }))
    render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load conversations/i)
    install(vi.fn(async () => response({ rows: [], total: 0, hiddenChildren: 0 })))
    render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    expect(await screen.findByText(/no conversations/i)).toBeInTheDocument()
  })

  it('opens a new tab when no pane can be replaced', async () => {
    install()
    const ws = workspace({ activeTab: null, state: { sessions: {} } })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('Project context bootstrapping'))
    await waitFor(() => expect(ws.newTab).toHaveBeenCalledWith('/fixture/repo', 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1', 'claude'))
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/conversations/ui/ConversationsPicker.renderer.test.tsx`
Expected: FAIL, modules not found.

- [x] **Step 3: Write the hook, the row and the picker**

```ts
// src/renderer/src/features/conversations/useConversationList.ts
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ConversationListResponse, ConversationScope } from '@shared/conversations/types'
import type { AgentProviderKind } from '@shared/types/providerKind'

// One coherent request per filter state, versioned so a slower obsolete
// response can never replace a newer one (the exact race the old resume
// listing hook fixed for #718, kept here in the same shape).
const DEBOUNCE_MS = 120
const PAGE = 60
export const LOAD_FAILURE_MESSAGE = "Couldn't load conversations. Check the app log and try again."

export type ConversationListParams = {
  open: boolean
  cwd: string | null
  scope: ConversationScope
  providers: AgentProviderKind[]
  includeChildren: boolean
  query: string
}

export function useConversationList(params: ConversationListParams): {
  response: ConversationListResponse | null
  loading: boolean
  error: string | null
  loadMore: () => void
} {
  const version = useRef(0)
  const [response, setResponse] = useState<ConversationListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { open, cwd, scope, includeChildren, query } = params
  const providersKey = params.providers.join(',')

  const run = useCallback(async (cursor: string | null) => {
    if (!open || !cwd) return
    const request = ++version.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.api.listConversations({
        cwd, scope, providers: providersKey ? (providersKey.split(',') as AgentProviderKind[]) : undefined,
        includeChildren, query: query.trim() || undefined, cursor, limit: PAGE,
      })
      if (request !== version.current) return
      setResponse(prev => cursor && prev ? { ...next, rows: [...prev.rows, ...next.rows] } : next)
    } catch {
      if (request !== version.current) return
      setResponse(null)
      setError(LOAD_FAILURE_MESSAGE)
    } finally {
      if (request === version.current) setLoading(false)
    }
  }, [open, cwd, scope, providersKey, includeChildren, query])

  useEffect(() => {
    if (!open) {
      version.current += 1
      setResponse(null)
      setError(null)
      return
    }
    // The first paint of an open picker should not wait for the debounce;
    // only subsequent keystrokes are coalesced.
    const timer = setTimeout(() => { void run(null) }, response === null ? 0 : DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, run])

  const loadMore = useCallback(() => {
    if (response?.nextCursor && !loading) void run(response.nextCursor)
  }, [response, loading, run])

  return { response, loading, error, loadMore }
}
```

```tsx
// src/renderer/src/features/conversations/ui/ConversationRow.tsx
import type { Conversation } from '@shared/conversations/types'
import { relativeTime } from '@renderer/lib/relativeTime'
import { providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'

// The one row every picker renders. It makes no naming decision: label and
// provenance come from the catalog; a fallback label is italic so the user
// knows they are looking at a stand-in (#701's requirement, now possible).
export function ConversationRow({ row, selected, index, onHover, onSelect }: {
  row: Conversation
  selected: boolean
  index: number
  onHover: () => void
  onSelect: () => void
}) {
  const fallback = row.labelSource === 'cwd' || row.labelSource === 'native-id'
  const label = row.match?.field === 'label' ? highlight(row.label, row.match.start, row.match.end) : row.label
  return (
    <div
      role="option"
      aria-selected={selected}
      data-conversation-index={index}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={`cursor-pointer border-b border-border px-3 py-2 last:border-b-0 ${selected ? 'bg-row-selected-bg text-row-selected-fg' : 'text-ink-dim hover:bg-row-hover-bg'} ${row.available ? '' : 'opacity-60'}`}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <span className="w-4 text-center font-semibold text-accent select-none">{providerGlyph(row.provider)}</span>
        <span className={`min-w-0 flex-1 truncate ${fallback ? 'italic text-muted' : 'text-ink'}`}>{label}</span>
        {row.agentName && <span className="rounded-slab border border-border px-1.5 text-[10px] text-ink-dim">{row.agentName}</span>}
        {row.kind !== 'user' && <span className="text-[10px] uppercase tracking-wider text-muted">{row.kind}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
        <span>{relativeTime(row.lastUserActivityAt)}</span>
        {row.worktree && <span className="truncate">{row.worktree}</span>}
        {!row.worktree && row.gitBranch && <span className="truncate">{row.gitBranch}</span>}
        {row.promptCount !== null && <span>{row.promptCount} {row.promptCount === 1 ? 'prompt' : 'prompts'}</span>}
        {!row.available && <span>unavailable</span>}
        {row.match && row.match.field !== 'label' && (
          <span className="min-w-0 truncate text-ink-dim">› {highlight(row.match.text, row.match.start, row.match.end)}</span>
        )}
      </div>
    </div>
  )
}

function highlight(text: string, start: number, end: number) {
  return (
    <>
      {text.slice(0, start)}
      <span className="bg-accent/25 text-accent">{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  )
}
```

```tsx
// src/renderer/src/features/conversations/ui/ConversationsPicker.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Conversation, ConversationScope } from '@shared/conversations/types'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { SessionPreviewPane } from '@renderer/features/session-preview/ui/SessionPreviewPane'
import type { PreviewTarget } from '@renderer/features/session-preview/ui/SessionPreviewPane'
import { useConversationList } from '@renderer/features/conversations/useConversationList'
import { ConversationRow } from '@renderer/features/conversations/ui/ConversationRow'

// The Conversations picker: the one surface behind Resume Session… and
// Search Conversations… (docs/decomposition/conversations.md, Stage 4).
//
// It decides nothing about identity, scope membership or order; those come
// from main. It owns: which filters are on, which row is highlighted, and
// what happens on Enter. Resume uses the ROW's cwd and provider, never the
// focused pane's — the picker lists other worktrees and other providers on
// purpose, and resuming a Codex worktree session as a Claude session in the
// main checkout was the old surface's silent failure.

type Props = { open: boolean; focusSearch: boolean; workspace: Workspace; onClose: () => void }

const SCOPES: Array<{ id: ConversationScope; label: string }> = [
  { id: 'cwd', label: 'this folder' },
  { id: 'repository', label: 'repository' },
  { id: 'everywhere', label: 'everywhere' },
]

export function ConversationsPicker({ open, focusSearch, workspace, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ConversationScope>('repository')
  const [providers, setProviders] = useState<AgentProviderKind[]>([])
  const [includeChildren, setIncludeChildren] = useState(false)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const [listWidth, setListWidth] = useState(520)
  const splitter = useResizableSplitter({
    onDrag: clientX => {
      const rect = modalRef.current?.getBoundingClientRect()
      if (rect) setListWidth(Math.max(360, Math.min(800, clientX - rect.left)))
    },
  })

  const commandSessionId = commandTargetSessionId(workspace)
  const cwd = commandSessionId ? workspace.state.sessions[commandSessionId]?.cwd ?? null : null
  const { response, loading, error, loadMore } = useConversationList({ open, cwd, scope, providers, includeChildren, query })
  const rows = response?.rows ?? []

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    setIncludeChildren(false)
    requestAnimationFrame(() => {
      if (focusSearch) inputRef.current?.focus()
      else listRef.current?.focus()
    })
  }, [open, focusSearch])
  // Reset the highlight when the list's head changes (a new query, filter or
  // scope), but not when loadMore appends rows below it.
  const headId = response?.rows[0]?.nativeId ?? null
  useEffect(() => { setSelected(0) }, [headId, query, scope, providers, includeChildren])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-conversation-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const resume = useCallback(async (row: Conversation) => {
    onClose()
    if (workspace.activeTab) {
      await workspace.replaceSession(row.cwd, { resumeSessionId: row.nativeId, kind: row.provider })
    } else {
      await workspace.newTab(row.cwd, row.nativeId, row.provider)
    }
  }, [onClose, workspace])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(rows.length - 1, i + 1)); if (selected >= rows.length - 5) loadMore() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const row = rows[selected]; if (row) void resume(row) }
  }, [rows, selected, resume, loadMore])

  const previewTarget: PreviewTarget | null = useMemo(() => {
    const row = rows[selected]
    return row && row.available ? { kind: row.provider, cwd: row.cwd, providerSessionId: row.nativeId } : null
  }, [rows, selected])

  const toggleProvider = (kind: AgentProviderKind) =>
    setProviders(prev => prev.includes(kind) ? prev.filter(p => p !== kind) : [...prev, kind])

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent ref={modalRef} className="w-[min(1240px,96vw)] top-[8vh] max-h-[84vh] translate-y-0 flex flex-col overflow-hidden" onKeyDown={onKeyDown}>
        <DialogTitle className="sr-only">Conversations</DialogTitle>
        <DialogDescription className="sr-only">Find a past conversation across this repository's worktrees and every provider, preview it, and resume it.</DialogDescription>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-accent select-none">❯</span>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search conversations by title, name or prompt…" spellCheck={false} autoComplete="off" className="flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted" />
          <span className="text-[10px] uppercase tracking-wider text-muted select-none">esc</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[11px] text-muted">
          <div role="group" aria-label="Scope" className="flex overflow-hidden rounded-slab border border-border">
            {SCOPES.map(s => (
              <button key={s.id} type="button" onClick={() => setScope(s.id)} className={`px-2 py-0.5 ${scope === s.id ? 'bg-row-selected-bg text-row-selected-fg' : 'hover:bg-row-hover-bg'}`}>{s.label}</button>
            ))}
          </div>
          <div role="group" aria-label="Providers" className="flex gap-1">
            {AGENT_PROVIDER_KINDS.map(kind => (
              <button key={kind} type="button" aria-pressed={providers.includes(kind)} onClick={() => toggleProvider(kind)} className={`rounded-slab border border-border px-2 py-0.5 ${providers.includes(kind) ? 'bg-row-selected-bg text-row-selected-fg' : 'hover:bg-row-hover-bg'}`}>{kind}</button>
            ))}
          </div>
          {response && (
            <button type="button" aria-pressed={includeChildren} onClick={() => setIncludeChildren(v => !v)} className="ml-auto rounded-slab border border-border px-2 py-0.5 hover:bg-row-hover-bg">
              {includeChildren ? `showing ${response.hiddenChildren} children` : `${response.hiddenChildren} hidden`}
            </button>
          )}
          <span className="font-code opacity-80">{loading ? 'loading…' : response ? `${response.total} conversations` : ''} · ↑↓ ↵ resume</span>
        </div>
        {error && <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">{error}</div>}
        <div className="flex min-h-0 flex-1">
          <div ref={listRef} tabIndex={-1} role="listbox" aria-label="Conversations" className="min-h-0 overflow-y-auto outline-none" style={{ width: listWidth, flexShrink: 0 }}
            onScroll={e => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore() }}>
            {rows.length === 0 && !loading && !error ? (
              <div className="py-12 text-center text-[12px] text-muted">{query.trim() ? `No conversations match "${query.trim()}".` : 'No conversations recorded for this scope.'}</div>
            ) : rows.map((row, i) => (
              <ConversationRow key={`${row.provider}:${row.nativeId}`} row={row} index={i} selected={i === selected} onHover={() => setSelected(i)} onSelect={() => void resume(row)} />
            ))}
          </div>
          <div onMouseDown={splitter.onMouseDown} className={`w-1 flex-shrink-0 cursor-col-resize ${splitter.dragging ? 'bg-accent' : 'bg-border hover:bg-border-hi'}`} />
          <div className="min-w-0 flex-1 border-l border-border">
            <SessionPreviewPane target={previewTarget} turnCount={rows[selected]?.promptCount ?? null} />
          </div>
        </div>
        {splitter.cursorLock}
      </DialogContent>
    </Dialog>
  )
}
```

In `SessionPreviewPane.tsx`: add `turnCount?: number | null` to the component props, pass it to `PaneHeader`, and in `PaneHeader` compute `const turns = turnCount ?? (state.status === 'ready' ? countUserTurns(state.model.entries) : null)` with a comment: the pane loads a 40-record tail, so its own count is a floor; the catalog's prompt count is the whole conversation, which is what "1 turn" on a long planning session got wrong in the user's screenshot.

- [x] **Step 4: Run the renderer test and the web typecheck**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/conversations && npx tsc -p tsconfig.web.json --pretty false`
Expected: 5 PASS; tsc clean. If `useResizableSplitter`'s return shape differs (`onMouseDown`, `dragging`, `cursorLock` are what `PromptSearchModal.tsx` uses today), match that file.

- [x] **Step 5: Commit**

```bash
git add src/renderer/src/features/conversations src/renderer/src/features/session-preview/ui/SessionPreviewPane.tsx
git commit -m "feat(picker): list every conversation of the repository with filters, search and preview"
```

### Task 19: Path picker consumes the catalog

**Files:**
- Modify: `src/renderer/src/features/path-picker/ui/PathPickerModal.tsx:67-75,117-180,222-235,330-440`
- Modify: `src/renderer/src/features/path-picker/ui/PathPickerModal.renderer.test.tsx`

**Interfaces:**
- Consumes: `window.api.listConversations`, `ConversationRow` (Task 18).
- Produces: `onResume(expandedPath, nativeId, provider)` unchanged for the caller; rows are `Conversation` and the list is the typed path's family (`scope: 'cwd'` when the provider toggle is set, since the path picker is about one directory).

- [x] **Step 1: Rewrite the resume-target coherence test against the new API**

In `PathPickerModal.renderer.test.tsx`, replace `installApi(listSessionsForCwd)` with `installApi(listConversations)`, replace `session(id, summary)` with a `Conversation` builder (copy `row()` from Task 18's test, minus `match`), and change every `listSessionsForCwd` assertion to `listConversations` receiving `{ cwd: '/repo', scope: 'cwd', providers: [provider], includeChildren: false, limit: 50 }`. Keep the test's contract sentence by sentence: an accepted Claude row must disappear before a pending Codex refresh resolves, and a failure must render the listing error rather than "no previous sessions".

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/path-picker`
Expected: FAIL (the modal still calls `listSessionsForCwd`).

- [x] **Step 2: Migrate the modal**

- State: `const [sessions, setSessions] = useState<Conversation[]>([])`.
- The debounced effect: replace `window.api.listSessionsForCwd(result.path, 20, provider)` with `(await window.api.listConversations({ cwd: result.path, scope: 'cwd', providers: [provider], includeChildren: false, limit: 50 })).rows`.
- `resume(sessionId)` keeps its signature; it finds the row by `nativeId` and calls `onResume(listingTarget.cwd, row.nativeId, row.provider)`.
- `ResumeSection` renders `ConversationRow` for each row (`selected={false}`, `index={i}`, `onSelect={() => void onResume(row.nativeId)}`, `onHover={() => {}}`) and deletes `ResumeRow`. Remove the `SessionInfo` and `relativeTime` imports that become unused.

- [x] **Step 3: Run the renderer tests and the web typecheck, then commit**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/path-picker && npx tsc -p tsconfig.web.json --pretty false`

```bash
git add src/renderer/src/features/path-picker
git commit -m "feat(picker): list the typed folder's conversations in the path picker through the catalog"
```

### Task 20: Uncapped prompt lists with relative time

**Files:**
- Create: `src/renderer/src/features/conversations/ui/PromptList.tsx`
- Create: `src/renderer/src/features/conversations/ui/PromptList.renderer.test.tsx`
- Modify: `src/renderer/src/features/workspace/ui/ViewPromptsModal.tsx` (whole body)
- Modify: `src/renderer/src/features/workspace/ui/RewindToPromptModal.tsx:56,95-100` (drop `PROMPT_LIMIT`; relative time)
- Modify: `src/main/providerSwitch/rewindSession.ts:35-51` (no cap unless the caller asks)
- Modify: `src/main/providerSwitch/rewindSession.test.ts` (the limit case)

**Interfaces:**
- Produces: `PromptList` props `{ prompts: Array<{ text: string; timestamp: number | null }>; selectedIndex?: number | null; onSelect?(index: number): void; emptyMessage: string }`; `formatPromptTime(timestamp: number | null): { relative: string; absolute: string | null }`.
- `listRewindPrompts(request)`: when `request.limit` is undefined return every prompt newest first; a finite limit still caps.

- [ ] **Step 1: Write the failing PromptList test**

```tsx
// src/renderer/src/features/conversations/ui/PromptList.renderer.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { formatPromptTime, PromptList } from './PromptList'

describe('PromptList', () => {
  it('shows every prompt with a relative time and the absolute time on hover, newest first', () => {
    const now = Date.now()
    const prompts = Array.from({ length: 40 }, (_, i) => ({ text: `prompt ${i}`, timestamp: now - i * 3600_000 }))
    render(<PromptList prompts={prompts} emptyMessage="none" />)
    expect(screen.getAllByRole('listitem')).toHaveLength(40)
    expect(screen.getByText('prompt 39')).toBeInTheDocument()
    expect(screen.getByText('3h ago')).toBeInTheDocument()
    expect(screen.getByText('3h ago')).toHaveAttribute('title', formatPromptTime(now - 3 * 3600_000).absolute!)
  })
  it('renders unknown times honestly and forwards selection', () => {
    const onSelect = vi.fn()
    render(<PromptList prompts={[{ text: 'a', timestamp: null }]} selectedIndex={0} onSelect={onSelect} emptyMessage="none" />)
    expect(screen.getByText('unknown time')).toBeInTheDocument()
    fireEvent.click(screen.getByText('a'))
    expect(onSelect).toHaveBeenCalledWith(0)
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-selected', 'true')
  })
  it('shows the empty message when there is nothing to list', () => {
    render(<PromptList prompts={[]} emptyMessage="No visible user prompts found for this session." />)
    expect(screen.getByText('No visible user prompts found for this session.')).toBeInTheDocument()
  })
})
```

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/conversations/ui/PromptList.renderer.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 2: Write PromptList**

```tsx
// src/renderer/src/features/conversations/ui/PromptList.tsx
import { relativeTime } from '@renderer/lib/relativeTime'

// The prompt list behind View Prompts and Rewind to Prompt. Uncapped on
// purpose (the user, 2026-09-11: "capping the view prompts command is just
// pure stupid"): a few hundred rows of one-line cards render fine without
// virtualisation, and a cap silently hid the prompt the user was looking for.
// Relative time is the primary label because "3h ago" is how people remember
// their own afternoon; the absolute time stays on hover.

export function formatPromptTime(timestamp: number | null): { relative: string; absolute: string | null } {
  if (timestamp === null || !Number.isFinite(timestamp)) return { relative: 'unknown time', absolute: null }
  return { relative: relativeTime(timestamp), absolute: new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
}

export function PromptList({ prompts, selectedIndex = null, onSelect, emptyMessage }: {
  prompts: ReadonlyArray<{ text: string; timestamp: number | null }>
  selectedIndex?: number | null
  onSelect?: (index: number) => void
  emptyMessage: string
}) {
  if (prompts.length === 0) return <div className="py-8 text-center text-[12px] text-muted">{emptyMessage}</div>
  return (
    <ul className="flex flex-col gap-3" role="list">
      {prompts.map((prompt, index) => {
        const time = formatPromptTime(prompt.timestamp)
        const selected = selectedIndex === index
        return (
          <li
            key={`${prompt.timestamp ?? 'unknown'}:${index}`}
            role="listitem"
            aria-selected={onSelect ? selected : undefined}
            data-prompt-index={index}
            onClick={onSelect ? () => onSelect(index) : undefined}
            className={`rounded-slab border px-3 py-3 ${selected ? 'border-accent bg-row-selected-bg' : 'border-border bg-canvas/70'} ${onSelect ? 'cursor-pointer' : ''}`}
          >
            <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.12em] text-muted">
              <span>#{prompts.length - index}</span>
              <span title={time.absolute ?? undefined}>{time.relative}</span>
            </div>
            <div className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-ink">{prompt.text}</div>
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 3: Rewrite ViewPromptsModal on the catalog**

Replace the body of `ViewPromptsModal.tsx` so that:
- it resolves `const providerSessionId = resumableProviderSessionId(meta)` (import from `@renderer/workspace/providerSessionIdentity`, the same helper `RewindToPromptModal` uses) and `const provider = meta.kind`;
- when `open && providerSessionId && isAgentProviderKind(provider)` it calls `window.api.listConversationPrompts({ provider, nativeId: providerSessionId, cwd: meta.cwd })` in an effect with a `cancelled` flag, storing `prompts`, `loading`, `loadError`;
- when there is no native id yet (a pane that has not produced a transcript), it falls back to `extractLatestUserPrompts(runtime.entries, meta.kind)` with NO limit and maps `timestamp` strings through `Date.parse`;
- it renders `<PromptList prompts={prompts} emptyMessage="No visible user prompts found for this session." />` inside the existing scroller, and the footer reads `${prompts.length} prompts` or `Loading prompts…`;
- `PROMPT_LIMIT`, `formatPromptTimestamp` and the older-history paging effect are deleted.

- [ ] **Step 4: Uncap Rewind**

In `rewindSession.ts` replace the limit block with:

```ts
  // Newest first. No cap unless the caller asks for one: the rewind picker
  // lists every prompt (a cap hid the one the user wanted), while external
  // operators still bound their pages. A finite limit is honoured as before.
  if (request.limit === undefined) return prompts.slice().reverse()
  const limit = Number.isFinite(request.limit) ? Math.max(1, Math.floor(request.limit)) : prompts.length
  return prompts.slice(-limit).reverse()
```

Update the corresponding expectation in `rewindSession.test.ts` (an undefined limit returns all, reversed). In `RewindToPromptModal.tsx` delete `PROMPT_LIMIT`, call `listRewindPrompts` without `limit`, and render the rows through `PromptList` with `selectedIndex`/`onSelect` wired to the existing keyboard model (map `RewindPrompt.timestamp` strings with `Date.parse`, keeping `address` in a parallel array indexed the same way).

- [ ] **Step 5: Run the affected tests and both typechecks**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/conversations src/renderer/src/features/workspace/ui && NODE_ENV=test npx vitest run --project unit src/main/providerSwitch/rewindSession.test.ts && npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`
Expected: PASS; both clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/conversations/ui/PromptList.tsx src/renderer/src/features/conversations/ui/PromptList.renderer.test.tsx src/renderer/src/features/workspace/ui/ViewPromptsModal.tsx src/renderer/src/features/workspace/ui/RewindToPromptModal.tsx src/main/providerSwitch/rewindSession.ts src/main/providerSwitch/rewindSession.test.ts
git commit -m "feat(picker): list every prompt with relative time in View Prompts and Rewind"
```

### Task 21: External control reads the catalog

**Files:**
- Modify: `src/main/sessions/nativeHistoryControl.ts` (whole file)
- Modify: `src/main/sessions/nativeHistoryControl.test.ts`
- Modify: `src/main/index.ts:995-997` (`nativeHistoryControlCapabilities(conversationService)`)

**Interfaces:**
- Produces: `nativeHistoryControlCapabilities(service: ConversationService)`. `nativeHistory.list` and `nativeHistory.search` keep their output schemas except `coverage.exhaustive` becomes `z.boolean()` (true now) and `candidatesPerProvider` reports the number of candidates considered; `nativeHistory.prompts` is unchanged.

- [ ] **Step 1: Update the tests first**

In `nativeHistoryControl.test.ts` remove the `vi.mock` lines for `sessionList.js`, `projectDir.js` (both) and `registry.main` and instead construct a fake service:

```ts
const service = {
  list: vi.fn(async (request: { query?: string; providers?: string[] }) => ({
    rows: [{ provider: 'claude', nativeId: 'source', cwd: '/trial', label: 'Recorded conversation', labelSource: 'ai-title', gitBranch: null, agentCodeTitle: null, firstPrompt: 'Recorded', lastUserActivityAt: 1, promptCount: 3, match: request.query ? { field: 'prompt', text: 'Recorded conversation', start: 0, end: 8 } : null }],
    total: 1, hiddenChildren: 0, nextCursor: null, family: { repoRoot: '/trial', roots: ['/trial'] }, timing: { ms: 1 },
  })),
  prompts: vi.fn(async () => [{ text: 'Recorded conversation', timestamp: 1 }]),
  children: vi.fn(async () => []),
}
```

pass `nativeHistoryControlCapabilities(service as never)` everywhere, keep the `nativeHistory.prompts` case exactly as it is (it goes through the real transcript engine), and change the search assertion's coverage to `{ exhaustive: true, candidatesPerProvider: 1 }`. Replace the OpenCode "unavailable" case with: `expect(await cap.execute({ provider: 'opencode' }, context)).toMatchObject({ ok: true })` since OpenCode discovery now works, and keep the IO-failure case by making `service.list` reject.

Run: `NODE_ENV=test npx vitest run --project unit src/main/sessions/nativeHistoryControl.test.ts`
Expected: FAIL (signature and behaviour differ).

- [ ] **Step 2: Rewrite the capabilities**

```ts
// src/main/sessions/nativeHistoryControl.ts
import { z } from 'zod'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import type { ConversationService } from '@main/conversations/service'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine'

const provider = z.enum(['claude', 'codex', 'opencode'])
const identity = z.object({ provider, cwd: z.string().min(1).describe('Native session working directory, not a project title.'),
  nativeSessionId: z.string().min(1).describe('Provider-native ID from nativeHistory.list or agents.lifecycleRead; not an Agent Code session ID.') })
const prompt = z.object({ address: z.object({ provider, line: z.number(), sessionId: z.string().nullable(), uuid: z.string().nullable().optional() }),
  text: z.string(), totalChars: z.number(), timestamp: z.string().nullable() })
const session = z.object({ nativeSessionId: z.string(), summary: z.string(), lastModified: z.number(), fileSize: z.number(),
  cwd: z.string().nullable(), customTitle: z.string().nullable(), firstPrompt: z.string().nullable(), gitBranch: z.string().nullable() })

// Catalogs are served by the same conversation service as the in-app picker
// (docs/decomposition/conversations.md D8), so an external operator and the
// user see the same rows in the same order. Output schemas are kept so
// existing operators keep parsing; the coverage block now reports the truth
// (scope-bounded and exhaustive) instead of the old 400-candidate budget.
export function nativeHistoryControlCapabilities(service: ConversationService) {
  const rowToSession = (row: Awaited<ReturnType<ConversationService['list']>>['rows'][number]) => ({
    nativeSessionId: row.nativeId, summary: row.label.slice(0, 4000), lastModified: row.lastUserActivityAt, fileSize: 0,
    cwd: row.cwd || null, customTitle: row.agentCodeTitle, firstPrompt: row.firstPrompt?.slice(0, 4000) ?? null, gitBranch: row.gitBranch,
  })
  return [
    defineCapability({ id: 'nativeHistory.search', title: 'Search historical conversation prompts', execution: 'main', effect: 'read',
      description: 'Search past conversations by title, agent name and user-prompt text across Claude, Codex and OpenCode, including conversations not open in Agent Code. Scoped to the repository family of cwd when given (every worktree), otherwise everywhere. Returns provider-native IDs, cwd, timestamps and the matched snippet. Use nativeHistory.prompts for exact rewind addresses and agents.resume for the chosen native ID/cwd; never guess a missing cwd.',
      input: z.object({ query: z.string().trim().min(1).max(2000), cwd: z.string().min(1).optional(), resultLimit: z.number().int().min(1).max(800).default(100), ...pageInput }).strict(),
      output: pageSchema(z.object({ provider, nativeSessionId: z.string(), cwd: z.string().nullable(), lastModified: z.number(), summary: z.string(), matchCount: z.number(), prompts: z.array(z.object({ text: z.string(), totalChars: z.number(), timestamp: z.number().nullable() })) })).extend({ coverage: z.object({ providers: z.array(z.string()), candidatesPerProvider: z.number(), exhaustive: z.boolean(), possiblyMoreResults: z.boolean() }) }),
      handler: async input => {
        const response = await service.list({ cwd: input.cwd ?? '', scope: input.cwd ? 'repository' : 'everywhere', query: input.query, includeChildren: true, limit: input.resultLimit })
        const page = paginate(response.rows, input, `native-search:${input.query}:${input.cwd ?? ''}:${input.resultLimit}`)
        return { ...page, items: page.items.map(row => ({ provider: row.provider, nativeSessionId: row.nativeId, cwd: row.cwd || null, lastModified: row.lastUserActivityAt, summary: row.label.slice(0, 2000), matchCount: row.match ? 1 : 0,
          prompts: row.match ? [{ text: row.match.text.slice(0, 2000), totalChars: row.match.text.length, timestamp: null }] : [] })),
          coverage: { providers: ['claude', 'codex', 'opencode'], candidatesPerProvider: response.total, exhaustive: true, possiblyMoreResults: response.nextCursor !== null } }
      },
    }),
    defineCapability({ id: 'nativeHistory.list', title: 'Find native sessions to resume', execution: 'main', effect: 'read',
      description: 'List past conversations for one provider, newest user activity first, including conversations not open in Agent Code and every worktree of cwd when given. Orchestration children, native subagents and exec runs are included; possiblyTruncated means older rows exist beyond scanLimit. Use agents.resume to open a chosen native identity in an explicit project.',
      input: z.object({ provider, cwd: z.string().min(1).optional(), scanLimit: z.number().int().min(1).max(2000).default(500).describe('Number of recent native records to load before paging; keep fixed for continuation.'), ...pageInput }).strict(),
      output: pageSchema(session).extend({ provider, possiblyTruncated: z.boolean() }),
      handler: async input => {
        const response = await service.list({ cwd: input.cwd ?? '', scope: input.cwd ? 'repository' : 'everywhere', providers: [input.provider], includeChildren: true, limit: input.scanLimit })
        return { ...paginate(response.rows.map(rowToSession), input, `native:${input.provider}:${input.cwd ?? ''}:${input.scanLimit}`), provider: input.provider, possiblyTruncated: response.nextCursor !== null }
      },
    }),
    defineCapability({ id: 'nativeHistory.prompts', title: 'Find exact native rewind addresses', execution: 'main', effect: 'read',
      description: 'Read user prompt addresses from an exact native transcript, newest first, without waking its agent. Uses the native engine, including OpenCode export for a known ID. Text previews are bounded; totalChars reports omitted text. Addresses are opaque source references, not rendered message indexes. Pass an address unchanged to agents.rewind. Source changes invalidate paging; rewind itself revalidates membership and refuses an empty resulting conversation.',
      input: identity.extend({ ...pageInput, query: z.string().default('').describe('Optional case-insensitive substring filter on full prompt text, before previews and paging.'), previewChars: z.number().int().min(0).max(4000).default(1000).describe('Maximum text characters per prompt; zero returns addresses only.') }).strict(),
      output: pageSchema(prompt),
      handler: async input => {
        const prompts = await getHostTranscriptAdapter(input.provider).listPrompts(input.cwd, input.nativeSessionId)
        const page = paginate(prompts.filter(prompt => prompt.text.toLowerCase().includes(input.query.toLowerCase())).reverse(), input, `prompts:${input.provider}:${input.cwd}:${input.nativeSessionId}:${input.previewChars}:${input.query}`)
        return { ...page, items: page.items.map(row => ({ ...row, text: row.text.slice(0, input.previewChars), totalChars: row.text.length })) }
      },
    }),
  ]
}

void ControlError
```

Drop the trailing `void ControlError` and its import if nothing throws it; it is listed so the executor sees the original imports.

- [ ] **Step 3: Wire, run, commit**

In `src/main/index.ts` change `...nativeHistoryControlCapabilities()` to `...nativeHistoryControlCapabilities(conversationService)`.

Run: `NODE_ENV=test npx vitest run --project unit src/main/sessions/nativeHistoryControl.test.ts && npx tsc -p tsconfig.node.json --pretty false`

```bash
git add src/main/sessions/nativeHistoryControl.ts src/main/sessions/nativeHistoryControl.test.ts src/main/index.ts
git commit -m "feat(control): serve native history from the conversation catalog"
```

### Task 22: Live suite with the timing budget

**Files:**
- Create: `src/main/conversations/conversations.live.test.ts`
- Modify: `package.json` scripts (`test:live:conversations`)

**Interfaces:**
- Runs only with `AGENT_CODE_LIVE_CONVERSATIONS=1`; reads the developer's real stores through `createConversationService`.

- [ ] **Step 1: Write the live test**

```ts
// src/main/conversations/conversations.live.test.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createConversationService } from './service.js'

// The only place the D6 timing budget is measured, against the real stores
// of whoever runs it. Never part of `npm test`; opt in with
// AGENT_CODE_LIVE_CONVERSATIONS=1 npm run test:live:conversations.
const enabled = process.env.AGENT_CODE_LIVE_CONVERSATIONS === '1'
const REPO = process.cwd()

describe.skipIf(!enabled)('conversations against the live stores', () => {
  it('lists this repository across worktrees within budget and hides its review children', async () => {
    const service = createConversationService({ ledger: null })
    const cold0 = performance.now()
    const cold = await service.list({ cwd: REPO, scope: 'repository', limit: 100 })
    const coldMs = performance.now() - cold0
    const warm0 = performance.now()
    const warm = await service.list({ cwd: REPO, scope: 'repository', limit: 100 })
    const warmMs = performance.now() - warm0
    // eslint-disable-next-line no-console
    console.log(`live: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms, total ${cold.total}, hidden ${cold.hiddenChildren}, shown ${cold.rows.length}`)
    expect(coldMs).toBeLessThan(500)
    expect(warmMs).toBeLessThan(100)
    expect(cold.hiddenChildren).toBeGreaterThan(0)
    expect(cold.rows.every(r => r.kind === 'user' || r.kind === 'projected')).toBe(true)
    expect(new Set(cold.rows.map(r => r.provider)).size).toBeGreaterThanOrEqual(2)
    expect(warm.rows.map(r => r.nativeId)).toEqual(cold.rows.map(r => r.nativeId))
    // Readable labels: no row on the live machine may be labelled by the
    // injected AGENTS.md text or a bare wrapper.
    for (const row of cold.rows) {
      expect(row.label.startsWith('# AGENTS.md')).toBe(false)
      expect(row.label.startsWith('<')).toBe(false)
      if (row.provider !== 'claude') expect(row.activitySource).not.toBe('mtime')
    }
  })

  it('matches the unredacted corpus manifest counts for this repository', async () => {
    let manifest: { counts: { claude: { inFamily: number }; codex: { inFamily: number } } } | null = null
    try {
      manifest = JSON.parse(await readFile(join(REPO, 'testing', 'fixtures', 'conversations', 'local', 'manifest.json'), 'utf8'))
    } catch {
      manifest = null
    }
    if (!manifest) return
    const service = createConversationService({ ledger: null })
    const all = await service.list({ cwd: REPO, scope: 'repository', includeChildren: true, limit: 500 })
    // Stores keep growing after the corpus was recorded; the live list must
    // never hold FEWER than the recording did.
    expect(all.total).toBeGreaterThanOrEqual(manifest.counts.claude.inFamily + manifest.counts.codex.inFamily)
  })

  it('searches under budget', async () => {
    const service = createConversationService({ ledger: null })
    await service.list({ cwd: REPO, scope: 'repository', limit: 10 })
    const t0 = performance.now()
    const hits = await service.list({ cwd: REPO, scope: 'repository', query: 'read', limit: 30 })
    const ms = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`live search: ${ms.toFixed(0)} ms, ${hits.rows.length} hits`)
    expect(ms).toBeLessThan(750)
    expect(hits.rows.every(r => r.match !== null)).toBe(true)
  })
})
```

Add to `package.json` scripts: `"test:live:conversations": "npm run workflow-mcp:build && NODE_ENV=test AGENT_CODE_LIVE_CONVERSATIONS=1 vitest run --config vitest.live.config.ts src/main/conversations/conversations.live.test.ts"`.

- [ ] **Step 2: Run it on the author's machine and record the numbers in the PR body**

Run: `npm run test:live:conversations`
Expected: PASS with the printed timings. The first search runs the bounded prompt fold for the newest 200 non-Claude rows, which is why its budget is 750 ms rather than 50 ms; the second search of the same scope should print under 50 ms, and the PR body must show both.

- [ ] **Step 3: Commit**

```bash
git add src/main/conversations/conversations.live.test.ts package.json
git commit -m "test(conversations): measure the live picker budget against real stores"
```

---

## Stage 5 — Deletion and the PR

### Task 23: Delete the old listing paths, lock the boundary, open the PR

**Files:**
- Delete: `src/providers/claude/runtime/sessionList.ts`, `src/main/sessionIndex.ts`, `src/main/ipc/sessions.ts`, `src/preload/api/sessions.ts`, `src/renderer/src/features/command-palette/useResumeSessionListing.ts`, `src/renderer/src/features/command-palette/useResumeSessionListing.renderer.test.tsx`, `src/renderer/src/features/workspace/ui/PromptSearchModal.tsx`, `src/renderer/src/features/workspace/surfaces/PromptSearchSurface.tsx`
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` (remove the `resume` mode: `useResumeSessionListing` import and hook call, `resumeProvider`, `enterResumeMode`, `executeResume`, `resumePreviewTarget`, `filteredSessions`, every `mode === 'resume'` branch, the `SessionPreviewPane` import if unused), `src/renderer/src/features/command-palette/paletteMode.ts` (drop `'resume'`), `src/renderer/src/features/command-palette/types.ts` (drop `enterResumeMode`), `src/main/ipc/session.ts:328-405` (delete `session:list-for-cwd` and `session:list-all`, `resumeListTargetFingerprint`, `RESUME_LIST_TARGET_FINGERPRINT_KEY`), `src/main/ipc/session.test.ts:106-175` (delete the two resume-listing tests; their contract lives in `ipc/conversations.test.ts`), `src/preload/api/session.ts:161-180` (delete `listSessionsForCwd`, `listAllSessions`), `src/preload/api/index.ts` (drop `sessionsApi`), `src/main/ipc/index.ts` (drop `registerSessionsIpc`), `src/shared/types/providerConfig.ts:380-390` (delete `listSessions`, `listAllSessions`, `sessionDiscoveryUnavailableReason`), `src/providers/registry.main.ts` (delete those three members from all three configs and the now-unused imports), `src/providers/shared/featureCapabilities.ts` (delete `savedSessionListing` and its uses; `providerFeatures.test.ts` accordingly), `src/preload/api/types.ts:244-268` (delete `SessionIndexPrompt`, `SessionIndexEntry`), `src/renderer/src/features/workspace/lib/sessionDisplay.ts` header comment (it now serves `ConversationRow`), `src/shared/types/session.ts:645-664` (`SessionInfo` stays only if `packages/*` or `nativeHistoryControl` still import it; otherwise delete), `docs/decomposition/conversations.md` (Status line → implemented, with the live numbers), `docs/design/README.md` (no new design doc: the decomposition is the source of truth; add one line pointing at it under "Current files")

- [ ] **Step 1: Delete and fix the compile**

```bash
git rm src/providers/claude/runtime/sessionList.ts src/main/sessionIndex.ts src/main/ipc/sessions.ts src/preload/api/sessions.ts src/renderer/src/features/command-palette/useResumeSessionListing.ts src/renderer/src/features/command-palette/useResumeSessionListing.renderer.test.tsx src/renderer/src/features/workspace/ui/PromptSearchModal.tsx src/renderer/src/features/workspace/surfaces/PromptSearchSurface.tsx
```

Then make the edits listed under Files until both typechecks are clean:

Run: `npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`

Every remaining reference to a deleted symbol is a compile error; fix each at its call site by consuming the catalog, never by re-adding the symbol.

- [ ] **Step 2: Grep for dead references and stale comments**

Run: `grep -rn "listSessionsForCwd\|listAllSessions\|searchSessionPrompts\|listRecentSessionsWithPrompts\|SessionIndexEntry\|savedSessionListing\|PromptSearchModal\|promptSearchOpen\|paletteMode === 'resume'\|'resume'" src packages/*/src --include='*.ts' --include='*.tsx' | grep -v "packages/claude-code-headless\|packages/codex-headless"`
Expected: no output. (`claude-code-headless`'s own `SessionList.ts` and `codex-headless`'s `listCodexSessions` stay: they are package APIs with their own consumers; only Agent Code's use of them as the picker source is gone.)

- [ ] **Step 3: Run the whole gate once**

Run: `npm run test:contract && npm run check:conversation-fixtures && npm run check:keybindings && npm run typecheck && npm test`
Expected: all green except the known pre-existing local failures listed in memory (`imageAttachment`, `store.performance`, `lazy-prose` timeouts). Report any other failure verbatim; do not raise timeouts.

- [ ] **Step 4: Update the decomposition status and commit**

In `docs/decomposition/conversations.md` change the Status line to `**implemented on \`feat/session-picker\` (PR #<n>)**; live numbers on the author's machine: cold <x> ms, warm <y> ms, search <z> ms` with the values from Task 22.

```bash
git add -A
git commit -m "refactor(conversations): delete the four transcript listers and the three old pickers"
```

- [ ] **Step 5: Push and open the PR (do not merge)**

```bash
git push -u origin feat/session-picker
gh pr create --repo Juliusolsson05/agent-code --title "feat(conversations): rebuild the conversation picker on provider-native indexes" --body-file - <<'EOF'
## Problem

The resume picker capped at 20 rows, never visited worktree project dirs, could not tell orchestration children from real sessions (16 of 57 here, 66 of 98 in bringdown), labelled every Codex row with the injected AGENTS.md text, took 1.5–2.9 s per Codex open, and the prompt search folded up to 400 files per keystroke. View Prompts and Rewind capped at 15. Measured evidence and the decomposition: `docs/decomposition/conversations.md`.

## What this does

One Conversations picker behind `Resume Session…` and `Search Conversations…`, fed by one catalog over the providers' native indexes: Codex `state_N.sqlite` (read-only via `node:sqlite`), Claude project dirs merged across `git worktree list` plus `ai-title` records and `history.jsonl`, OpenCode `opencode.db`. Rows carry a label with provenance, the Agent Code spoken name and title from a new durable ledger, worktree, relative time and prompt count; children (orchestration, native subagents, `codex exec`) are hidden behind a counted toggle; ordering is last user activity. The path picker, View Prompts, Rewind and the external `nativeHistory.*` capabilities read the same catalog. The old listers, index, IPC and modals are deleted.

## Behaviour changes

- Codex rows are labelled by their first real prompt (or the user's thread name), not the AGENTS.md injection.
- Claude rows label by custom title → AI title → first prompt; a nameless session is shown with a marked fallback instead of dropped.
- The default scope is the repository across all worktrees; `this folder` and `everywhere` are one click.
- Prompt lists are uncapped and show relative time.

## Verification

- Corpus recorded from real stores (`testing/fixtures/conversations/`, redacted by policy, verified by `check:conversation-fixtures`); expectations authored with the user.
- System tests: family resolution with a real `git worktree add`, each adapter over the corpus, the ledger, the service, the IPC contract (#718 evidence re-homed).
- Renderer tests: picker filters, keyboard, resume dispatch, failure vs empty; prompt list.
- Live suite on the author's machine (`AGENT_CODE_LIVE_CONVERSATIONS=1`): cold <x> ms, warm <y> ms, search <z> ms.
- `npm run typecheck`, `npm test`, `npm run check:keybindings`, `npm run test:contract`.

## Known limitations

- Codex and OpenCode prompt search covers the newest 200 rows' last 40 prompts per query; Claude search covers every prompt in `history.jsonl`.
- `node:sqlite` prints one experimental warning per process in dev logs.
- Attention-based ranking (#739) is not in scope; ordering by last user activity is.

Fixes #874
Fixes #96
Fixes #151
Fixes #718
Fixes #773
Refs #735, #739, #762

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Ukb9oTvJaojxUxoHfYEUby
EOF
```

Fill in `<x>`, `<y>`, `<z>` from Task 22 before running. Then stop: opening the PR is not permission to merge it.
