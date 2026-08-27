#!/usr/bin/env npx tsx --tsconfig tsconfig.web.json
// Local Claude transcripts → redacted `queue-operation` replay fixtures.
//
// WHY this exists (docs/decomposition/claude-queue-reconciliation.md §7 Stage 1):
// the Claude queue reconstruction has now been wrong twice, and both times the
// implementation was built from an ASSUMED set of cases. Measuring the real
// corpus corrected the working hypothesis twice in one sitting — batch drains
// turned out to be a minority (95% of `dequeue` runs are single-item), and
// `remove` turned out to OUTNUMBER `dequeue`, which is what led to finding its
// real emit site. So the fixtures come first and the reconciler is written
// against them, not the other way round.
//
// WHY one ordered `events` array instead of separate ops/entries lists: the
// reconciler's whole job is deciding what a departure op removed, and the only
// evidence for that is WHICH committed user entry appeared BETWEEN two ops.
// Splitting them into parallel arrays would throw away the interleaving that
// is the entire signal. A fixture replays by walking `events` in order,
// exactly as `useIpcSubscriptions` walks a live burst.
//
// WHY the REDUCED queue-replay fixtures keep only user entries: dequeue
// identity is carried by committed user rows, while this fixture family exists
// to pin queue membership rather than feed rendering. This does NOT make other
// transcript kinds irrelevant. Claude persists mid-turn consumption as an
// attachment/queued_command; full rendering bundles own admission and paint
// evidence for that row. The --measure path deliberately counts those
// attachments even though this reduced output format does not serialize them.
//
// REDACTION is hard-gated. This reuses `findSensitiveSurvivors` from the
// rendering redactor rather than re-implementing a second gate: a duplicated
// regex is exactly how a fixture with a live token ends up committed. The
// script THROWS rather than emitting a suspect fixture — a loud failure a human
// resolves, never a warning that scrolls past.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSensitiveSurvivors } from '../src/renderer/src/rendering/replay/redact.js'
import { derivePriority } from '../src/renderer/src/session-runtime/claudeQueue/priority.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT_DIR = join(REPO, 'testing', 'fixtures', 'queue-operations')
const HOME = homedir()

// Caps. Prompt identity is matched on a normalized 48-char prefix and a
// notification's <task-id> sits in the first ~80 characters, so both caps are
// far above every value the reconciler actually reads — they bound fixture size
// without changing a single decision. The enqueue cap is the looser of the two
// because `popAll` replay compares logged content directly.
//
// The invariant that matters: a committed entry must still CONTAIN the
// enqueued prefix after capping. Since the committed cap (300) exceeds the
// match prefix (48) by a wide margin, that holds. Lower USER_TEXT_CAP below 48
// and deliveries silently stop matching — a false negative baked into the
// corpus, which is worse than a large fixture.
const ENQUEUE_CONTENT_CAP = 600
const USER_TEXT_CAP = 300

// Notifications get their own, much larger cap, and it is load-bearing.
//
// `derivePriority` reads `<summary>`, which sits at the END of the payload,
// AFTER `<result>`. Capping a notification at 600 truncated it mid-`<summary>`,
// the closing tag vanished, `summaryOf` returned null, the `Background command `
// test could not fire, and the item fell through to `later`. That silently
// encoded the exact bug this PR fixes INTO the corpus: two background commands
// in the first version of the fixtures were scored `later` and stranded — by
// the extractor, not the reconciler. Fixture-first evidence that mis-encodes
// the load-bearing field is worse than no fixture, because it reads as
// ratification.
//
// Two defences, because a comment is not a gate: `<result>` bodies are stripped
// BEFORE capping (they are the only large field), and `assertNoPriorityDrift`
// re-derives priority from the raw payload and refuses to emit on any
// disagreement.
const NOTIFICATION_CONTENT_CAP = 4000

type FixtureEvent =
  | { kind: 'op'; op: string; content?: string; timestamp?: string }
  | { kind: 'user'; uuid?: string; text: string }

export type QueueOperationFixture = {
  /** Relative to ~/.claude/projects, home-anonymized. Provenance, not a path to read. */
  source: string
  note: string
  events: FixtureEvent[]
}

