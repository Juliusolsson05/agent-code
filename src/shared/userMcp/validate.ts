import { hasInputReference, inputReferences, USER_MCP_INPUT_ID_PATTERN } from './inputs.js'
import {
  RESERVED_USER_MCP_NAMES,
  USER_MCP_PROVIDERS,
  isUserMcpServerId,
  type UserMcpDocument,
  type UserMcpInput,
  type UserMcpProblem,
  type UserMcpProvider,
  type UserMcpServer,
  type UserMcpServerEntry,
  type UserMcpSupport,
  type UserMcpTransport,
} from './types.js'

/**
 * `[A-Za-z0-9_-]`, 1–64 chars.
 *
 * WHY this exact charset: it is the intersection of what both CLIs accept AND
 * what survives Codex's `-c` override parser. Claude's `mcp add` enforces
 * `[A-Za-z0-9_-]`. Codex accepts more (`:@/.`) in config.toml, but `-c
 * mcp_servers.<name>.url=…` splits the key path on '.' naively and never
 * unquotes a quoted segment (codex-rs config/src/overrides.rs), so any wider
 * name would silently target the wrong table.
 *
 * WHY no automatic `ac-` prefix to avoid collisions: tool names become
 * `mcp__<server>__<tool>`, which users copy into permission rules from server
 * docs. A prefix would break every documented rule. Collisions are instead
 * detected (reserved names here, native Codex names at launch).
 */
export const USER_MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function transportOf(entry: unknown): UserMcpTransport | null {
  if (!isPlainObject(entry)) return null
  const hasCommand = typeof entry.command === 'string'
  const hasUrl = typeof entry.url === 'string'
  if (entry.type === 'stdio') return hasCommand && !hasUrl ? 'stdio' : null
  if (entry.type === 'http' || entry.type === 'sse') return hasUrl && !hasCommand ? entry.type : null
  // Entries without `type` are the common README shape. A url-only entry means
  // Streamable HTTP — Claude Desktop/Cursor behavior and the current transport;
  // SSE servers publish `"type": "sse"` because SSE is the deprecated one.
  if (entry.type === undefined) {
    if (hasCommand && !hasUrl) return 'stdio'
    if (hasUrl && !hasCommand) return 'http'
  }
  return null
}

/**
 * Canonical stored form: explicit `type` for remote entries so the Codex and
 * Claude translators never re-derive it, but stdio keeps whatever the user
 * pasted (`type` omitted or `"stdio"`) — both are valid everywhere.
 */
export function normalizeEntry(entry: UserMcpServerEntry): UserMcpServerEntry {
  const transport = transportOf(entry)
  if ((transport === 'http' || transport === 'sse') && entry.type === undefined) {
    return { ...entry, type: transport } as unknown as UserMcpServerEntry
  }
  return entry
}

export function validateEntry(entry: unknown): UserMcpProblem[] {
  if (!isPlainObject(entry)) {
    return [{ kind: 'invalid-entry', message: 'The server config must be a JSON object.' }]
  }
  const transport = transportOf(entry)
  if (!transport) {
    if (typeof entry.command === 'string' && typeof entry.url === 'string') {
      return [{ kind: 'invalid-entry', message: 'Use either "command" (stdio) or "url" (http/sse), not both.' }]
    }
    if (entry.type !== undefined && !['stdio', 'http', 'sse'].includes(String(entry.type))) {
      return [{ kind: 'invalid-entry', message: `Unsupported transport type "${String(entry.type)}". Use stdio, http or sse.` }]
    }
    return [{ kind: 'invalid-entry', message: 'Add "command" for a local (stdio) server or "url" for a remote one.' }]
  }
  const problems: UserMcpProblem[] = []
  if (transport === 'stdio') {
    if (!(entry.command as string).trim()) {
      problems.push({ kind: 'invalid-entry', message: '"command" cannot be empty.' })
    }
    if (entry.args !== undefined && !isStringArray(entry.args)) {
      problems.push({ kind: 'invalid-entry', message: '"args" must be an array of strings.' })
    }
    if (entry.env !== undefined && !isStringRecord(entry.env)) {
      problems.push({ kind: 'invalid-entry', message: '"env" must map names to string values.' })
    } else if (isStringRecord(entry.env)) {
      const bad = Object.keys(entry.env).find(key => !USER_MCP_ENV_KEY_PATTERN.test(key))
      if (bad !== undefined) problems.push({ kind: 'invalid-entry', message: `"${bad}" is not a valid environment variable name.` })
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') {
      problems.push({ kind: 'invalid-entry', message: '"cwd" must be a string.' })
    }
  } else {
    if (!isHttpUrl(entry.url as string)) {
      problems.push({ kind: 'invalid-entry', message: '"url" must be an absolute http(s) URL.' })
    }
    if (entry.headers !== undefined && !isStringRecord(entry.headers)) {
      problems.push({ kind: 'invalid-entry', message: '"headers" must map names to string values.' })
    } else if (isStringRecord(entry.headers)) {
      const bad = Object.keys(entry.headers).find(key => !USER_MCP_HEADER_NAME_PATTERN.test(key))
      if (bad !== undefined) problems.push({ kind: 'invalid-entry', message: `"${bad}" is not a valid header name (no dots or spaces).` })
    }
  }
  problems.push(...forbiddenSecretProblems(entry))
  return problems
}

