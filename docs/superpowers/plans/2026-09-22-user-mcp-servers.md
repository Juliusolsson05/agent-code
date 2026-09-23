# MCP Servers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One MCP interface for every MCP server. Users can:
- add any MCP server by pasting its README snippet;
- keep its secrets encrypted;
- choose per provider which servers new agents get, for Agent Code's built-in servers and their own alike;
- override those choices per agent with one staged reload;
- see and copy in the servers the CLIs already load directly.

Agents receive user servers when they launch, through the path the built-in MCP servers already use. Provider config files are never written.

**Spec:** `docs/superpowers/specs/2026-09-22-user-mcp-servers-design.md`. Its **Revision 2** section overrides anything in the rest of the spec that conflicts with it. Read Evidence, Decisions and Revision 2 before starting any task.

**Issue:** #1143 (Refs #244). **Status:** user-approved 2026-09-22, including auto-approval of this plan.

**Working tree:** `.worktrees/user-mcp-servers`, branch `feat/user-mcp-servers`, based on `origin/main` `672d0941`. Submodules are initialized and `node_modules` is symlinked. Use Node 24 for vitest, because Node 25 breaks happy-dom.

**Conventions:**
- Write thick WHY comments at every code site that enforces a decision.
- Use Conventional Commits with scope `mcp`.
- Test fixtures are the real published Beeper snippets.
- Verify with `npx tsc -b` and vitest once at the end.
- Never launch the app.

---

### Task 1: Shared model (`src/shared/userMcp/`)
- [ ] `types.ts`:
  - `UserMcpServer`, `UserMcpServerEntry`, `UserMcpInput` and `UserMcpDocument`.
  - The view and problem types.
  - `USER_MCP_PROVIDERS` (`claude`, `codex`) and the reserved names.
  - `userMcpOverrideKey(id)` and `userMcpOverridesFrom(map)`.
- [ ] `validate.ts`:
  - Name rules, entry validation and type normalization.
  - The rule that `${input:…}` may appear only in `env` and `headers` values.
  - The support matrix (SSE is Claude-only).
  - `coerceUserMcpDocument`, which keeps unknown keys and flags malformed servers instead of dropping them.
- [ ] `inputs.ts`: scan and substitute `${input:id}`.
- [ ] `importConfig.ts`:
  - Accepts the `mcpServers`, VS Code `servers`/`inputs`, bare-map and bare-entry forms.
  - Moves every literal env and header value into a secret input, returned as `pendingSecrets`.
- [ ] Tests for each of the above, using the Beeper fixtures.

### Task 2: Launch translators (`src/providers/shared/runtime/userMcpLaunch.ts`)
- [ ] `userMcpSecretVariable`: deterministic variable names (needed so Claude's OAuth key stays stable).
- [ ] `claudeUserMcpEntries`: builds Claude's config entries.
- [ ] `addCodexUserMcpLaunchConfig`: builds the Codex arguments, and drops a server whose `env_vars` collide with another's.
- [ ] Widen `createPrivateClaudeMcpConfig(builtIns, userEntries)`.
- [ ] Golden tests, including one asserting that no secret appears in argv.

### Task 3: Main service (`src/main/userMcp/`)
- [ ] `store.ts`: an atomic write of `STATE_DIR/mcp-servers.json` with mode 0600. A corrupt file is preserved rather than overwritten.
- [ ] `secrets.ts`: `safeStorage` blobs, with only a hint ever returned.
- [ ] `nativeServers.ts`:
  - Lists the CLIs' own user-scope servers for Claude and Codex.
  - Collects the Codex names used for the collision check.
  - Detects Claude's managed-policy lock.
- [ ] `service.ts`:
  - Snapshot and mutations, run through a serialized queue.
  - `resolveForLaunch(provider, overrides, cwd)`, which returns `{ servers, attachedIds, dropped }`.
  - A change emitter.
- [ ] IPC in `src/main/ipc/userMcp.ts`, the preload API in `src/preload/api/userMcp.ts`, and wiring in `src/main/index.ts`.
- [ ] Tests for the store, secrets, resolution and native parsing.

### Task 4: Session wiring (main and providers)
- [ ] Add `userMcpOverrides` to the spawn and recover options.
- [ ] Add `userMcpServerIds` to the snapshot, spawn result and recover result.
- [ ] `SessionManager` resolves user servers beside `builtInMcpServers` and records the attached ids per session.
  - The Codex replacement restore reuses the recorded overrides.
  - It emits `user-mcp-unavailable`, which the forwarder broadcasts.
- [ ] Claude and Codex sessions accept `userMcpServers`.
- [ ] Tests: a missing secret still spawns; the token is absent from argv.

### Task 5: Renderer model
- [ ] Per-provider `defaultBuiltInMcpDomains`, covering:
  - type and coercion;
  - the resolver picking the provider's list;
  - the refs input type;
  - the `store.ts` comment.
- [ ] `normalizeBuiltInMcpOverrides` keeps `user:` keys.
- [ ] `clonedMcpOverrides` keeps them too.
- [ ] Every renderer spawn and recover call site sends `userMcpOverrides`, and the pane meta stores `userMcpServerIds`.
- [ ] `features/mcp/store.ts`: a mirror of main's snapshot plus a sync hook, mounted in `App.tsx`.
- [ ] Global toast for `user-mcp-unavailable`.

### Task 6: Settings → MCP
- [ ] Add the `mcp` category.
- [ ] Add the `mcp-servers` marker row, which replaces the eight built-in default toggle rows.
- [ ] Move `external-control` into the new category.
- [ ] `McpServersRow`:
  - The grid of built-in and user servers, with a column per enabled provider.
  - Master switches, problem chips, and the ⋯ actions.
  - The native section with Copy in.
- [ ] `McpServerDialog`:
  - Add and edit, with paste import and a JSON editor.
  - Masked secret fields.
  - Sign in… launches `codex mcp login` in a new terminal pane with the same `-c` URL, and shows Claude `/mcp` guidance.
- [ ] `ui.openSettings(category?)`.

### Task 7: Commands and the per-agent modal
- [ ] `AgentMcpServersModal` and its surface: staged toggles, one reload, a reset row, and Root Management going through its confirmation dialog.
- [ ] New commands: `mcp-servers`, `add-mcp-server` and `agent-mcp-servers`.
- [ ] Retire `use-global-mcp-settings` and the eight `enable-*-mcp` toggles.
- [ ] Update the control references, `catalog.test.ts`, `taxonomy.test.ts` and the affected renderer tests.

### Task 8: Documentation, verification and PR
- [ ] Update README and ARCHITECTURE.
- [ ] Run `npx tsc -b` and vitest.
- [ ] Real-binary check of the generated Codex `-c` arguments with `codex mcp list`.
- [ ] Open the PR `feat(mcp): manage MCP servers per provider and per agent` with `Fixes #1143` and `Refs #244`. Run two orchestrated reviewers, fix the valid findings, wait for CI, and do not merge.

## Out of scope (follow-up issues)
- Add from MCP Registry.
- OpenCode and Grok user servers.
- User servers for workflow subagents.
- Project-scope native server listing.
- #244 hosted extension servers.