// Claude Code slugifies project paths into directory names, so the operator's
// username appears in THREE forms: `/Users/name` (real path), `-Users-name`
// (the slug embedded in scratchpad paths that notifications carry in
// <output-file>), and bare `name`. Replacing only the first form left 244
// leaks in one fixture — hence all three, bare-username last so the more
// specific patterns win.
const USERNAME = HOME.split('/').filter(Boolean).pop() ?? ''
const HOME_SLUG = HOME.split('/').join('-')
const HOSTNAME = hostname()

// VALUE-shaped secret scanning.
//
// WHY this exists on top of `findSensitiveSurvivors`: that gate is KEY-based —
// it strips values sitting under a key whose NAME looks secret (`apiKey`,
// `token`, …). Queue content has no keys. It is raw prose: whatever the user
// typed, including the times they pasted an API key straight into a prompt.
// The first run of this extractor passed the key-based gate cleanly and was
// then rejected by GitHub push protection with a live Anthropic key, an
// OpenRouter key and a GitHub PAT sitting in the fixtures. The gate was not
// wrong, it was blind to this shape — so the extractor gets a second,
// value-shaped pass rather than a weakened check.
//
// Known prefixes are listed explicitly instead of relying on one clever
// catch-all: a precise pattern that misses a novel shape is recoverable (push
// protection is the backstop), while an over-broad one silently shreds the
// `<task-id>`/`<tool-use-id>` correlation values the whole corpus exists to
// exercise. The trailing generic rule covers long base64-ish blobs and cannot
// match `toolu_…` ids, which carry an underscore inside the first 40 chars.
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic / OpenAI / OpenRouter
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{24,}/g,
  // Stripe uses an UNDERSCORE, so the hyphenated `sk-` rule above misses it.
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // Forges and registries
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  // Clouds
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Structural credential shapes that no vendor prefix covers, and that GitHub
  // push protection does NOT catch — it only scans partner patterns, so a plain
  // password or a DB URL would sail through. Free-typed prose is exactly where
  // those appear.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/g,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Long opaque blobs. `/` is deliberately EXCLUDED from the class: including
  // it made long separator-free filesystem paths match, and the corpus shipped
  // with `/⟨secret-redacted⟩-code/claude-images/…` where a real path had been
  // shredded. Base64 payloads in this corpus are not path-shaped.
  /\b[A-Za-z0-9+]{50,}={0,2}\b/g,
]

const SECRET_PLACEHOLDER = '⟨secret-redacted⟩'

function stripSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET_PLACEHOLDER)
  return out
}

// DETECTION-ONLY patterns — deliberately BROADER than what `stripSecrets`
// removes, which is the only way this gate can ever fire.
//
// The earlier version re-applied SECRET_PATTERNS to output that `stripSecrets`
// had just run the same patterns over. That is structurally incapable of
// reporting a hit: adding a shape to the list makes the stripper remove it
// first. It was a gate that could only ever say yes, described in catalog.md as
// an "independent" check. These patterns catch credential-ISH shapes we do not
// auto-strip (because auto-stripping them would shred legitimate content), so a
// human has to look. That is a real gate: it can fail.
const SUSPICIOUS_SHAPES: RegExp[] = [
  // Bare 32/40/64-char hex — hashes, but also plenty of secrets. Not stripped:
  // git SHAs and content hashes are legitimate and common in this corpus.
  /\b[a-f0-9]{40}\b/g,
  /\b[a-f0-9]{64}\b/g,
  // `Bearer <something long>` in prose.
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g,
  // Anything still shaped like an assignment to a credential-ish name.
  /\b(?:token|credential|private[_-]?key)\s*[:=]\s*["']?[^\s"',;]{12,}/gi,
]

/**
 * Suspicious-but-unstripped runs. Empty ⇒ safe to write.
 *
 * Not a duplicate of `stripSecrets`: these shapes are reported, never removed,
 * precisely because removing them automatically would destroy legitimate
 * content (a git SHA is not a secret). A hit means a human decides.
 */
export function findSecretShapes(node: unknown): string[] {
  const hits: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const re of SUSPICIOUS_SHAPES) {
        const m = v.match(new RegExp(re.source, re.flags))
        if (m) hits.push(...m.map(s => `${s.slice(0, 12)}…`))
      }
      return
    }
    if (Array.isArray(v)) return void v.forEach(walk)
    if (v && typeof v === 'object') return void Object.values(v).forEach(walk)
  }
  walk(node)
  return hits
}

