# Optional Usage MCP: agents can read provider quota without root management (#1339)

Size: standard plan. The shape is known: one more built-in domain on the existing registration path. The choices are the tool's contract, the domain's gating and the cache policy.

## Outcome
An agent whose session has the new, **off-by-default** built-in domain `usage` can call `usage_read`. It gets the same sanitized per-provider quota snapshot the Usage UI and root management's `ac_usage_read` return (Claude, Codex, Grok, OpenCode/z.ai), without holding `root_management`.

## Evidence (verified 2026-09-27, do not re-derive)
- `src/main/usage/control.ts`: `usage.read` (exposed to root management as `ac_usage_read`) returns `{ snapshot }`. The handler is a JSON round trip of `getUsageSnapshot(input)` (`usageService.ts`, 30 s `USAGE_CACHE_TTL_MS`, in-flight de-duplication, per-source failure isolation). Its description says "OpenCode is not covered by this source". That is stale: `UsageSourceId` is `'claude' | 'codex' | 'grok' | 'opencode:zai'` since #1102.
- Domain plumbing, following `skills` (#1161) as the latest added domain:
  - `src/mcp/shared/types.ts`: `BuiltInMcpDomain`, `BUILT_IN_MCP_DOMAINS`, `CONFIGURABLE_BUILT_IN_MCP_DOMAINS`, `PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS`, and the per-provider lists (Claude's is explicit; the others spread the full list);
  - `src/mcp/runtime/createBuiltInMcpServer.ts`: tool registration and instructions;
  - `src/renderer/src/features/mcp/lib/builtInServers.ts`: Settings → MCP row.
- The fleet is reading quota by hand: the manager copies `ac_usage_read` into `temp/manager/usage.md` on every tick, because workers do not hold root management.

## Decisions (defaults; UNCONFIRMED)
1. **Tool contract: `usage_read`, with no `force` input.** It returns `{ snapshot }`, the same sanitized JSON as `ac_usage_read`. No `force`, because a fleet of agents polling with `force: true` would defeat the 30 s cache and hit every provider's quota endpoint once per call. The Usage UI and root management keep `force`.
2. **Gating:** configurable (it gets a Settings → MCP row, and orchestration create accepts it) and off by default (not in the shipped default set). It is not confirmation-gated (the tool is read-only, returns no credentials, and shows only numbers the user's own Usage screen shows), but it IS parent-held-only (review a): an orchestrating parent can grant it only if it holds it, so an agent never gets quota the user did not enable.
3. **Every provider** may carry it, like `mcp_servers`.
4. **One implementation.** `readUsageSnapshotForTools()` in `src/main/usage/usageService.ts` does the sanitize round trip. Both `usage.read` and the new tool use it, injected into the MCP host as a dependency, because `src/mcp` must not import main. It never reports a provider error as zero usage, which is the existing contract, unchanged.
5. **In passing:** fix `usage.read`'s stale "OpenCode is not covered" description.

## Change
- `src/mcp/shared/types.ts`: add `'usage'` to `BuiltInMcpDomain`, `BUILT_IN_MCP_DOMAINS`, `CONFIGURABLE_BUILT_IN_MCP_DOMAINS` and Claude's provider list.
- `src/mcp/runtime/usageTools.ts`: `registerUsageTools(server, dependencies)` and `USAGE_INSTRUCTIONS`. The dependency is `readUsageSnapshot?: () => Promise<unknown>`; when missing, the tool answers a curated "unavailable" error.
- `createBuiltInMcpServer.ts`: register the tool and its instructions when the domain is present.
- `src/main/usage/usageService.ts` and `control.ts`: the shared reader.
- `src/main/index.ts`: wire the dependency into the host.
- Settings → MCP row in `builtInServers.ts`.

## Tests
- **Tool boundary** (`usageTools.test.ts`): through a real in-memory MCP client, a session with `usage` and without `root_management` lists `usage_read` and not `ac_*`. It reads a **recorded snapshot fixture**, `testing/fixtures/usage/snapshot-2026-09-27.json`: a real `ac_usage_read` output from the owner's machine, provided by the manager, and read end to end before commit. The tool returns it unchanged for all four sources. A source with an error stays an error, never zero. There is no `force` in the input schema. A session without `usage` has no tool and no instructions.
- **Shared reader:** `usage.read` and `usage_read` return the same JSON for the same snapshot.
- **Settings:** the domain appears as a configurable row, off in the shipped defaults.

Each is red on main (the tool and domain do not exist).

## Out of scope
Choosing providers automatically from quota (the issue's separate follow-up).

## Review round 1 (a: FIX-BEFORE-MERGE, b: MERGE-READY)

- **a (major): an agent with only Orchestration could mint `usage` for a
  child** and read the quota back.
  - `usage` is now in `PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS`: a parent
    passes it on only when it holds it.
  - Pinned through the real `orchestration_create_agent`. Removing the
    entry turns 2 tests red.
- **a (minor): an auth-file error carried the absolute credential path.**
  `sanitizeUsageError` passed ANY message containing `auth.json`, so an fs
  error with the path, or a provider text naming the file, went through.
  - Only our own fixed "<Provider> auth.json …" messages keep their words.
    Everything else is "Its auth file (auth.json) could not be read."
    (q22).
  - This also changes the Usage screen for the better.
- **a (surviving mutation), residual:** `index.ts` composing
  `readUsageSnapshotForTools({ force: true })` is not caught. The
  composition line is untested, but the tool has no `force` input, and the
  shared reader's default is no force.
- **Steering q132 (SECURITY): prefix-shaped errors.** The gates were
  prefixes and substrings ("contains Keychain", "starts with <Provider>
  auth.json", "starts with Grok login expired"). "Codex auth.json
  /Users/alice/… token=abc" passed whole to agents.
  - `sanitizeUsageError` now keeps only EXACT first-party sentences
    (`FIRST_PARTY_USAGE_MESSAGES`).
  - Everything else is fixed text: the Keychain sentence, the auth-file
    sentence, or the per-provider fallback.
  - `usageErrorBoundary.test.ts` pins five prefix-shaped messages at the
    sanitizer, through the real Usage reader's error row, and through the
    real `usage_read` tool. All 10 cases were red on the previous head.
