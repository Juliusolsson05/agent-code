# User MCP Servers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add any MCP server, set its secrets, and choose which providers get it (Claude Code, Codex). They can override it per agent and turn it on or off from Settings → MCP and the command palette. Servers are delivered at launch through the same path Agent Code's built-in MCP already uses, and provider config files are never written.

**Architecture:**
- Storage and secrets:
  - A main-owned store (`STATE_DIR/mcp-servers.json`, 0600) holds entries in the de facto `mcpServers` shape. Entries use VS Code-style `${input:id}` secret references.
  - Secret values live in `safeStorage` blobs and never reach the renderer.
- IPC and renderer: IPC and a broadcast follow the provider-enablement pattern (#1126). A non-persisted zustand mirror sits in the renderer.
- Launch flow:
  - The renderer resolves attached server **ids** from the provider defaults plus the per-pane `userMcpOverrides`, and sends them with spawn/recover options.
  - Main validates them, resolves secrets, and hands `ResolvedUserMcpServer[]` to the provider launchers.
  - The Claude launcher adds them to the existing private `--mcp-config` file.
  - The Codex launcher adds `-c mcp_servers.*` overrides, with secrets passed through the environment.
  - A bad server is dropped with a notice. It never fails the launch.

**Spec:** `docs/superpowers/specs/2026-09-22-user-mcp-servers-design.md`. Read its Evidence and Decisions sections before starting any task; every "why" is there.

**Issue:** #1143 (Refs #244).

**Working tree:** `.worktrees/user-mcp-servers`, branch `feat/user-mcp-servers`, based on `origin/main` `672d0941`. Setup: `git submodule update --init` and `ln -s ../../node_modules node_modules` (see the memory note on worktree setup).

**Conventions:**
- Thick WHY comments (AGENTS.md); each non-obvious decision in the spec's Decisions table gets a comment at the code site that enforces it.
- Commit messages use Conventional Commits with scope `mcp`.
- Tests protect behavior. Fixtures are the **real** published Beeper snippets (quoted in the spec), not invented shapes.
- Verification: `npx tsc -b` plus the `unit`/`renderer` vitest projects. Run the full suite once at the end, not per task.
- Never launch the app.

---

### Task 1: Shared contracts and pure validation

**Files:**
- Create: `src/shared/types/userMcp.ts` (types from the spec's Contracts section, `USER_MCP_PROVIDERS`, reserved names)
- Create: `src/shared/userMcp/validate.ts` and `validate.test.ts`
- Create: `src/shared/userMcp/inputs.ts` and `inputs.test.ts` (`${input:id}` scan and substitute)

- [ ] Write failing tests:
  - Name rules: `^[A-Za-z0-9_-]{1,64}$`; `agent_code`, `AGENT_CODE` and `agent-code-control` are rejected; a duplicate name among servers raises `duplicate-name`.
  - Entry validation:
    - stdio needs a `command`; http and sse need an absolute `http(s)` url.
    - A `type`-less entry with a `url` normalizes to `http`.
    - A mixed `command` + `url` entry is `invalid-entry`.
  - `${input:x}` is allowed in `env` and `headers` values, and gives `secret-in-forbidden-field` in `command`, `args` or `url`. An undefined input id gives `unknown-input`.
  - Support matrix: sse → `codex: { ok:false, reason: 'Codex does not support SSE MCP servers' }`.
  - Unknown extra entry keys are preserved through `coerceUserMcpDocument`.
  - Coercion: malformed servers are kept but flagged, never silently deleted; a non-object document becomes `{version:1, servers:[]}`.
- [ ] Implement until the tests are green. The WHY comments cover the charset intersection, why names are not prefixed, and why only `env`/`headers` may carry secrets.
- [ ] Commit `feat(mcp): add user MCP server contracts and validation`.

### Task 2: Import parser

**Files:** `src/shared/userMcp/importConfig.ts` and `importConfig.test.ts`

- [ ] Fixtures (verbatim from developers.beeper.com, as quoted in the spec):
  - `{"mcpServers":{"beeper":{"url":"http://localhost:23373/v0/mcp","headers":{"Authorization":"Bearer YOUR_TOKEN_HERE"}}}}`
  - The `@beeper/mcp-remote` stdio snippet with `env.ACCESS_TOKEN`.
  - The VS Code `{"servers":{"beeper":{"type":"http",…}}}` form.
  - A VS Code form with `inputs:[{type:'promptString',id,password:true}]`.
  - A bare `{name: entry}` map, and a single bare entry.
- [ ] Assert that every literal env or header value becomes `${input:<name>-<key>}`, with its pasted value returned separately as `pendingSecrets`. The resulting entry must contain no literal token.
- [ ] Assert that malformed JSON returns a typed error, not a throw.
- [ ] Commit `feat(mcp): import MCP server configs from standard snippets`.

### Task 3: Main store, secrets, IPC, broadcast

**Files:**
- Create: `src/main/userMcp/store.ts`, which loads and coerces `STATE_DIR/mcp-servers.json` and does atomic 0600 writes through a temp file plus rename. Mutations run through one serialized queue.
- Create: `src/main/userMcp/secrets.ts`, a `safeStorage` blob per `<serverId>/<inputId>.bin` following the `src/main/dictation/apiKeyStore.ts` pattern. It returns only `{set, hint}`, and deleting a server deletes its secrets.
- Create: `src/main/userMcp/service.ts`, which builds the snapshot (`UserMcpServerView[]` with problems and support), handles mutations (return snapshot + emit), and provides `resolveForLaunch(ids, provider, cwd)`. That resolver is called in Task 5.
- Create: `src/main/ipc/userMcp.ts`, registered in `src/main/ipc/index.ts`, with channels per the spec and argument validation mirroring `ipc/providerEnablement.ts`.
- Create: `src/preload/api/userMcp.ts`, and expose it in the preload API types.
- Wire the service in `src/main/index.ts` next to the provider enablement construction.

- [ ] Tests:
  - Store round trip keeps unknown keys, and the file mode is 0600.
  - A corrupt file is preserved (renamed `.corrupt-<ts>`), and the store starts empty with a visible problem. Silently resetting would lose the user's config.
  - A secret set or clear never appears in the snapshot, only `hint`.
  - Mocking `safeStorage` as unavailable surfaces a `secret-missing` problem, not a crash.
- [ ] Commit `feat(mcp): persist user MCP servers and secrets in main`.

### Task 4: Provider launch translators (pure)

**Files:** `src/providers/shared/runtime/userMcpLaunch.ts` and `userMcpLaunch.test.ts`; modify `builtInMcpLaunch.ts`

- [ ] `generatedSecretVar(serverName, key, taken)` is deterministic: `AGENT_CODE_USER_MCP_<NAME>_<KEY>`, sanitized, with a numeric suffix on collision. A test asserts it is stable when another server is added or removed. Comment the Claude OAuth-key reason (spec, "Secret variable naming").
- [ ] `claudeUserMcpEntries(servers) → { entries, env }` and `codexUserMcpLaunchConfig(servers, args, env) → { dropped }`:
  - Codex stdio:
    - Emit `command`, `args` (TOML array), `cwd` and `env_vars=[…]`, with the values placed in `env`.
    - If two attached stdio servers use the same env key with different values, drop the second with a reason.
  - Codex http: every header goes through `env_http_headers`.
  - Unknown keys:
    - Claude: passed through verbatim.
    - Codex: ignored, and their names are returned for the UI note.
- [ ] Change `createPrivateClaudeMcpConfig(builtIns, userEntries)` so it writes one file when either list is non-empty. The existing callers (`claudeSession.ts:1189-1202`) keep a single `--mcp-config` as the last flag.
- [ ] Golden tests using the Beeper fixtures:
  - Claude file JSON.
  - Codex argv, with the assertion **no token substring appears in args**.
  - The stdio `mcp-remote` case on both providers.
- [ ] Commit `feat(mcp): translate user MCP servers into Claude and Codex launch config`.

### Task 5: Spawn and recover wiring in main

**Files:**
- `src/shared/types/session.ts`: add `userMcpServerIds?: string[]` to the spawn and recover options, and add the observed `userMcpServerIds` to `SessionInfo`. The comment makes the same "observed, not requested" point as `builtInMcpDomains`.
- `src/main/sessionManager.ts`:
  - At the `builtInMcpServers` assembly (~:2875), call `userMcp.resolveForLaunch`, which:
    - drops unknown, disabled, unsupported, problem, missing-secret and native-collision servers;
    - applies the Claude `managed-mcp.json` lock.
  - Pass `userMcpServers` into `createSession`.
  - Emit `user-mcp-unavailable` for dropped servers (mirror `reportSkillsUnavailable` at :2724), and forward it to the renderer the same way.
  - Recovery that adopts an existing process keeps that process's recorded ids.
- `src/providers/claude/runtime/claudeSession.ts` and `src/providers/codex/runtime/codexSession.ts`: accept `userMcpServers`, call the Task 4 translators, and put the generated variables into the spawn env.
- Native collision check (Codex): `src/main/userMcp/nativeCodexServers.ts` parses the `mcp_servers` keys from `${CODEX_HOME:-~/.codex}/config.toml` and `<cwd>/.codex/config.toml` with `@iarna/toml`. It is read-only, and a parse failure means "no collisions known", which it logs.

- [ ] Tests:
  - A spawn with a missing secret still spawns, and emits unavailable.
  - A Codex collision drops only Codex.
  - `SessionInfo.userMcpServerIds` equals what was actually attached.
  - The token is absent from the recorded argv (there is an existing spawn-args capture harness in the codex/claude session tests; reuse it).
- [ ] Commit `feat(mcp): attach user MCP servers when agents launch`.

### Task 6: Renderer mirror, resolution, per-pane overrides

**Files:**
- Create: `src/renderer/src/features/userMcp/store.ts`, a mirror plus `useUserMcpSync()`, mounted once in `App.tsx` next to `useProviderEnablementSync`.
- Create: `src/renderer/src/workspace/userMcp.ts` with `resolveSessionUserMcpServerIds` and `normalizeUserMcpOverrides`. Test it in `userMcp.test.ts`, covering the master switch beating an override, provider default, override on/off, and an unsupported provider.
- Modify `src/renderer/src/workspace/types.ts` to add `userMcpOverrides` and `userMcpServerIds` beside the built-in fields (:283-286).
- Modify `workspace/mcpDomains.ts`: `clonedMcpOverrides` also copies `userMcpOverrides`.
- Modify `workspace/hook/actions/session.ts` (the fresh spawn at ~:378 and the replacement/reload at ~:1258) to send `userMcpServerIds`.
- Modify `workspace/builtInMcpReload.ts`, which gains the user-override variant through the same reload path. Don't fork a second reload implementation.
- Modify the workspace persistence coercion so the new pane fields survive save and load.
- Show the `user-mcp-unavailable` notice where `managed-skills-unavailable` is shown today.

- [ ] Commit `feat(mcp): resolve user MCP servers per agent in the workspace`.

### Task 7: Settings → MCP

**Files:**
- `settingsCategories.ts`: add category `mcp` ("MCP", "Servers your agents can use, and Agent Code's own MCP tools.").
- `settingsRegistry.ts`:
  - Add the `user-mcp-servers` marker row (`storage: 'external-files'`, `apply: 'new-session'`).
  - Move the built-in default MCP rows and `external-control` into the new category, changing the category only.
- `SettingsList.tsx`: dispatch the new row.
- Create: `src/renderer/src/features/userMcp/ui/UserMcpServersRow.tsx` and `UserMcpServerDialog.tsx`:
  - List, master switch, and per-provider checkboxes, showing only providers enabled in `useEnabledAgentProviderKinds()`.
  - Problem and support chips, Edit, Delete, and Sign in… for HTTP servers.
  - The dialog has a name field, a JSON entry editor, and masked secret fields derived from the `${input:*}` references. Validation comes from main.
  - Paste-import supports multiple servers.
- Sign in…:
  - Codex: open a terminal pane running `codex mcp login <name>` with the same `-c` url override (the spec notes that login reads the effective config).
  - Claude: show inline guidance to run `/mcp` in an agent that has the server attached.
- `ui.openSettings(category?)`: add the optional argument (`command-palette/types.ts:202`) and its implementation.

- [ ] Renderer tests:
  - The row hides the Codex column when Codex is disabled in Providers.
  - An SSE server's Codex checkbox is disabled, with the reason shown.
  - The dialog never renders a secret value.
- [ ] Commit `feat(mcp): add MCP settings with user server management`.

### Task 8: Commands

**Files:** a new `src/renderer/src/features/userMcp/commands.ts` registered in `command-palette/catalog.ts`; `sessionCommands.ts` (`use-global-mcp-settings` also clears user overrides); and `catalog.test.ts` (baseline ids, counts, approved-additions list), plus `taxonomy.test.ts` if tiers apply.

- [ ] Add `user-mcp-servers` (`MCP Servers…`), `add-user-mcp-server` (`Add MCP Server…`) and `agent-user-mcp-servers` (`Agent MCP Servers…`) as the spec's command table describes. Follow `docs/command-style.md`: descriptions use the "What it does / Use when / Notes" format, and the session command re-checks the provider inside `run`.
- [ ] Commit `feat(mcp): add MCP server commands`.

### Task 9: Documentation and final verification

- [ ] Update the README "What you can do with it" section with an **MCP servers** bullet, and update the `ARCHITECTURE.md` provider-integration section to cover user servers delivered at launch.
- [ ] Run `npx tsc -b` and `npm test`, once, and compare any failures against the known local failures noted in memory.
- [ ] Run a real-binary check, read-only and with no app launch:
  - Codex: run `codex mcp list` with the generated `-c` overrides for the Beeper fixture, and confirm it parses and lists `beeper` with the header env var.
  - Claude: run `claude mcp list --mcp-config <generated file>` if it honors the flag; if not, note that in the PR.
- [ ] Open a PR with the title `feat(mcp): manage user MCP servers per provider and per agent`, with `Fixes #1143` and `Refs #244`. Do not merge.

---

## Out of scope (follow-up issues)

- Read-only "Also loaded natively" list.
- Add from MCP Registry.
- OpenCode and Grok.
- User servers in workflow subagents.
- #244 hosted extension servers.