/** Home paths leak the operator's username into a committed fixture. */
function anonymize(text: string): string {
  let out = text.split(HOME).join('~').split(HOME_SLUG).join('~user')
  if (USERNAME.length >= 3) out = out.split(USERNAME).join('user')
  // The machine hostname carries the operator's first name straight through the
  // three-form username substitution above — captured shell prompts embed
  // `user@Hostname`, and 7 of those shipped in the first corpus. Anonymizing
  // the username while leaving the hostname defeats the point of doing either.
  if (HOSTNAME.length >= 3) out = out.split(HOSTNAME).join('host')
  const bare = HOSTNAME.split('.')[0] ?? ''
  if (bare.length >= 3 && bare !== HOSTNAME) out = out.split(bare).join('host')
  return stripSecrets(out)
}

function cap(text: string, limit: number): string {
  // Strip `<result>` BEFORE capping, not after. `<result>` is the only large
  // field and it sits before `<summary>`; capping first pushed the closing
  // `</summary>` past the limit and silently changed the item's derived
  // priority. Order is the fix; NOTIFICATION_CONTENT_CAP is the headroom.
  const stripped = isNotification(text) ? stripResultBodies(text) : text
  const a = anonymize(stripped)
  return a.length <= limit ? a : `${a.slice(0, limit)}…⟨capped⟩`
}

function userTextOf(v: Record<string, unknown>): string | null {
  if (v.type !== 'user') return null
  const message = v.message as { role?: string; content?: unknown } | undefined
  if (message?.role !== 'user') return null
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find(
      b => (b as { type?: string } | null)?.type === 'text',
    ) as { text?: string } | undefined
    return typeof block?.text === 'string' ? block.text : null
  }
  return null
}

// PROSE PSEUDONYMIZATION.
//
// The corpus needs the STRUCTURE of a real session — the op sequence, the
// interleaving of departures and committed entries, and which entry claims
// which enqueued item. It does not need the operator's actual writing, and the
// first version of this corpus would have published ~283k characters of it to
// a public repository: prompts from unrelated projects, personal configuration,
// half-formed thinking. None of that is evidence about a queue.
//
// So every free-typed prompt is replaced by a stable synthetic token, and the
// committed entry that delivered it is replaced by the SAME token. The
// reconciler matches on `normalizeForMatch(committed).includes(prefix48(enqueued))`,
// so identical substitution on both sides preserves every matching decision
// exactly — which is verified by diffing the reconciler's decision log before
// and after substitution, not assumed.
//
// Machine-generated `<task-notification>` payloads pass through verbatim:
// their `<task-id>` IS the identity the reconciler correlates on, they contain
// no free-typed text, and mangling them would gut the corpus.
const PROMPT_MATCH_PREFIX = 48

