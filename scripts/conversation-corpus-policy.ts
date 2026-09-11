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
  'message_id', 'parent_id', 'project_id', 'workspace_id',
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
  // App-authored, not private: the title Agent Code gives an OpenCode Terminal
  // session before the user types (src/providers/opencode/runtime/
  // opencodeCliSessions.ts). The adapter classifies on it.
  'Agent Code terminal session',
]

const PLACEHOLDER_RE = /^p:[0-9a-f]{8}:\d+$/
const BRANCH_PLACEHOLDER_RE = /^b:[0-9a-f]{8}$/

/** Idempotent: `--verify-checked-in` re-runs redaction over the committed
 *  corpus and requires a byte-identical result, so a placeholder must map to
 *  itself. */
export function placeholder(text: string): string {
  if (PLACEHOLDER_RE.test(text)) return text
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
/** Claude Code's project-directory sanitizer (sessionStoragePortable.ts
 *  sanitizePath), inlined so this policy stays dependency-free. */
function sanitize(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

export function createPathRewriter(home: string, repoRoot: string): PathRewriter {
  const others = new Map<string, string>()
  const strip = (p: string) => p.replace(/\/+$/, '')
  const HOME = strip(home)
  const REPO = strip(repoRoot)
  const rewrite = (raw: string): string => {
    const fileScheme = raw.startsWith('file://') ? 'file://' : ''
    const path = strip(raw.slice(fileScheme.length))
    // Already rewritten (verification pass over the committed corpus).
    if (path === '/fixture' || path.startsWith('/fixture/')) return raw
    if (path === REPO || path.startsWith(REPO + '/')) return fileScheme + '/fixture/repo' + path.slice(REPO.length)
    if (path === HOME) return fileScheme + '/fixture/home'
    if (path.startsWith(HOME + '/')) {
      const rest = path.slice(HOME.length + 1)
      // Claude project directories are named by the sanitized real cwd, so
      // the directory name itself is a path. Translate the segment the same
      // way the cwd would be: the repo's own prefix becomes -fixture-repo, and
      // anything else under home hashes after the -fixture-home marker.
      if (rest.startsWith('.claude/projects/')) {
        const after = rest.slice('.claude/projects/'.length)
        const slash = after.indexOf('/')
        const segment = slash < 0 ? after : after.slice(0, slash)
        const remainder = slash < 0 ? '' : after.slice(slash)
        const sanitizedRepo = sanitize(REPO)
        const sanitizedHome = sanitize(HOME)
        const translated = segment === sanitizedRepo || segment.startsWith(sanitizedRepo + '-')
          ? '-fixture-repo' + segment.slice(sanitizedRepo.length)
          : segment.startsWith(sanitizedHome)
            ? '-fixture-home-' + placeholder(segment.slice(sanitizedHome.length))
            : segment.startsWith('-fixture-')
              ? segment
              : '-fixture-external-' + placeholder(segment)
        // Inside a project directory only transcript names (uuid.jsonl) and
        // Claude's fixed subdirectories are structural; a memory file or a
        // tool-result name is content.
        const structural = /^([0-9a-f-]{36}(\.jsonl)?|subagents|tool-results|memory|workflows|agent-[0-9a-f]+(\.jsonl|\.meta\.json)?)$/i
        const safeRemainder = remainder.split('/').map(s => (s === '' || structural.test(s) || PLACEHOLDER_RE.test(s) ? s : placeholder(s))).join('/')
        return fileScheme + '/fixture/home/.claude/projects/' + translated + safeRemainder
      }
      // Other provider config roots keep their layout so adapters resolve them.
      if (rest.startsWith('.claude/') || rest.startsWith('.codex/') || rest.startsWith('.local/share/opencode/') || rest.startsWith('.config/agent-code/')) {
        return fileScheme + '/fixture/home/' + rest
      }
      // Everything else under home is another project: number it by its first
      // three segments so a subdirectory maps under the same fixture root.
      // The remainder is hashed segment by segment: directory names inside
      // someone else's project (`bringdown/bringdown-engine`) are as private
      // as the project name itself. Only the family repo keeps real
      // subdirectory names, because they are this public repository's own.
      const segments = rest.split('/')
      const projectKey = segments.slice(0, Math.min(segments.length, 3)).join('/')
      let assigned = others.get(projectKey)
      if (!assigned) {
        assigned = `/fixture/other-${others.size + 1}`
        others.set(projectKey, assigned)
      }
      return fileScheme + assigned + (segments.length > 3 ? '/' + segments.slice(3).map(placeholder).join('/') : '')
    }
    return fileScheme + '/fixture/external/' + placeholder(path)
  }
  return { rewrite, others: () => Object.fromEntries(others) }
}

function redactString(key: string, value: string, paths: PathRewriter): string {
  if (KEEP_VERBATIM_KEYS.has(key)) return value
  if (PATH_KEYS.has(key)) return value.startsWith('/') || value.startsWith('file://') ? paths.rewrite(value) : placeholder(value)
  if (BRANCH_KEYS.has(key)) {
    if (value === 'main' || BRANCH_PLACEHOLDER_RE.test(value)) return value
    return 'b:' + placeholder(value).slice(2, 10)
  }
  for (const prefix of KEPT_WRAPPER_PREFIXES) {
    if (value === prefix) return value
    if (value.startsWith(prefix)) return prefix + placeholder(value.slice(prefix.length))
  }
  return placeholder(value)
}

/** Object keys are structure, except when a provider uses a PATH as a key
 *  (Claude's `trackedFileBackups` is keyed by absolute file path). A key that
 *  looks like a path is rewritten like a path value; any other key longer
 *  than a field name could be is hashed. */
function redactKey(key: string, paths: PathRewriter): string {
  if (key.startsWith('/') || key.startsWith('file://')) return paths.rewrite(key)
  // A relative path or a file name used as a key (`../other-repo/x.ts`,
  // `docs/18-integration.md`) names the user's files just as an absolute one
  // does. Structural keys never contain a slash or a file extension.
  if (key.includes('/') || /\.[a-z0-9]{1,5}$/i.test(key)) return placeholder(key)
  if (key.length > 64) return placeholder(key)
  return key
}

export function redactValue(key: string, value: unknown, paths: PathRewriter): unknown {
  if (typeof value === 'string') return redactString(key, value, paths)
  if (Array.isArray(value)) return value.map(item => redactValue(key, item, paths))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redactKey(k, paths)] = redactValue(k, v, paths)
    return out
  }
  return value
}

export function redactRecord(record: unknown, paths: PathRewriter): unknown {
  return redactValue('', record, paths)
}