/**
 * `${input:…}` is only allowed in env and header VALUES.
 *
 * WHY: Codex does not expand variables in `command`, `args` or `url`, so a
 * secret there has to be written literally into a `-c` override — i.e. into
 * the Codex process's argv, readable by any local process via `ps` and by our
 * own incident collectors. Env and header values can always travel through the
 * environment instead (`env_vars`, `env_http_headers`, Claude's `${VAR}`).
 * Servers that want a token on their own command line (mcp-remote's
 * `--header "Authorization: Bearer ${TOKEN}"`) expand their own environment,
 * so the user writes `${TOKEN}` in args and keeps the secret in `env.TOKEN`.
 */
function forbiddenSecretProblems(entry: Record<string, unknown>): UserMcpProblem[] {
  const problems: UserMcpProblem[] = []
  const check = (field: string, value: unknown) => {
    if (typeof value === 'string' && hasInputReference(value)) {
      problems.push({
        kind: 'secret-in-forbidden-field',
        message: `Secrets can only be used in env or headers values, not in "${field}" (it would be visible to other processes).`,
      })
    }
  }
  check('command', entry.command)
  check('url', entry.url)
  check('cwd', entry.cwd)
  if (Array.isArray(entry.args)) entry.args.forEach(arg => check('args', arg))
  return problems
}

export function referencedInputIds(entry: UserMcpServerEntry): string[] {
  const ids = new Set<string>()
  const scan = (record: unknown) => {
    if (!isStringRecord(record)) return
    for (const value of Object.values(record)) inputReferences(value).forEach(id => ids.add(id))
  }
  scan((entry as Record<string, unknown>).env)
  scan((entry as Record<string, unknown>).headers)
  return [...ids]
}

export function validateServer(
  server: Pick<UserMcpServer, 'name' | 'entry' | 'inputs'>,
  others: readonly Pick<UserMcpServer, 'id' | 'name'>[] = [],
): UserMcpProblem[] {
  const problems: UserMcpProblem[] = []
  if (!USER_MCP_NAME_PATTERN.test(server.name)) {
    problems.push({
      kind: 'invalid-name',
      message: 'Use 1–64 letters, digits, "-" or "_" (other characters break Codex config overrides).',
    })
  }
  if (RESERVED_USER_MCP_NAMES.some(reserved => foldName(reserved) === foldName(server.name))) {
    problems.push({ kind: 'reserved-name', message: `"${server.name}" is reserved for Agent Code's own MCP server.` })
  }
  // Case- and separator-insensitive on purpose. "Beeper" vs "beeper" is a
  // trap for permission rules even where the CLIs would tell them apart, and
  // "my-server" vs "my_server" would map to the same generated secret variable
  // (userMcpSecretVariable upper-cases and folds separators), so the second
  // server's token would silently overwrite the first one's in the launch env.
  const folded = foldName(server.name)
  if (others.some(other => foldName(other.name) === folded)) {
    problems.push({ kind: 'duplicate-name', message: `Another server is already named "${server.name}".` })
  }
  problems.push(...validateEntry(server.entry))
  const defined = new Set(server.inputs.map(input => input.id))
  if (isPlainObject(server.entry)) {
    for (const id of referencedInputIds(server.entry)) {
      if (!defined.has(id)) {
        problems.push({ kind: 'unknown-input', message: `"\${input:${id}}" is used but no secret named "${id}" exists.` })
      }
    }
  }
  return problems
}