function normalizeForMatch(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function syntheticPrompt(index: number): string {
  // Deliberately longer than PROMPT_MATCH_PREFIX so the prefix match still has
  // something distinctive to bite on, and unique per index so two different
  // recorded prompts never collapse into one and silently change attribution.
  return `synthetic queued prompt ${String(index).padStart(3, '0')} — recorded operator text removed, structure preserved`
}

/** Replace every free-typed prompt with a stable synthetic token, on both sides. */
function pseudonymizeProse(events: FixtureEvent[]): FixtureEvent[] {
  const tokenByNormalized = new Map<string, string>()
  let next = 0
  for (const e of events) {
    if (e.kind !== 'op' || typeof e.content !== 'string') continue
    if (isNotification(e.content)) continue
    const key = normalizeForMatch(e.content)
    if (key.length === 0 || tokenByNormalized.has(key)) continue
    tokenByNormalized.set(key, syntheticPrompt(next++))
  }

  const prefixes = [...tokenByNormalized.entries()].map(([k, token]) => ({
    prefix: k.slice(0, PROMPT_MATCH_PREFIX),
    token,
  }))

  return events.map(e => {
    if (e.kind === 'op') {
      if (typeof e.content !== 'string') return e
      if (isNotification(e.content)) return { ...e, content: stripResultBodies(e.content) }
      const token = tokenByNormalized.get(normalizeForMatch(e.content))
      return token ? { ...e, content: token } : { ...e, content: syntheticPrompt(next++) }
    }
    // A committed notification entry is the delivery evidence — keep it exact.
    if (isNotification(e.text)) return { ...e, text: stripResultBodies(e.text) }
    const hay = normalizeForMatch(e.text)
    const hit = prefixes.find(p => p.prefix.length > 0 && hay.includes(p.prefix))
    return {
      ...e,
      // Non-delivery turns become an inert filler: they must remain present
      // (they advance the settle window that bounds a dequeue debt) but must
      // not accidentally match anything.
      text: hit ? hit.token : '⟨unrelated turn — text removed⟩',
    }
  })
}

function isNotification(text: string): boolean {
  return text.trimStart().startsWith('<task-notification>')
}

/**
 * Drop the `<result>` body from a notification.
 *
 * It is the only free-form field in an otherwise machine-generated payload —
 * a subagent's entire written report — and the reconciler never reads it. It
 * correlates on `<task-id>` and derives priority from `<summary>` plus the
 * presence of `<status>`. Keeping the body would publish agent-authored prose
 * about whatever the session happened to be doing and inflate the corpus for
 * zero decision value. The tag itself is preserved so the payload keeps its
 * real shape.
 */
function stripResultBodies(text: string): string {
  const REPLACEMENT = '<result>⟨result body removed — not read by the reconciler⟩</result>'
  // Two forms, and missing the second left 139 partial bodies in the corpus:
  // capping runs BEFORE this, so a long notification is frequently truncated
  // mid-`<result>` and has no closing tag left to anchor on. Strip to the end
  // of the string in that case.
  if (/<result>[\s\S]*<\/result>/.test(text)) {
    return text.replace(/<result>[\s\S]*<\/result>/, REPLACEMENT)
  }
  return text.replace(/<result>[\s\S]*$/, REPLACEMENT)
}

export function buildFixture(
  jsonl: string,
  source: string,
  note: string,
): { fixture: QueueOperationFixture; raw: Array<{ op: string; content?: string }> } {
  const events: FixtureEvent[] = []
  const raw: Array<{ op: string; content?: string }> = []
  for (const line of jsonl.split('\n')) {
    if (!line) continue
    let v: Record<string, unknown>
    try {
      v = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (v.type === 'queue-operation') {
      const op = typeof v.operation === 'string' ? v.operation : 'unknown'
      const content =
        typeof v.content === 'string'
          ? cap(v.content, isNotification(v.content) ? NOTIFICATION_CONTENT_CAP : ENQUEUE_CONTENT_CAP)
          : undefined
      const timestamp = typeof v.timestamp === 'string' ? v.timestamp : undefined
      raw.push({ op, content: typeof v.content === 'string' ? v.content : undefined })
      events.push({ kind: 'op', op, ...(content !== undefined && { content }), ...(timestamp && { timestamp }) })
      continue
    }
    const text = userTextOf(v)
    // Only keep user entries once at least one op has been seen. Everything
    // before the first enqueue cannot explain a departure and is pure bulk.
    if (text !== null && events.length > 0) {
      events.push({
        kind: 'user',
        uuid: typeof v.uuid === 'string' ? v.uuid : undefined,
        text: cap(text, isNotification(text) ? NOTIFICATION_CONTENT_CAP : USER_TEXT_CAP),
      })
    }
  }
  return {
    fixture: { source: anonymize(source), note, events: pseudonymizeProse(events) },
    raw,
  }
}

/**
 * The corpus must not change any priority the reconciler would derive.
 *
 * This is the gate the first version lacked. Redaction, capping and
 * pseudonymization all rewrite content, and `derivePriority` reads that
 * content — so any of them can silently re-score an item. It happened: capping
 * at 600 truncated `</summary>` and flipped two background commands to `later`,
 * encoding the reported bug into the fixtures.
 *
 * `derivePriority` is IMPORTED from the reconciler rather than reimplemented,
 * so the check cannot drift from the thing it is checking.
 */
function assertNoPriorityDrift(
  raw: Array<{ op: string; content?: string }>,
  fixture: QueueOperationFixture,
  slug: string,
): void {
  const rawEnqueues = raw.filter(r => r.op === 'enqueue' && typeof r.content === 'string')
  const outEnqueues = fixture.events.filter(
    (e): e is Extract<FixtureEvent, { kind: 'op' }> => e.kind === 'op' && e.op === 'enqueue',
  )
  if (rawEnqueues.length !== outEnqueues.length) {
    throw new Error(
      `refusing to emit ${slug}: enqueue count changed (${rawEnqueues.length} → ${outEnqueues.length})`,
    )
  }
  const drifted: string[] = []
  for (const [i, r] of rawEnqueues.entries()) {
    const before = derivePriority(r.content!)
    const after = derivePriority(outEnqueues[i]!.content ?? '')
    // Prompts are pseudonymized by design and both forms derive `next`; a
    // notification changing priority means redaction ate a load-bearing field.
    if (before !== after) {
      drifted.push(`[${i}] ${before} → ${after}: ${r.content!.slice(0, 90).replace(/\s+/g, ' ')}`)
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      `refusing to emit ${slug}: redaction changed ${drifted.length} derived priorit(ies).\n` +
        drifted.slice(0, 5).join('\n') +
        `\nA fixture that mis-encodes priority reads as ratification of the bug.`,
    )
  }
}

function emit(fixture: QueueOperationFixture, slug: string): void {
  const survivors = findSensitiveSurvivors(fixture)
  if (survivors.length > 0) {
    throw new Error(
      `refusing to emit ${slug}: ${survivors.length} sensitive value(s) survived redaction ` +
        `(${survivors.slice(0, 5).join(', ')}). Fix the redactor, never the gate.`,
    )
  }
  // Second, value-shaped gate. The key-based one above cannot see a secret
  // pasted into prose, which is exactly what queue content is.
  const secrets = findSecretShapes(fixture)
  if (secrets.length > 0) {
    throw new Error(
      `refusing to emit ${slug}: ${secrets.length} secret-shaped value(s) survived redaction ` +
        `(${secrets.slice(0, 5).join(', ')}). Add the shape to SECRET_PATTERNS.`,
    )
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, `${slug}.json`), `${JSON.stringify(fixture, null, 2)}\n`)
  const ops = fixture.events.filter(e => e.kind === 'op').length
  const users = fixture.events.filter(e => e.kind === 'user').length
  console.log(`  ${slug}.json  (${ops} ops, ${users} user entries)`)
}

/** `<session-uuid-prefix>` → the transcript path, searched under ~/.claude/projects. */
function findTranscript(idPrefix: string): string | null {
  const root = join(HOME, '.claude', 'projects')
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.startsWith(idPrefix) && e.name.endsWith('.jsonl')) return full
    }
  }
  return null
}

