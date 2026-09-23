# User MCP servers — design

Status: draft for review · Date: 2026-09-22 · Branch: `feat/user-mcp-servers`
Issue: #1143 (Refs #244)

## Problem

Agent Code cannot add, configure, or switch off a third-party MCP server. The
only MCP servers it knows about are its own: the `agent_code` built-in host
(TLDR, Goal, orchestration, …) and the reserved `agent-code-control` external
operator server. A user who wants, say, the Beeper Desktop MCP server attached to
their agents today has to leave the app and hand-edit `~/.claude.json` or
`~/.codex/config.toml` (or run `claude mcp add` / `codex mcp add`). They then
get it on *every* agent of that provider, can't switch it off for one agent,
can't see it anywhere in Agent Code, and have to repeat the work per provider.

Wanted: a single place in Agent Code to add **any** MCP server (stdio,
Streamable HTTP, SSE; with secrets; OAuth-capable), choose which providers it
attaches to, override it per agent, and flip it on/off from Settings and the
command palette. The scope is **Claude Code and Codex**. Beeper Desktop is the
worked example and acceptance fixture, not a special case.

This complements the provider enablement feature (#1126, Settings →
Providers). Enablement decides which providers exist in the app, and this
feature decides which user MCP servers each of them gets.

## Evidence this design rests on

The research ran on 2026-09-22 and is summarized here so the next session
doesn't have to redo it.

### What Agent Code does today

- **Built-in MCP.** One loopback Streamable-HTTP host
  (`src/mcp/runtime/BuiltInMcpHttpHost.ts`) mints a per-session bearer and
  returns one `BuiltInMcpServerConfig` named `agent_code`.
  `SessionManager.spawn` (`src/main/sessionManager.ts:2875`) passes
  `builtInMcpServers` into the provider's `createSession`.
- **Per-launch injection, no durable writes**
  (`src/providers/shared/runtime/builtInMcpLaunch.ts`):
  - **Claude** gets a mode-0600 private temp `mcp.json`, passed as
    `--mcp-config <path>` and deleted on stop or rollback
    (`claudeSession.ts:1189-1202`).
  - **Codex** gets `--config mcp_servers.<n>.url=…` plus
    `env_http_headers.<H>="AGENT_CODE_MCP_i_j"`. Values go in the child env,
    never in argv.
  - **OpenCode** gets `OPENCODE_CONFIG_CONTENT` with `{env:…}` references.
- **User-native servers already load.** `--strict-mcp-config` is deliberately
  *not* used. Claude gets a targeted `deniedMcpServers` instead, inside the
  **single** `--settings` value built by `excludeExternalControlFromClaude`
  (`externalControlExclusion.ts:47-60`). Codex keeps the user's `CODEX_HOME`.
  So whatever the user put in `~/.claude.json`, `.mcp.json` or
  `config.toml` still loads, but Agent Code never reads, shows or edits it.
- **Settings model for built-ins.**
  - Global `settings.defaultBuiltInMcpDomains` lives in renderer
    localStorage.
  - Per-pane `builtInMcpOverrides` (absent means inherit, `false` means
    explicit off) is resolved by `resolveSessionBuiltInMcpDomains`
    (`src/renderer/src/workspace/mcpDomains.ts`).
  - The pane's `builtInMcpDomains` is the *observed* launched set, not a
    choice.
  - Changes apply on the next spawn or reload through
    `reloadSessionWithBuiltInMcpOverrides`.
- **Codex `config.toml` writer precedent.** The only writer into provider-owned
  config is `src/main/settings/externalCodexConfig.ts`: a hash-stamped managed
  block, deep-equal proof that nothing else changed, refusal to touch a
  same-name unmanaged server, and observed-compare atomic replace. It is about
  130 lines of safety for **one** server. That cost is why this design does
  not write provider config.
