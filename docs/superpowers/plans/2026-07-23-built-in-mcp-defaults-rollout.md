# Configurable Built-in MCP Defaults — Implementation Plan

Status: Ready for review. Implementation is intentionally paused until this
plan is approved.

Date: 2026-07-23

Feature branch: `feat/configurable-built-in-mcp`

Feature worktree: `.worktrees/mcp-session-policy`

PR title: `Configurable built-in MCP defaults with session overrides`

Baseline: `main` at `bd39c5c0`

## Goal

Let users choose in Settings which Agent Code built-in MCP capabilities new
agent sessions receive by default, without taking away the existing per-session
toggle commands.

The finished behavior is:

```text
Settings default domains
        │
        │ seed a session once
        ▼
Explicit per-session domain snapshot
        │
        │ filter through provider capabilities
        ▼
Main-owned authenticated MCP registration
        │
        ├─ Claude: orchestration / AI workspace / transcripts only
        ├─ Codex:  orchestration / AI workspace / transcripts / workflows
        └─ OpenCode: no built-in MCP injection yet
```

A setting is a default, not an enforcement policy. If Orchestration MCP is on
by default, a new Codex session starts with it, but the existing command can
turn it off for that one session. That explicit off state survives provider
replacement, app restart, pane restoration, and workspace persistence.

Workflow MCP is a hard exception: it is Codex-only. Claude already has a native
workflow feature, so Agent Code must never advertise, inject, or register its
emulated Workflow MCP for a Claude process. This provider restriction applies
even if stale workspace metadata, an orchestration tool request, or a renderer
bug asks for the domain.

## Why this needs more than four Settings toggles

The visible change is small, but MCP selection crosses several lifetimes and
trust boundaries:

1. Settings live in renderer-owned Zustand persistence.
2. Per-session domain names live in durable `SessionMeta` inside
   `workspace.json`.
3. New panes, restored panes, hibernated panes, provider switches, undo-close,
   duplicate, rewind, reload, and orchestration children all enter the spawn
   system through different paths.
4. The renderer sends domain names over IPC, but main owns the actual MCP host,
   per-session credential, and provider process.
5. Claude and Codex receive MCP configuration through different protected
   launch mechanisms, while OpenCode currently ignores the shared
   `builtInMcpServers` option.

Implementing only the Settings UI would therefore produce at least three bad
states: defaults that disappear on restore, a session toggle that cannot keep
the last domain disabled, and a Claude Workflow toggle that looks off in the UI
while stale metadata still injects it from main.

## Current architecture

### One server, domain-scoped tool surfaces

Agent Code does not run one MCP server per feature. `BuiltInMcpHttpHost` owns
one Streamable HTTP server on `127.0.0.1` and exposes one provider-facing server
configuration named `agent_code`. Every registered session receives a random
bearer token whose registration contains:

```ts
type McpSessionScope = {
  sessionId: string
  cwd: string
  domains: BuiltInMcpDomain[]
}
```

`createBuiltInMcpServer` builds a request-scoped `McpServer` and conditionally
registers tools from that scope:

| Domain | Current tool surface |
| --- | --- |
| `ping` | Development-only bridge smoke test. |
| `orchestration` | Create, prompt, inspect, wait for, and close Agent Code child agents/runs. |
| `ai_workspace` | Create and manage curated cross-worktree review workspaces and open them in the UI. |
| `agent_transcripts` | Read, search, and inspect explicitly named agent transcript files through bounded projections. |
| `workflows` | Discover, validate, start, inspect, cancel, and resume app-owned portable workflows through `workflow-mcp`. |

The token is never persisted. Only domain names are durable; main mints a fresh
token and loopback URL whenever it starts or recovers a provider process.

### Provider launch paths

`SessionManager.spawnWithId` currently accepts renderer-supplied
`builtInMcpDomains`, registers the session with `BuiltInMcpHttpHost`, and passes
the resulting `BuiltInMcpServerConfig[]` into the provider factory.

- Claude writes a private temporary MCP configuration rather than exposing the
  bearer in process arguments.
- Codex uses its `mcp_servers` launch configuration with environment-backed
  authentication headers.
- OpenCode structurally accepts the common `SessionOptions`, but its runtime
  does not consume `builtInMcpServers`. The current general MCP commands use
  `isAgentProviderKind`, so they incorrectly appear for OpenCode even though no
  tools reach the model.

This PR does not change either secure transport. It changes how the effective
domain list is resolved and adds a provider policy before any registration is
minted.

### Current session behavior