/**
 * Environment names Codex itself depends on. A user stdio server's SECRET has
 * to be placed in Codex's own environment (Codex forwards env to MCP children
 * only through an allowlist plus `env_vars` pass-through names, and
 * `env_vars` cannot rename), so a server asking for one of these would
 * silently change how Codex authenticates, finds binaries, or talks to our own
 * MCP host. Lives here, not only in the launcher, so Settings and the
 * per-agent picker show the server as Codex-unsupported instead of it being
 * dropped at every launch with nothing on screen explaining why.
 */
export const CODEX_PROTECTED_ENV = new RegExp('^(' + [
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'TERM',
  'CODEX_.*', 'OPENAI_.*', 'AGENT_CODE_.*',
  // Review round 1: variables that change how the Codex binary (and its npm
  // launcher) itself connects, trusts certificates, loads code or logs.
  'HTTPS?_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_(FILE|DIR)', 'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS', 'RUST_LOG', 'RUST_BACKTRACE', 'DYLD_.*', 'LD_.*',
].join('|') + ')$', 'i')

/**
 * Env keys must be plain identifiers and header names plain HTTP tokens
 * WITHOUT '.'. Codex splits `-c` key paths on every '.', so a dotted key
 * becomes a nested table and fails config load for the whole Codex launch
 * (review round 1, reproduced with codex-cli).
 */