// The named cases from the plan (§4 divergence sessions + the one popAll
// sighting). Each carries WHY it is in the corpus, because a fixture whose
// purpose is not recorded gets deleted by the next person who sees it fail.
const CASES: Array<{ id: string; slug: string; note: string }> = [
  {
    id: '80473d26',
    slug: 'divergence-stranded-background-commands',
    note:
      'Reconstruction ends holding two "Background command …" notifications while Claude\'s ' +
      'queue held two "Agent … finished". The reported bug: mixed next/later cohort, one ' +
      'remove, wrong victim. 166 enqueues / 91 dequeues / 73 removes, background-dominant ' +
      '(147 background vs 16 agent).',
  },
  {
    id: '606c672f',
    slug: 'divergence-agent-dominant',
    note:
      'The mirror of the above: 87 agent completions against 10 background commands, ' +
      '175 enqueues / 91 dequeues / 84 removes. Pins that the later-priority cohort is not ' +
      'over-drained when it dominates.',
  },
  {
    id: '86cf6025',
    slug: 'remove-dominant-balanced-mix',
    note:
      'Remove-dominant (21 removes vs 15 dequeues) with a balanced mix (22 background, ' +
      '19 agent) — the profile that made query.ts:1642 the real emit site rather than the ' +
      'Ctrl+B path.',
  },
  {
    id: '4d4c8b1a',
    slug: 'remove-is-not-persisted',
    note:
      'Ground truth for the dequeue/remove asymmetry: `dequeue` is followed by a user entry ' +
      'carrying the notification verbatim; `remove` is followed by nothing, because the ' +
      'mid-turn attachment drain is never written to the transcript.',
  },
]