The command palette has five per-session toggle commands. Each command computes
a new list of domain names and calls `replaceSession`, because both Claude and
Codex discover MCP servers at process launch. Renderer metadata and the actual
model-visible tools therefore move together when the replacement succeeds.

The same list is already threaded through duplicate, split, undo-close,
provider switch, reload, wake, recovery, and orchestration-child creation. That
continuity is useful, but the current normalizer has a semantic bug for this
feature:

```ts
normalizeSessionBuiltInMcpDomains([]) === undefined
```

Today that is harmless because no global default exists. Once Settings can turn
a domain on by default, collapsing `[]` means “the user explicitly disabled the
last domain” becomes indistinguishable from “this old session has never chosen
anything.” A restored session could silently turn the domain back on.

## Product decisions

### 1. One global default list, filtered per provider

Add one Settings field:

```ts
defaultBuiltInMcpDomains: ConfigurableBuiltInMcpDomain[]
```

The configurable union excludes `ping`:

```ts
type ConfigurableBuiltInMcpDomain = Exclude<BuiltInMcpDomain, 'ping'>
```

A single list is preferable to separate Claude/Codex lists because the user's
intent is capability-oriented: “new agents should have orchestration.” Provider
constraints are implementation policy and should not force the user to keep
parallel preference sets in sync. The resolver filters the list for the chosen
provider.

The default is `[]`. Existing users and fresh installs retain today's opt-in
behavior until they deliberately enable a default.

### 2. Provider support is a shared policy

Define the support matrix once in boundary-neutral MCP code:

| Domain | Claude | Codex | OpenCode |
| --- | :---: | :---: | :---: |
| `orchestration` | Yes | Yes | No |
| `ai_workspace` | Yes | Yes | No |
| `agent_transcripts` | Yes | Yes | No |
| `workflows` | **No** | Yes | No |
| `ping` | Dev-only | Dev-only | No |

The policy must be exhaustive over `AgentProviderKind`. A new provider should
cause a compile-time decision about MCP support instead of inheriting every
domain because it happens to satisfy `isAgentProviderKind`.

The shared module will expose narrow helpers for:

- validating/deduplicating configurable persisted defaults;
- testing whether a domain is supported by a provider;
- filtering an arbitrary domain list for a provider while preserving order;
- resolving a session's explicit list versus the configured defaults.

Workflow MCP being absent from Claude is not merely a UI preference. The main
host applies the same policy so a compromised or stale renderer cannot widen a
Claude session's capability set.

### 3. `undefined` and `[]` acquire different meanings

For agent `SessionMeta`:

```text
builtInMcpDomains === undefined
  Legacy/uninitialized session. Seed it from current Settings defaults.

builtInMcpDomains === []
  Explicit session choice. Keep every built-in MCP domain disabled.

builtInMcpDomains === ['orchestration', ...]
  Explicit session choice. Preserve it across lifecycle operations.
```

`normalizeSessionBuiltInMcpDomains` will return `undefined` only for a value
that is not an array. A valid array remains an array after filtering, including
when it becomes empty. `withNormalizedBuiltInMcpDomains` must likewise retain
an explicit empty array in saved workspace metadata.

This is a forward-compatible distinction. Old workspace files cannot tell us
whether a missing field meant “never configured” or “the old normalizer removed
my empty list.” They will adopt current defaults once on their next recovery;
after that, the renderer writes an explicit array and the ambiguity is gone.

### 4. Defaults seed; they do not continuously reconcile

Changing a default in Settings affects:

- newly created grid, Dispatch, split, and detached agents;
- orchestration children whose request does not explicitly provide domains;
- undo/restoration of legacy sessions with no domain field;
- wake/rehydration of legacy sessions with no domain field.

It does not reload or mutate existing live sessions. MCP configuration is a
launch-time capability, and calling a setting a “default” while restarting an
entire live fleet would be surprising and potentially destructive. Existing
sessions with an explicit list keep it.

An orchestration caller can still deliberately override the default by passing
`builtInMcpDomains`, including `[]`. Provider filtering happens after this
choice, so an orchestration request cannot grant Workflow MCP to Claude.

### 5. Provider switches preserve session intent, then narrow it

Provider switching continues to carry the session's explicit domain list. The
target provider filter is then applied:

- Codex with `['workflows', 'orchestration']` switched to Claude becomes
  `['orchestration']`.
- Switching that same session back to Codex does not silently restore
  `workflows`; the session snapshot is authoritative after initialization.
- A legacy session without a list receives defaults for the target provider.

Dropping an unsupported domain from persisted metadata is intentional. Keeping
it would let the UI claim a capability is on while the provider cannot receive
it, and it would make a later provider switch unexpectedly resurrect access.