export const USER_MCP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const USER_MCP_HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+^_`|~-]+$/

/** providerSupport plus the rules that depend on the entry, not just its
 * transport. Every UI surface and launch uses this one. */
export function providerSupportForEntry(entry: unknown): Record<UserMcpProvider, UserMcpSupport> {
  const support = providerSupport(transportOf(entry))
  if (support.codex.ok && isPlainObject(entry) && isStringRecord(entry.env)) {
    const protectedKey = Object.entries(entry.env)
      .find(([key, value]) => hasInputReference(value) && CODEX_PROTECTED_ENV.test(key))?.[0]
    if (protectedKey) {
      return { ...support, codex: { ok: false, reason: `Codex cannot pass a secret named ${protectedKey}` } }
    }
  }
  return support
}

/**
 * Everything about an entry except the secret references themselves.
 *
 * WHY the whole entry and not just url/command/args (review round 2): a secret
 * can be exfiltrated without moving it to a new host — add a literal
 * `NODE_OPTIONS=--require ./evil.js` or a `PATH` that finds a fake `npx`, and
 * the unchanged command runs attacker code with the token in its env. The
 * only change that must NOT forget secrets is editing which `${input:…}` a
 * value references, so those values are masked and everything else counts.
 */
export function userMcpDestination(entry: unknown): string {
  if (!isPlainObject(entry)) return 'invalid'
  const masked: Record<string, unknown> = { ...entry, type: transportOf(entry) }
  for (const field of ['env', 'headers'] as const) {
    if (!isStringRecord(entry[field])) continue
    masked[field] = Object.fromEntries(Object.entries(entry[field] as Record<string, string>)
      .map(([key, value]) => [key, hasInputReference(value) ? '<secret>' : value])
      .sort(([a], [b]) => (a as string).localeCompare(b as string)))
  }
  return JSON.stringify(Object.keys(masked).sort().map(key => [key, masked[key]]))
}

/**
 * Secret values may not contain `${`. Claude expands `${VAR}` in every value
 * of an `--mcp-config` server (vendor services/mcp/config.ts expandEnvVars),
 * and since the private file now carries resolved values, a secret containing
 * `${X}` would be rewritten from Agent Code's own environment at launch
 * (review round 2). Real tokens never contain it; a value that does is almost
 * certainly an unfilled template.
 */
export function secretValueProblem(value: string): string | null {
  return value.includes('${') ? 'A secret value cannot contain "${" — paste the actual value, not a variable reference.' : null
}

function foldName(name: string): string {
  return name.toLowerCase().replace(/-/g, '_')
}

export function providerSupport(
  transport: UserMcpTransport | null,
): Record<UserMcpProvider, UserMcpSupport> {
  return {
    claude: { ok: true },
    // Codex speaks stdio and Streamable HTTP only (codex-rs mcp_types.rs has
    // no SSE transport). Claude still accepts SSE, so an SSE server is
    // Claude-only rather than invalid.
    codex: transport === 'sse'
      ? { ok: false, reason: 'Codex does not support SSE servers' }
      : { ok: true },
  }
}

const SENSITIVE_ARG = /(bearer\s|token|secret|passw|api[-_]?key|auth|^sk-|^ghp_|^xox)/i

function redactArg(arg: string): string {
  return arg.length > 40 || SENSITIVE_ARG.test(arg) ? '…' : arg
}

export function summarizeEntry(entry: unknown): string {
  if (!isPlainObject(entry)) return ''
  const transport = transportOf(entry)
  if (transport === 'stdio') {
    const args = isStringArray(entry.args) ? entry.args : []
    // Review round 1: native (and pasted) configs put tokens in args too
    // (`--header "Authorization: Bearer sk-…"`, `--api-key …`). Summaries go
    // to every window and to agents, so anything that looks like a credential
    // or an opaque blob is elided. The full args stay in main.
    // The value AFTER a sensitive flag is elided too (review round 2):
    // `--api-key d6f8g2h9` is short and keyword-free on its own.
    return [entry.command as string, ...args.map((arg, index) =>
      index > 0 && SENSITIVE_ARG.test(args[index - 1]!) && args[index - 1]!.startsWith('-') ? '…' : redactArg(arg))].join(' ')
  }
  if (transport) {
    try {
      const url = new URL(entry.url as string)
      // Review round 1: some servers (Zapier-style) carry the credential in a
      // path segment or the query. Summaries reach the renderer and, through
      // mcp_servers_list, agents, so long opaque segments and the whole query
      // are elided. Short readable paths (`/v0/mcp`) are kept for recognition.
      const path = url.pathname.split('/').map(segment => segment.length > 20 ? '…' : segment).join('/')
      return `${url.host}${path === '/' ? '' : path}${url.search ? '?…' : ''}`
    } catch {
      return '(invalid URL)'
    }
  }
  return ''
}

/**
 * Coerce the persisted document without ever dropping a server the user made.
 *
 * WHY keep malformed servers instead of filtering them: the document is edited
 * by hand, by older builds and by future ones. Deleting an entry because this
 * build could not read one field would lose the user's work silently; keeping
 * it lets validation flag it in Settings and lets main refuse to launch it.
 * Only entries with no usable identity at all (not an object, no id) go.
 */
export function coerceUserMcpDocument(value: unknown): UserMcpDocument {
  if (!isPlainObject(value) || !Array.isArray(value.servers)) return { version: 1, servers: [] }
  const servers: UserMcpServer[] = []
  const seen = new Set<string>()
  for (const raw of value.servers) {
    if (!isPlainObject(raw) || !isUserMcpServerId(raw.id) || seen.has(raw.id)) continue
    seen.add(raw.id)
    const providers = isPlainObject(raw.providers) ? raw.providers : {}
    servers.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : '',
      enabled: raw.enabled !== false,
      providers: Object.fromEntries(
        USER_MCP_PROVIDERS.map(provider => [provider, providers[provider] === true]),
      ) as Record<UserMcpProvider, boolean>,
      // Kept verbatim (including unknown keys); validation reports problems.
      entry: (isPlainObject(raw.entry) ? raw.entry : {}) as UserMcpServerEntry,
      inputs: coerceInputs(raw.inputs),
      // Survives a hand edit or an older build only as `true`: anything else
      // reads as "not pending", which is the conservative direction only
      // because a pending server is also stored disabled.
      ...(raw.pendingReview === true ? { pendingReview: true as const } : {}),
    })
  }
  return { version: 1, servers }
}

export function coerceInputs(value: unknown): UserMcpInput[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const inputs: UserMcpInput[] = []
  for (const raw of value) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !USER_MCP_INPUT_ID_PATTERN.test(raw.id)) continue
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    inputs.push({ id: raw.id, description: typeof raw.description === 'string' ? raw.description : '' })
  }
  return inputs
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every(item => typeof item === 'string')
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