// SOURCE GUARD: only this repository's own sessions may enter the corpus.
//
// The fixtures are committed to a public repository. A transcript from any
// other project is the operator's unrelated work — different clients, different
// codebases, personal material — and none of it is evidence about Claude's
// queue that an agent-code session cannot supply just as well. The first
// version of this corpus drew from three unrelated projects; this guard is why
// that cannot recur silently.
//
// Combined with prose pseudonymization above, the published fixture carries
// session STRUCTURE and machine-generated notification payloads, and no
// free-typed text from any project.
function isAgentCodeTranscript(path: string): boolean {
  const project = dirname(path).split('/').pop() ?? ''
  return project.includes('agent-code')
}

/**
 * `--measure` — recompute every number the catalog quotes, from the local
 * transcripts, and print them.
 *
 * WHY this exists: the catalog and the design doc quote measurements as fact,
 * and four shipped source comments quote them back. None of it was re-derivable
 * — a reviewer had to reimplement the measurement from scratch to check any of
 * it, and found two figures that did not reproduce. A doc whose whole purpose is
 * to stop future-you re-deriving something is worthless if future-you must
 * re-derive it to trust it. This is the cross-check Stage 1 claimed.
 *
 * The numbers move as the local corpus grows; the point is reproducibility of
 * the METHOD, so treat a small drift as expected and a large one as a finding.
 */