## Settings UX

Use the existing `Agents` category. Do not create another category for four
closely related rows.

Add these generic toggle definitions to `settingsRegistry.ts`:

1. **Orchestration MCP for New Agents**
2. **AI Workspace MCP for New Agents**
3. **Agent Transcripts MCP for New Agents**
4. **Workflow MCP for New Codex Agents**

Each toggle adds/removes one domain from `defaultBuiltInMcpDomains`. Copy must
say that existing sessions are unchanged and that the command palette controls
the focused session independently.

The Workflow row must explicitly say:

> Codex only. Claude uses its native workflow feature, so Agent Code never
> injects Workflow MCP into Claude sessions.

Do not add a persistent Ping row. Ping remains gated by
`AGENT_CODE_MCP_PING`/`AGENT_CODE_DEV_DEBUG` and its development command.

Settings persistence will:

- bump the Zustand store version from 7 to 8;
- backfill a missing field with `[]`;
- accept only the four configurable domain strings;
- remove duplicates while preserving canonical input order;
- drop unknown values, non-string entries, and `ping`;
- run the coercion from both migration and merge, following the existing
  same-version-corruption defense.

## Implementation plan

### Phase 1 — Establish the shared domain and provider policy

**Files:**

- `src/mcp/shared/types.ts`
- a focused shared-policy test beside the MCP types, if the test routing accepts
  it; otherwise cover the pure helpers through the existing MCP host tests.

**Changes:**

- Add `CONFIGURABLE_BUILT_IN_MCP_DOMAINS` and derive
  `ConfigurableBuiltInMcpDomain` from it.
- Add exhaustive provider capability data keyed by `AgentProviderKind`.
- Add normalizers/filter helpers that accept untrusted persisted/IPC-shaped
  input and return clean arrays.
- Keep the existing development gate for `ping`; provider support and
  environment enablement are separate checks.
- Add thick WHY comments explaining the Claude Workflow exclusion and why
  OpenCode is false until its runtime actually injects MCP configuration.

**Invariant:** no renderer-only module owns provider MCP capabilities. Main and
renderer must import the same policy.

### Phase 2 — Persist and render Settings defaults

**Files:**

- `src/renderer/src/app-state/settings/types.ts`
- `src/renderer/src/app-state/settings/persistence.ts`
- `src/renderer/src/app-state/settings/persistence.test.ts`
- `src/renderer/src/app-state/store.ts`
- `src/renderer/src/app-state/store.test.ts`
- `src/renderer/src/features/settings/lib/settingsRegistry.ts`

**Changes:**

- Add `defaultBuiltInMcpDomains` to `Settings` and `DEFAULT_SETTINGS`.
- Coerce the value through the configurable-domain normalizer.
- Bump persisted store version to 8 and document the reason in the version
  history comment.
- Add four `Agents` category toggle rows using immutable add/remove helpers.
- Keep Settings changes immediate in persistence but non-disruptive to live
  provider processes.

**Tests:**

- Missing/invalid values become `[]`.
- Valid values survive.
- Duplicates, unknown strings, non-strings, and `ping` are removed.
- A version-7 persisted store hydrates with the new field.
- Registry toggles add and remove only their own domain without disturbing the
  others.

### Phase 3 — Preserve an explicit empty session override

**Files:**

- `src/renderer/src/workspace/mcpDomains.ts`
- workspace persistence tests that exercise metadata normalization.

**Changes:**

- Change array normalization to retain `[]`.
- Change metadata normalization to drop the field only when the input is not an
  array, not when the normalized result is empty.
- Add a pure resolver that takes provider, session value, and Settings defaults
  so every lifecycle path uses identical precedence.

**Tests:**

- `undefined` uses defaults.
- `[]` overrides enabled defaults.
- Non-empty explicit lists override rather than merge with defaults.
- Claude drops `workflows` from explicit and default lists.
- Codex retains `workflows`.
- OpenCode resolves to `[]`.

### Phase 4 — Thread live defaults through every initialization boundary

**Files:**

- `src/renderer/src/app/App.tsx`
- `src/renderer/src/workspace/hook/index.ts`
- `src/renderer/src/workspace/hook/refs.ts`
- `src/renderer/src/workspace/hook/actions/session.ts`
- `src/renderer/src/workspace/hook/persistence/rehydrate.ts`
- affected renderer test fixtures that construct `WorkspaceRefs`.

**Changes:**

