// User-managed MCP servers (#1143). Design: docs/superpowers/specs/
// 2026-09-22-user-mcp-servers-design.md — read its Evidence section before
// changing any rule here; each one is pinned to a CLI behavior.

/**
 * Providers that can receive a user MCP server today.
 *
 * WHY only Claude and Codex (not every AgentProviderKind): these are the two
 * launchers whose MCP injection semantics were verified against their source
 * and installed binaries. OpenCode and Grok also carry built-in MCP, but a user
 * server there needs its own translator and evidence. Keeping this list closed
 * means a new provider shows an honest "not supported yet" instead of silently
 * receiving a config shape nobody checked.
 */
export const USER_MCP_PROVIDERS = ['claude', 'codex'] as const
export type UserMcpProvider = (typeof USER_MCP_PROVIDERS)[number]

export function isUserMcpProvider(value: unknown): value is UserMcpProvider {
  return typeof value === 'string' && (USER_MCP_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Server names Agent Code already owns on every launch. `agent_code` is the
 * built-in host's entry (BuiltInMcpHttpHost.serverConfig) and
 * `agent-code-control` is denied/disabled for every provider by
 * externalControlExclusion. A user entry with either name would replace or be
 * replaced by ours: Claude's `--mcp-config` swaps whole entries and Codex
 * deep-merges keys, so neither outcome is a usable server.
 */
export const RESERVED_USER_MCP_NAMES = ['agent_code', 'agent-code-control'] as const

/**
 * The de facto `mcpServers` entry, as server READMEs publish it.
 *
 * WHY we store the published shape instead of a normalized internal one: a
 * user adds a server by pasting its README snippet, and later wants to copy it
 * back out. A lossless round trip is only possible if our storage IS that
 * shape. Unknown keys (Claude's `oauth`, `headersHelper`, a client's `timeout`)
 * are therefore kept on the object even though no type names them — the index
 * signature is deliberate, not laziness.
 */
export type UserMcpStdioEntry = {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  [extra: string]: unknown
}

export type UserMcpRemoteEntry = {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  [extra: string]: unknown
}

export type UserMcpServerEntry = UserMcpStdioEntry | UserMcpRemoteEntry

export type UserMcpTransport = 'stdio' | 'http' | 'sse'

/** A secret the entry references as `${input:<id>}`. Only the definition is
 * stored in the document; the value lives in main's safeStorage blobs. */
export type UserMcpInput = {
  id: string
  description: string
}

export type UserMcpServer = {
  /** Stable identity. Per-agent overrides and secrets key on this, never on
   * the name, so renaming a server keeps every agent's choice attached. */
  id: string
  /** Provider-visible server name (tool names become `mcp__<name>__<tool>`). */
  name: string
  /** Master switch. Off means off for every agent, whatever it overrides. */
  enabled: boolean
  /** Whether NEW agents of each provider get it by default. */
  providers: Record<UserMcpProvider, boolean>
  entry: UserMcpServerEntry
  inputs: UserMcpInput[]
}

export type UserMcpDocument = {
  version: 1
  servers: UserMcpServer[]
}

export type UserMcpProblem =
  | { kind: 'invalid-name'; message: string }
  | { kind: 'reserved-name'; message: string }
  | { kind: 'duplicate-name'; message: string }
  | { kind: 'invalid-entry'; message: string }
  | { kind: 'secret-in-forbidden-field'; message: string }
  | { kind: 'unknown-input'; message: string }
  | { kind: 'secret-missing'; message: string }

export type UserMcpSupport = { ok: true } | { ok: false; reason: string }

export type UserMcpSecretState = { set: boolean; hint?: string }

/** What crosses IPC to the renderer. Never contains a secret value. */
export type UserMcpServerView = UserMcpServer & {
  transport: UserMcpTransport | null
  /** One-line summary for list rows (`localhost:23373/v0/mcp`, `npx -y pkg`). */
  summary: string
  secrets: Record<string, UserMcpSecretState>
  problems: UserMcpProblem[]
  support: Record<UserMcpProvider, UserMcpSupport>
}

/** A server the CLI loads from its own config, shown read-only. */
export type NativeMcpServer = {
  provider: UserMcpProvider
  name: string
  /** Display path of the file it came from, `~`-abbreviated. */
  source: string
  transport: UserMcpTransport | null
  summary: string
  /** Whether Copy in can express this entry as a managed server. The entry
   * itself stays in main (review round 1): native configs routinely hold
   * tokens in args and URLs as well as env/headers, and this snapshot crosses
   * IPC to every window and, via mcp_servers_list, to agents. Copy in runs in
   * main from main's own read. */
  copyable: boolean
}

/** Main-only form of a native server, with what Copy in needs. Every env and
 * header VALUE is already replaced by an `${input:…}` reference. */
export type NativeMcpServerSource = NativeMcpServer & {
  entry: UserMcpServerEntry | null
  inputs: UserMcpInput[]
}

export type UserMcpSnapshot = {
  servers: UserMcpServerView[]
  native: NativeMcpServer[]
  /** Set when the document on disk could not be read. The file is preserved
   * beside the new one, so this is a notice, not data loss. */
  storeProblem?: string
  /** Claude's enterprise managed-mcp.json is present: Claude refuses any
   * non-SDK `--mcp-config` server, so user servers are held back for Claude. */
  claudeManagedPolicy: boolean
}

export type UserMcpSaveInput = {
  id?: string
  name: string
  enabled: boolean
  providers: Record<UserMcpProvider, boolean>
  entry: UserMcpServerEntry
  inputs: UserMcpInput[]
  /** Secret values to set with this save (inputId → value). Values for inputs
   * not listed stay as they are; an empty string clears. */
  secrets?: Record<string, string>
}

export type UserMcpMutationResult =
  /** `secretsCleared`: the save changed where the server connects, so its
   * previously stored secrets were forgotten (see UserMcpService.save). */
  | { ok: true; snapshot: UserMcpSnapshot; id?: string; secretsCleared?: boolean }
  | { ok: false; error: string; problems?: UserMcpProblem[] }

export type UserMcpImportCandidate = {
  name: string
  entry: UserMcpServerEntry
  inputs: UserMcpInput[]
  /** Values lifted out of the pasted text into inputs; saved as secrets. */
  pendingSecrets: Record<string, string>
  problems: UserMcpProblem[]
}

export type UserMcpImportResult =
  | { ok: true; candidates: UserMcpImportCandidate[]; format: 'mcpServers' | 'vscode' | 'map' | 'entry' }
  | { ok: false; error: string }

/**
 * Launch material for one user MCP server, produced by main's UserMcpService
 * right before spawn. `secrets` holds decrypted values and exists only for the
 * duration of one launch; it is never persisted, logged, or sent to the
 * renderer. Lives here (not beside the translators) because SessionOptions in
 * shared/types/session.ts carries it to the provider sessions.
 */
export type ResolvedUserMcpServer = {
  id: string
  name: string
  entry: UserMcpServerEntry
  secrets: Record<string, string>
}

/** Why a server was not attached to one launch. */
export type UserMcpDroppedServer = { name: string; reason: string }

export type UserMcpUnavailableEvent = { servers: UserMcpDroppedServer[] }

/**
 * Per-agent overrides for user servers ride in the pane's existing
 * `builtInMcpOverrides` map under this prefix (spec Revision 2 §3).
 *
 * WHY a prefix in the existing map instead of a second map: that map is already
 * threaded through spawn, replace, reload, recovery, undo-close, provider
 * switch, duplicate and the control API. A parallel map would have to be
 * re-threaded through every one of those paths, and missing one silently drops
 * a user's choice. Built-in domain names never contain ':', so the namespaces
 * cannot collide.
 */
export const USER_MCP_OVERRIDE_PREFIX = 'user:'
export type UserMcpOverrideKey = `user:${string}`

export function userMcpOverrideKey(serverId: string): UserMcpOverrideKey {
  return `${USER_MCP_OVERRIDE_PREFIX}${serverId}` as UserMcpOverrideKey
}

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isUserMcpServerId(value: unknown): value is string {
  return typeof value === 'string' && SERVER_ID_PATTERN.test(value)
}

export function isUserMcpOverrideKey(key: string): key is UserMcpOverrideKey {
  return key.startsWith(USER_MCP_OVERRIDE_PREFIX)
    && isUserMcpServerId(key.slice(USER_MCP_OVERRIDE_PREFIX.length))
}

/** The `user:` subset of a pane override map, keyed by bare server id — the
 * shape that crosses IPC to main with spawn/recover. */
export function userMcpOverridesFrom(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, choice] of Object.entries(value as Record<string, unknown>)) {
    if (typeof choice !== 'boolean' || !isUserMcpOverrideKey(key)) continue
    result[key.slice(USER_MCP_OVERRIDE_PREFIX.length)] = choice
  }
  return result
}

/** Validates the IPC form (bare ids) coming from an untrusted renderer. */
export function normalizeUserMcpOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [id, choice] of Object.entries(value as Record<string, unknown>)) {
    if (typeof choice === 'boolean' && isUserMcpServerId(id)) result[id] = choice
  }
  return result
}