function measure(): void {
  const root = join(HOME, '.claude', 'projects')
  const files: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full)
    }
  }

  const ops: Record<string, number> = {}
  const runs: Record<string, number> = {}
  const multiRuns: Record<string, number> = {}
  let withOps = 0
  let enqueueTotal = 0
  let enqueueWithContent = 0
  let notifTotal = 0
  let notifWithId = 0
  let queuedCommandTotal = 0
  let queuedCommandWithUuid = 0
  let queuedCommandWithTimestamp = 0
  let queuedCommandExternal = 0
  let queuedCommandPrompt = 0
  let queuedCommandNotification = 0
  let queuedCommandHuman = 0
  let queuedCommandPeerMeta = 0
  let queuedCommandLegacyPrompt = 0
  let queuedCommandStringPrompt = 0
  let queuedCommandBlockPrompt = 0
  const queuedCommandVersions = new Set<string>()

  for (const f of files) {
    let raw: string
    try {
      raw = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const carriesQueueOps = raw.includes('"queue-operation"')
    if (carriesQueueOps) withOps += 1
    const seq: string[] = []
    for (const line of raw.split('\n')) {
      // These literals are the only families this measurement owns. The cheap
      // gate avoids parsing every unrelated transcript line in a large corpus.
      if (
        !line.includes('queue-operation') &&
        !line.includes('queued_command')
      ) {
        continue
      }
      let v: Record<string, unknown>
      try {
        v = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const attachment = v.attachment as Record<string, unknown> | undefined
      if (v.type === 'attachment' && attachment?.type === 'queued_command') {
        queuedCommandTotal += 1
        if (typeof v.uuid === 'string' && v.uuid.length > 0) {
          queuedCommandWithUuid += 1
        }
        if (typeof v.timestamp === 'string' && v.timestamp.length > 0) {
          queuedCommandWithTimestamp += 1
        }
        if (v.userType === 'external') queuedCommandExternal += 1
        if (typeof v.version === 'string') queuedCommandVersions.add(v.version)

        const mode = attachment.commandMode
        if (mode === 'prompt') {
          queuedCommandPrompt += 1
          const origin = attachment.origin as Record<string, unknown> | undefined
          const isMeta = attachment.isMeta === true || v.isMeta === true
          if (origin?.kind === 'human') queuedCommandHuman += 1
          else if (origin?.kind === 'peer' && isMeta) queuedCommandPeerMeta += 1
          else if (origin === undefined && !isMeta) queuedCommandLegacyPrompt += 1
        } else if (mode === 'task-notification') {
          queuedCommandNotification += 1
        }

        if (typeof attachment.prompt === 'string') queuedCommandStringPrompt += 1
        else if (Array.isArray(attachment.prompt)) queuedCommandBlockPrompt += 1
        continue
      }
      if (v.type !== 'queue-operation') continue
      const op = String(v.operation)
      ops[op] = (ops[op] ?? 0) + 1
      seq.push(op)
      if (op === 'enqueue') {
        enqueueTotal += 1
        if (typeof v.content === 'string') {
          enqueueWithContent += 1
          if (v.content.trimStart().startsWith('<task-notification>')) {
            notifTotal += 1
            if (/<task-id>|<tool-use-id>/.test(v.content)) notifWithId += 1
          }
        }
      }
    }
    for (let i = 0; i < seq.length; ) {
      let j = i
      while (j < seq.length && seq[j] === seq[i]) j++
      const op = seq[i]!
      runs[op] = (runs[op] ?? 0) + 1
      if (j - i > 1) multiRuns[op] = (multiRuns[op] ?? 0) + 1
      i = j
    }
  }

  console.log(`transcripts scanned: ${files.length}`)
  console.log(`transcripts carrying queue ops: ${withOps}\n`)
  for (const op of Object.keys(ops).sort()) {
    const r = runs[op] ?? 0
    const m = multiRuns[op] ?? 0
    console.log(
      `${op.padEnd(8)}: ${String(ops[op]).padStart(5)} records / ${String(r).padStart(4)} runs ` +
        `(${((100 * m) / (r || 1)).toFixed(1)}% multi-item)`,
    )
  }
  console.log(`\nenqueue content present: ${enqueueWithContent}/${enqueueTotal}`)
  console.log(`notifications carrying a correlation id: ${notifWithId}/${notifTotal}`)
  const versions = [...queuedCommandVersions].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
  console.log(`\nqueued_command attachments: ${queuedCommandTotal}`)
  console.log(
    `  durable identity: uuid ${queuedCommandWithUuid}/${queuedCommandTotal}, ` +
      `timestamp ${queuedCommandWithTimestamp}/${queuedCommandTotal}, ` +
      `external user ${queuedCommandExternal}/${queuedCommandTotal}`,
  )
  console.log(
    `  mode: prompt ${queuedCommandPrompt}, task-notification ${queuedCommandNotification}`,
  )
  console.log(
    `  prompt provenance: human ${queuedCommandHuman}, ` +
      `legacy-no-origin ${queuedCommandLegacyPrompt}, peer-meta ${queuedCommandPeerMeta}`,
  )
  console.log(
    `  prompt shape: string ${queuedCommandStringPrompt}, block-array ${queuedCommandBlockPrompt}`,
  )
  console.log(
    `  versions: ${versions.length} (${versions[0] ?? 'none'} → ${versions.at(-1) ?? 'none'})`,
  )
}

function main(): void {
  if (process.argv.includes('--measure')) {
    measure()
    return
  }
  console.log(`extracting queue-operation fixtures → testing/fixtures/queue-operations/`)
  let emitted = 0
  for (const c of CASES) {
    const path = findTranscript(c.id)
    if (!path) {
      console.log(`  (skip ${c.slug}: no local transcript matching ${c.id})`)
      continue
    }
    if (!isAgentCodeTranscript(path)) {
      throw new Error(
        `refusing to emit ${c.slug}: ${path} is not an agent-code session. ` +
          `The corpus is published; only this repository's own transcripts may enter it.`,
      )
    }
    const size = statSync(path).size
    if (size > 200 * 1024 * 1024) {
      console.log(`  (skip ${c.slug}: transcript is ${Math.round(size / 1e6)}MB)`)
      continue
    }
    const built = buildFixture(readFileSync(path, 'utf8'), path, c.note)
    assertNoPriorityDrift(built.raw, built.fixture, c.slug)
    emit(built.fixture, c.slug)
    emitted += 1
  }
  console.log(`\n${emitted}/${CASES.length} fixtures emitted.`)
  if (emitted === 0) {
    console.log('No local transcripts matched. The checked-in fixtures remain the corpus.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