- Subscribe to `settings.defaultBuiltInMcpDomains` in `App` and pass it into
  `useWorkspace`, matching the existing spawn-time dangerous/proxy settings.
- Mirror it in an identity-stable ref so async spawn/recovery callbacks read the
  latest preference without being recreated on every setting change.
- At fresh `spawn`, use an explicitly supplied array if present; otherwise seed
  from the ref. Filter for the provider and persist the resulting array even
  when empty.
- Apply the same resolution in the direct `recoverSession` paths used by
  hibernated wake and app rehydration. Those paths bypass ordinary `spawn` and
  would otherwise miss the setting.
- Replace truthiness-based metadata spreads with presence-aware spreads where
  necessary, documenting that empty arrays are deliberately durable.
- Preserve existing explicit arrays through replace, duplicate, split,
  undo-close, reload, rewind, and provider switch. Existing call sites already
  carry the field; tests will prove that the changed normalization does not
  erase `[]`.
- Allow orchestration children with no explicit domain request to receive the
  defaults. An explicit request, including `[]`, continues to win.

**Invariant:** settings are consulted only when session metadata/caller input
does not contain an array. They are never merged into an explicit session
snapshot.

### Phase 5 — Enforce provider support at UI and main boundaries

**Files:**

- `src/renderer/src/features/workspace/commands/sessionCommands.ts`
- `src/renderer/src/features/workspace/commands/sessionCommands.renderer.test.ts`
- `src/main/sessionManager.ts`
- `src/mcp/runtime/BuiltInMcpHttpHost.ts`
- `src/mcp/runtime/BuiltInMcpHttpHost.test.ts`
- affected `SessionManager` recovery tests/mocks.

**Renderer changes:**

- Use the shared provider/domain policy for every MCP command's `when` and
  runtime guard.
- Keep general MCP toggles available for Claude and Codex.
- Hide all built-in MCP toggles for OpenCode until injection exists.
- Make Workflow MCP visible and runnable only for Codex.
- Update Workflow command text and keywords to remove the false Claude claim
  and explain the native-feature reason.

**Main changes:**

- Pass the validated `AgentProviderKind` into
  `BuiltInMcpHttpHost.registerSession`.
- Filter domains inside the host before minting credentials or creating a
  scope. This is the authoritative capability boundary.
- Retain the existing production environment filter for `ping` after provider
  filtering.
- If every requested domain is unsupported, return no MCP server config.

**Why main must repeat the check:** renderer checks are product UX; main owns
the security/capability decision. Workspace files and IPC payloads are inputs,
not authority.

**Tests:**

- Codex registration retains Workflow MCP.
- Claude registration removes Workflow MCP while retaining supported sibling
  domains.
- A Claude request containing only Workflow MCP produces no server config.
- OpenCode requests produce no built-in MCP config.
- The Claude Workflow command is absent and its runtime guard is inert.
- The Codex Workflow command still replaces the session with the toggled list.

### Phase 6 — Lifecycle and regression coverage

**Files:**

- `src/renderer/src/workspace/hook/actions/mcpDomainContinuity.renderer.test.tsx`
- `src/renderer/src/workspace/hook/persistence/rehydrate.renderer.test.ts`
- `src/renderer/src/workspace/hook/persistence/sessionRecovery.integration.test.ts`
- `src/renderer/src/workspace/hook/actions/providerSwitchCore.renderer.test.ts`
- `src/main/sessionManager.recover.test.ts`

Add focused cases for:

- a fresh Codex session seeded from Settings;
- a fresh Claude session receiving all configured supported defaults but not
  Workflow MCP;
- toggling the final enabled domain off and preserving `[]` across replacement;
- rehydrating that explicit `[]` without reapplying defaults;
- a legacy session with no field adopting defaults and persisting the resolved
  list;
- provider switch from Codex to Claude removing Workflow MCP;
- undo-close and duplicate preserving an explicit empty array;
- an orchestration child respecting both defaults and an explicit override;
- stale Claude metadata containing `workflows` being narrowed before recovery.

Prefer extending the existing continuity/recovery tests over inventing broad
new harnesses. They already encode the important pane ownership and stable-ID
contracts that an MCP-specific happy-path test could accidentally bypass.

### Phase 7 — Reconcile documentation and misleading comments

**Files:**

- `docs/superpowers/plans/2026-07-14-workflow-mcp-integration.md`
- any touched comments that still claim Workflow MCP supports Claude.

The original Workflow MCP blueprint required both Claude and Codex. This PR
supersedes only that availability decision: Workflow execution remains
app-owned and Codex-driven, but the parent MCP surface becomes Codex-only to
avoid duplicating Claude's native workflow feature. Add a short correction to
the older live document rather than silently leaving contradictory guidance.