- **Provider enablement (#1126)** is the store/IPC/broadcast pattern to copy:
  - main-owned state with a coerce-on-load setter;
  - `provider-enablement:get|set|reset` IPC plus a
    `provider-enablement:changed` broadcast;
  - a non-persisted zustand mirror in the renderer
    (`features/providers/store.ts`) with a snapshot getter and a hook, synced
    once from `App.tsx`;
  - a self-subscribing settings "marker row" (`ProviderEnablementRow.tsx`).
- **Secrets precedent.** `src/main/dictation/apiKeyStore.ts` uses Electron
  `safeStorage` per-file blobs with no auth prompt; the renderer only sees a
  last-4 hint. The key vault (`src/main/keyVault`) gates every read behind
  Touch ID, which is wrong for secrets resolved during automatic restore.
- **Open issue #244** ("Host user-authored MCP servers as Agent Code
  extensions") is broader: Agent Code *hosting* author-written servers through
  a manifest. This design is the configuration layer #244 needs anyway. A
  hosted extension server can later appear as one more entry in the same list.

### How the CLIs load MCP servers (vendor source + installed claude 2.1.280 / codex-cli 0.155.1)

| | Claude Code | Codex |
|---|---|---|
| Per-launch injection | `--mcp-config <file\|json>…` (variadic, later wins, overrides all file scopes) | `-c mcp_servers.<n>.*=` (TOML-valued, deep-merged SessionFlags layer, precedence 30) |
| Launch vs user entry, same name | Whole entry replaced | **Deep-merged key by key.** A user `command` plus our `url` becomes an invalid mixed-transport config, and the launch fails |
| Transports | stdio, http, sse (deprecated), ws | stdio, streamable HTTP. **No SSE** |
| Secret indirection | `${VAR}` / `${VAR:-d}` expanded in command, args, env, url, headers | No expansion. Use `env_vars=[names]` (stdio), `bearer_token_env_var`, `env_http_headers` |
| stdio child env | Inherits Claude's full env plus `env` | Fixed allowlist (HOME, PATH, …) plus `env_vars` plus literal `env` |
| Name charset | `[A-Za-z0-9_-]` | `[A-Za-z0-9_\-:@/.]`, but `-c` splits paths on `.` naively and never unquotes |
| OAuth | Keychain `mcpOAuth`, key `name\|sha256({type,url,headers})[:16]`. `/mcp` login works for `--mcp-config` servers | Keyring "Codex MCP Credentials", key `name + url`. `codex mcp login` searches the *effective* config, so `-c` servers work |
| Persistent per-server off | `disabledMcpServers` in `~/.claude.json` `projects[gitRoot]`, checked **by name for every scope including `--mcp-config`** | `enabled=false` in config.toml |
| Invalid entry | Process exits 1 | Config load fails, so the launch fails |
| Enterprise lock | `managed-mcp.json` present: non-sdk `--mcp-config` entries are rejected and the process exits | `requirements.toml` allowlist can disable |
| Live reload in TUI | Only on `/clear` or `/reload-plugins` | Not reachable from the TUI |

### Beeper Desktop MCP (worked example)

- **Built in.** Beeper Desktop has its own MCP server (enable it under
  Settings → Developers / Integrations). It runs as Streamable HTTP at
  `http://localhost:23373/v0/mcp`.
- **Auth.** OAuth 2.0 + PKCE is the default. Alternatively
  `Authorization: Bearer <token>` with a token from Settings → Integrations
  → Approved connections, which bypasses OAuth.
- **Official snippets:** `claude mcp add beeper http://localhost:23373/v0/mcp -t http`,
  `codex mcp add beeper --url http://localhost:23373/v0/mcp [--bearer-token-env-var X]`,
  and the generic `{"mcpServers":{"beeper":{"url":…,"headers":{"Authorization":"Bearer …"}}}}`.
- **stdio alternatives:** `npx -y @beeper/mcp-remote` or `@beeper/desktop-mcp`
  (env `BEEPER_ACCESS_TOKEN`).

### Open-source prior art (what to build on)

- **De facto config shape.** Most server READMEs publish
  `{"mcpServers": {"<name>": {command,args,env} | {type,url,headers}}}`.
  Claude Code, Claude Desktop and Cursor use it. VS Code differs: it uses
  `servers` and has `inputs` with `password: true`, referenced as
  `${input:id}`, prompted once and stored in a secret store. Claude Desktop's
  MCPB manifest converged on the same idea (`user_config` with
  `sensitive: true`).
- **`add-mcp` (Apache-2.0, neon-solutions).** Its per-client
  `transformConfig(name, cfg)` is the right shape, and ~30 lines per client.
  It isn't worth depending on: it has CLI deps, and its Codex transform is
  wrong (SSE, `type` key, no env indirection). We copy the idea, not the
  package.
- **Aggregators (MetaMCP, 1MCP, MCPHub, ToolHive, Docker gateway): rejected.**
  - A supervised runtime to bundle.
  - Breaks each CLI's native OAuth.
  - Rewrites tool names (breaking permission rules and our transcript
    rendering).
  - A single point of failure for all servers.
  - Their one advantage, hot-swap without restart, doesn't outweigh these.
- **MCP Registry** (registry.modelcontextprotocol.io, v0.1 API frozen, still
  *preview*). `server.json` `packages[]` / `remotes[]` with
  `isSecret`-flagged env and headers maps directly onto our inputs model. It
  is a good optional "Add from registry" source later, but not v1. Beeper
  isn't listed.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Deliver by writing provider config, or at launch? | **At launch only.** Never write `~/.claude.json`, `.mcp.json` or `config.toml`. | Reuses the proven built-in path. There's no clobber race with live Claude processes (which rewrite `~/.claude.json` constantly), no `codex mcp add` table rewrite, and a per-agent subset comes free. The price, "needs an agent reload", already holds for built-in MCP and for both CLIs' own config. |
| Canonical storage format | **The de facto `mcpServers` entry shape**, plus VS Code-style `${input:id}` secret references and a little Agent Code metadata. | Users paste README snippets unchanged. The format is already understood by every MCP author, so there is no bespoke schema to learn or document. |
| Where state lives | **Main-owned** `STATE_DIR/mcp-servers.json` (0600), not renderer localStorage. | Main resolves secrets and builds launch material. Multiple windows need one owner. This matches provider enablement. |
| Secrets | `safeStorage` per-file blobs under `STATE_DIR/mcp-secrets/`, no auth prompt, never sent to the renderer (hint only). | A Touch ID-gated vault would prompt during automatic restore or reload. This is the dictation key precedent. |
| Where may `${input:id}` appear? | **Only in `env` values and `headers` values.** Rejected in `command`, `args` and `url`. | Codex doesn't expand variables, so a secret in args or url lands in argv / `ps`. Servers that need a token on their command line (e.g. `mcp-remote --header "…${X}"`) already expand their *own* env, so the user writes `${X}` in args and puts the secret in `env.X`. |
| Toggle semantics | Three levels. **`enabled`** is a master switch ("off" means off everywhere, even with a per-agent on). **`providers.{claude,codex}`** is the default attachment for agents of that provider. **Per-agent overrides** add or remove a server for one agent. | Mirrors the built-in MCP defaults-plus-overrides model users already know, plus Cursor's "toggle without deleting". |
| Provider scope | Claude and Codex. The data model is keyed by provider, so OpenCode or Grok is an additive task later. | User scope. OpenCode's launcher already has an inline-config path to extend. |
| Transport support matrix | stdio: Claude + Codex. http: Claude + Codex. sse: **Claude only** (the Codex column is disabled with a reason). | Codex has no SSE. |
| Name rules | Must match `^[A-Za-z0-9_-]{1,64}$`. `agent_code` and `agent-code-control` are rejected (case-insensitive). No automatic prefixing. | The charset is the intersection of both CLIs and `-c` path parsing. A prefix would uglify every tool name (`mcp__ac-beeper__send_message`) and break the permission rules users copy from docs. |
| Same name as a user-native server | **Codex: skip injecting that server for this spawn and warn.** Claude: inject (launch replaces the native entry), and show a notice in Settings. | The Codex deep merge can create an invalid mixed-transport entry that kills the whole launch. Claude replacement is well-defined. |
| OAuth | **Delegated to each CLI.** Settings offers "Sign in…" for HTTP servers. For Codex it opens a terminal pane running `codex mcp login <name>` with the same `-c` overrides. For Claude it tells the user to run `/mcp` in an agent that has the server attached. | Both CLIs already store OAuth tokens securely and key them stably. Building our own OAuth client would duplicate that and break the CLIs' own refresh logic. |
| Aggregator/proxy | Rejected. | See prior art above. |
| Registry / catalog | Out of v1. Follow-up issue. | Preview API; paste already covers "any server". |
| Workflows (Codex SDK subagents) | Out of scope. They keep their private `CODEX_HOME` without user servers. | Replay safety (`inheritedMcpServers: 'unknown'`). |
| Settings location | New **MCP** category holding the user-servers row, **plus** the existing built-in MCP default rows and the External operator MCP row moved from Agents. | One place for MCP. The move is a category change on existing registry entries (opportunistic cleanup within blast radius). |
| Editing UI | **One JSON editor per server** (the standard entry shape), plus masked secret fields generated from the `${input:*}` references it contains. No field-by-field form builder. | "Any MCP server" means any shape a README publishes. A form either restricts that or grows forever. The user explicitly asked for a lean UI. |

## Contracts

### Stored document (`STATE_DIR/mcp-servers.json`, mode 0600)

```ts
// src/shared/types/userMcp.ts
export const USER_MCP_PROVIDERS = ['claude', 'codex'] as const
export type UserMcpProvider = (typeof USER_MCP_PROVIDERS)[number]

/** The de facto `mcpServers` entry. Kept structurally identical to what
 *  READMEs publish so paste → store → re-export is lossless. */
export type UserMcpServerEntry =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

export type UserMcpInput = {
  id: string            // referenced as ${input:<id>}; ^[A-Za-z0-9_-]{1,64}$
  description: string   // shown next to the masked field
}

export type UserMcpServer = {
  id: string                                  // stable uuid; overrides key on this, never on name
  name: string                                // provider-visible name, see name rules
  enabled: boolean                            // master switch
  providers: Record<UserMcpProvider, boolean> // default attachment per provider
  entry: UserMcpServerEntry
  inputs: UserMcpInput[]                      // secret definitions only; values live in safeStorage
}

export type UserMcpDocument = { version: 1; servers: UserMcpServer[] }
```

A pasted entry that has no `type` but does have `url` is normalized to
`type: 'http'`. That is Cursor/Claude Desktop behavior, and Streamable HTTP is
the current transport. Unknown extra keys in `entry` are **preserved**, not
dropped (see "What would make this wrong").

### Renderer-visible snapshot (IPC, no secret values)

```ts
export type UserMcpServerView = UserMcpServer & {
  secrets: Record<string /*inputId*/, { set: boolean; hint?: string /* last 4 */ }>
  problems: UserMcpProblem[]   // validation + readiness, computed in main
  support: Record<UserMcpProvider, { ok: true } | { ok: false; reason: string }>
}
export type UserMcpProblem =
  | { kind: 'invalid-name' | 'reserved-name' | 'invalid-entry'; message: string }
  | { kind: 'secret-in-forbidden-field'; field: string }
  | { kind: 'unknown-input'; inputId: string }      // ${input:x} with no definition
  | { kind: 'secret-missing'; inputId: string }
  | { kind: 'duplicate-name'; otherId: string }
```

IPC channels are `user-mcp:get`, `user-mcp:save-server` (upsert by id),
`user-mcp:delete-server`, `user-mcp:set-enabled`, `user-mcp:set-provider`,
`user-mcp:set-secret`, `user-mcp:clear-secret` and `user-mcp:import` (parse
only, returns candidate servers), plus the broadcast `user-mcp:changed`. Every
mutation returns the new full snapshot, as provider enablement does.

### Per-agent state (renderer pane metadata, beside `builtInMcpOverrides`)

```ts
userMcpOverrides?: Record<string /*server id*/, boolean> // absent = inherit
userMcpServerIds?: string[]  // OBSERVED: what the running process was launched with
```

`resolveSessionUserMcpServerIds({ provider, servers, overrides })` returns
enabled servers whose provider default is on, plus overrides set to `true`,
minus overrides set to `false`. It then filters out servers whose `enabled` is
false and servers that don't support that provider. It is a pure function in
`src/renderer/src/workspace/userMcp.ts`.

`clonedMcpOverrides` copies `userMcpOverrides` too, because a duplicate
should keep its tools. `Use Global MCP Settings` clears both override maps.

### Spawn contract (renderer → main)

`SessionSpawnOptions` / `SessionRecoverOptions` gain
`userMcpServerIds?: string[]`. Main is the authority:

1. It re-reads its store and drops unknown ids, disabled servers, servers
   unsupported on this provider, servers with problems, and servers with a
   missing secret.
2. It resolves secrets and builds `ResolvedUserMcpServer[]`.
3. It passes that list into `createSession({ …, userMcpServers })`.
4. `SessionInfo.userMcpServerIds` reports what was actually attached.

For every dropped id, main emits `user-mcp-unavailable
{ sessionId, servers: [{ name, reason }] }`, shown the same way as
`managed-skills-unavailable` (`sessionManager.ts:220, 2724`). **A bad user
server never fails an agent launch.**

The renderer sends ids, not configs, because secrets never leave main, and
because a stale renderer snapshot must not be able to inject a server the user
has since deleted.

### Launch material (main, per provider)

`src/providers/shared/runtime/userMcpLaunch.ts`. Each translator is a pure
function (`servers → { claudeEntries | codexArgs, env }`), in the spirit of
add-mcp's `transformConfig`.

**Secret variable naming.** Each `env`/`headers` value that contains
`${input:…}` is fully substituted in main. The result goes in a generated
variable named
`AGENT_CODE_USER_MCP_<NAME>_<KEY>`: uppercased, non-alphanumerics mapped to
`_`, and made collision-free with a numeric suffix. The name is
**deterministic across spawns**. That is required because Claude keys stored
OAuth tokens on `hash(type,url,headers)`, and headers carry these variable
names, so an index-based name that shifted when another server was toggled
would silently discard the user's OAuth login.

**Claude.** User entries merge into the **same** private 0600 file that
`createPrivateClaudeMcpConfig` already writes, so there's still one
`--mcp-config`, still last among the flags:

- stdio: `{type:'stdio', command, args, env:{K: '${AGENT_CODE_USER_MCP_…}' | literal}}`.
- http/sse: `{type, url, headers:{H: '${AGENT_CODE_USER_MCP_…}' | literal}}`.
- The generated variables go into the Claude process env, and Claude expands
  them.
- The file is created even when no built-in servers are enabled. Today the
  function returns `null` for an empty list, so the signature widens.

**Codex.** Extend beside `addCodexBuiltInMcpLaunchConfig`:

- stdio:
  - `mcp_servers.<n>.command="…"`
  - `mcp_servers.<n>.args=[…]` (TOML array via JSON-compatible literal)
  - `mcp_servers.<n>.cwd="…"`
  - `mcp_servers.<n>.env_vars=["K1","K2"]`, where each `K` is set to its
    substituted value in the Codex process env. Codex passes env to stdio
    children only through its allowlist plus `env_vars`, and a literal `env`
    would put values in argv.
  - **Collision:** if two attached stdio servers need the same env key with
    different values, the second is dropped with a reason. `env_vars` can't
    rename.
- http:
  - `mcp_servers.<n>.url="…"`.
  - Every header goes through `env_http_headers.<H>="<generated var>"`,
    exactly like the built-ins. That includes `Authorization`: Codex rejects
    literal `bearer_token`, and `env_http_headers` covers it without special
    casing.
- Name collision with a user-native Codex server: before building args, main
  parses `${CODEX_HOME:-~/.codex}/config.toml` `mcp_servers` keys with
  `@iarna/toml` (already a dependency). On a hit, it skips and warns. A
  project `.codex/config.toml` in the cwd is checked the same way.

**Claude enterprise lock.** If `managed-mcp.json` exists (macOS:
`/Library/Application Support/ClaudeCode/managed-mcp.json`), user servers are
not injected for Claude, and each gets a `managed-policy` reason. Injecting
them would make the process exit.

### Import parser (`user-mcp:import`)

It accepts, in order:

1. `{"mcpServers": {…}}`, the Claude, Cursor and Claude Desktop form.
2. `{"servers": {…}, "inputs": [...]}`, the VS Code form. `inputs` with
   `password: true` become our inputs, and non-password `promptString` inputs
   become literal placeholders the user must fill.
3. A bare `{"<name>": {command|url…}}` map.
4. A single bare entry `{command|url…}`, for which the user supplies a name.

The import rule is that every literal `env` value and `headers` value becomes
a generated secret input (`<name>-<key>`), with its value pre-filled from the
paste and stored in safeStorage. The JSON keeps only `${input:…}`. The user can
edit a value back to a literal if it isn't sensitive. We deliberately don't
guess sensitivity from key names (same reasoning as the built-in launcher's
`env_http_headers` WHY comment): a missed guess leaks a token into a
plaintext file.

## UX

### Settings → MCP (new category)

1. **Your MCP servers** (marker row `user-mcp-servers`). Each server shows:
   - name, and a transport summary (`http · localhost:23373/v0/mcp`,
     `stdio · npx -y @beeper/mcp-remote`);
   - a master switch;
   - one checkbox per provider that is **enabled in Settings → Providers**,
     so a disabled provider's column is hidden (tying into #1126);
   - status chips from `problems` and support reasons (for example
     "Claude only: Codex has no SSE", "Secret not set", "Name collides with
     your Codex config");
   - Edit, Delete and, for HTTP servers, Sign in….
   - Footer: **Add server…** and "Changes apply to new agents and on agent
     reload."
2. **Add / Edit dialog.** A name field, a JSON editor holding the entry (paste
   anything from a README), and a live list of masked secret fields, one per
   `${input:id}` found. Validation errors show inline and come from the same
   main-side validator. "Paste config" imports multiple servers at once.
3. The built-in MCP default rows and External operator MCP move here
   unchanged.

### Command palette

Per `docs/command-style.md`:

| id | Title | Surface | Behavior |
|---|---|---|---|
| `user-mcp-servers` | `MCP Servers…` | app | Picker of all user servers with toggle state, plus "Add server…" and "Open MCP settings" rows. Selecting a server flips its master switch; `keepPaletteOpen`. |
| `add-user-mcp-server` | `Add MCP Server…` | app | Opens the Add dialog with the paste box focused. |
| `agent-user-mcp-servers` | `Agent MCP Servers…` | session | Picker for the focused Claude or Codex agent. Each row shows attached, inherited or overridden state. Selecting one writes the override and reloads the agent through the existing reload path, one reload per toggle, like the built-in MCP commands. |
| `use-global-mcp-settings` | (existing) | session | Also clears `userMcpOverrides`. |

The catalog is context-free, so it can't generate one command per server.
Hence pickers. `ui.openSettings()` gains an optional category argument so
"Open MCP settings" deep-links.

## What would make this wrong (invariants)

- **Secrets never reach** argv, the renderer, `mcp-servers.json`, logs or
  incident bundles. Secrets *do* reach the agent's own process env and the
  private 0600 Claude file, so the agent's shell tools can read them. That is
  equally true of the existing built-in bearer and of the CLIs' own config,
  and it is accepted and stated in the UI copy.
- **A bad user server never fails an agent launch.** Main validates and
  drops. The CLIs exit on invalid config (see evidence), so passing something
  unvalidated through is a fleet-wide outage.
- **Only one `--settings` for Claude.** This feature adds no Claude settings
  fragment. If it ever needs one (for example to hide a native server), it
  must merge into `excludeExternalControlFromClaude`.
- **Unknown entry keys survive a round trip.** READMEs use client-specific
  keys (`oauth`, `headersHelper`, `timeout`). For Claude they pass through
  untouched. For Codex, only the known keys are translated, and the rest are
  ignored with a visible "Ignored by Codex: …" note, never silently dropped
  from storage.
- **The renderer never decides what gets attached.** It proposes ids, and main
  disposes. The launched set on the pane is observed (`userMcpServerIds`), and
  recovery adopts the running process's set, exactly like
  `builtInMcpDomains`.
- **The master switch really means off.** No per-agent override may resurrect
  a server whose `enabled` is false.

## Known limitations (stated, not solved)

- A config change needs an agent reload. Neither TUI reloads MCP config
  (Claude only on `/clear` or `/reload-plugins`).
- Claude's persistent `disabledMcpServers` (set via `/mcp` in a repo) applies
  by name to injected servers too. Toggling an injected server inside `/mcp`
  writes that state back into `~/.claude.json`. We document this and don't
  fight it.
- Native servers (from `~/.claude.json`, `.mcp.json` or `config.toml`) still
  load and aren't shown. The read-only "Also loaded natively" list is a
  follow-up.
- Codex can't use SSE-only servers.
- Workflow subagents don't get user servers.

## Follow-ups (separate issues after v1)

1. Read-only "Also loaded natively" list, with "Copy into Agent Code".
2. "Add from registry" via the MCP Registry v0.1 API (preview).
3. OpenCode and Grok support (the data model and translators are additive).
4. #244: Agent Code-hosted extension servers register into the same list.

## Acceptance (Beeper as the fixture)

1. Paste Beeper's official token snippet →
   - the result is one server, `beeper`, of type http with a
     `beeper-authorization` secret;
   - the JSON on disk contains no token.
2. With Claude and Codex both ticked, a new Claude agent's private
   `mcp.json` has `beeper` with an `${AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION}`
   header.
3. A new Codex agent's argv has `mcp_servers.beeper.url` and
   `env_http_headers.Authorization="AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION"`,
   and no token appears in argv.
4. `Agent MCP Servers…` → Beeper off → after the reload the agent has no
   beeper tools, and `userMcpServerIds` excludes it.
5. The master switch off → no new agent gets it, even one with a per-agent
   on override.
6. A stdio server (`npx -y @beeper/mcp-remote`) works on both providers.
7. An SSE server shows the Codex column disabled with a reason.
8. A server named `agent_code` is rejected. A server colliding with a
   `[mcp_servers.X]` in the user's `config.toml` is skipped for Codex with a
   visible reason, and the Claude launch is unaffected.
9. A deleted secret → the agent still launches, without that server, and
   shows the unavailable notice.