Do not rewrite historical implementation detail that remains true.

## Files expected to change

```text
docs/superpowers/plans/
  2026-07-14-workflow-mcp-integration.md
  2026-07-23-built-in-mcp-defaults-rollout.md

src/mcp/shared/types.ts
src/mcp/runtime/BuiltInMcpHttpHost.ts
src/mcp/runtime/BuiltInMcpHttpHost.test.ts
src/main/sessionManager.ts
src/main/sessionManager.recover.test.ts

src/renderer/src/app/App.tsx
src/renderer/src/app-state/settings/types.ts
src/renderer/src/app-state/settings/persistence.ts
src/renderer/src/app-state/settings/persistence.test.ts
src/renderer/src/app-state/store.ts
src/renderer/src/app-state/store.test.ts
src/renderer/src/features/settings/lib/settingsRegistry.ts
src/renderer/src/features/workspace/commands/sessionCommands.ts
src/renderer/src/features/workspace/commands/sessionCommands.renderer.test.ts
src/renderer/src/workspace/mcpDomains.ts
src/renderer/src/workspace/hook/index.ts
src/renderer/src/workspace/hook/refs.ts
src/renderer/src/workspace/hook/actions/session.ts
src/renderer/src/workspace/hook/actions/mcpDomainContinuity.renderer.test.tsx
src/renderer/src/workspace/hook/actions/providerSwitchCore.renderer.test.ts
src/renderer/src/workspace/hook/persistence/rehydrate.ts
src/renderer/src/workspace/hook/persistence/rehydrate.renderer.test.ts
src/renderer/src/workspace/hook/persistence/sessionRecovery.integration.test.ts
```

The final diff may touch additional test fixtures that construct
`WorkspaceRefs` or mock `registerSession`; those are mechanical contract
updates, not new architecture.

## Out of scope

- Enabling MCP injection in OpenCode.
- Creating separate per-provider default lists.
- Reloading all live agents when a default changes.
- Making defaults mandatory or preventing a per-session disable.
- Persisting MCP URLs, bearer tokens, or provider launch configuration.
- Exposing the diagnostic Ping domain in Settings.
- Changing workflow execution, storage, rendering, or the native Claude
  workflow feature.
- Dynamically adding/removing tools from an already running provider process.

## Verification

Run the focused suites while implementing, then the repository gates:

```bash
npx vitest run src/mcp/runtime/BuiltInMcpHttpHost.test.ts
npx vitest run src/main/sessionManager.recover.test.ts
npx vitest run src/renderer/src/app-state/settings/persistence.test.ts
npx vitest run src/renderer/src/app-state/store.test.ts
npx vitest run src/renderer/src/features/workspace/commands/sessionCommands.renderer.test.ts
npx vitest run src/renderer/src/workspace/hook/actions/mcpDomainContinuity.renderer.test.tsx
npx vitest run src/renderer/src/workspace/hook/persistence/rehydrate.renderer.test.ts
npx vitest run src/renderer/src/workspace/hook/persistence/sessionRecovery.integration.test.ts
npm run typecheck
npm run test:core
npm run test:system
npm run test:renderer
```

Before declaring the PR complete, manually verify:

1. Enable Orchestration MCP in Settings, create new Claude and Codex agents,
   and confirm both expose orchestration tools.
2. Disable Orchestration MCP from the session command, restart Agent Code, and
   confirm that pane remains off while another new pane starts on.
3. Enable Workflow MCP in Settings and confirm a new Codex agent receives it.
4. Confirm a new Claude agent has neither Workflow MCP tools nor Workflow MCP
   initialization instructions and offers no Workflow toggle command.
5. Switch a Workflow-enabled Codex pane to Claude and confirm the resulting
   session metadata and main registration omit `workflows`.
6. Confirm OpenCode exposes no built-in MCP toggles and receives no unused
   Agent Code MCP registration.

## Commit and PR sequence

This plan is the first commit on the implementation branch. The PR remains the
long-lived feature PR; neither its title nor the branch/worktree identifies it
as a documentation-only effort.

After plan approval, implementation should land in reviewable commits roughly
along these boundaries:

1. shared MCP provider/default policy;
2. Settings persistence and UI;
3. session initialization and explicit-empty continuity;
4. main/UI provider enforcement;
5. lifecycle regression tests and documentation reconciliation.

The PR is complete only when the code, focused tests, full repository gates,
and manual provider checks agree. Until this plan is approved, no phase above
will be implemented.
