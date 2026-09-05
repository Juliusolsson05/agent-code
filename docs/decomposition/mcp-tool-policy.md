# Preserve external MCP tool policy (#817)

## A → D
A: `externalCodexIntegration.ts` owns an exact-byte v1 marker around connection TOML. The observed local file contains five added nested tool approval tables within that marker. Its URL and bearer still match, but reconciliation rejects the changed block and `externalControl.ts` stops the listener.

D: retry/startup migrates this observed config safely, preserves per-tool policy through rotation, restart and disable/re-enable, and serves a real authenticated MCP initialize/tools-list exchange. True ownership edits still refuse without changing config/skill. No running app restart, pane changes or changes to the separate agent-names worktree.

## Stages
1. **Produces:** sanitized structural regression fixture and failing integration tests. **Verified by:** existing implementation reproduces the observed ownership rejection. **Why separate:** keeps tests tied to the incident rather than the eventual parser. **Reality check:** actual local TOML has nested approval tables following the original URL/header lines; no raw user config or credentials enter fixtures.
2. **Produces:** isolated config ownership reconciliation in the settings integration. **Verified by:** migration, policy-preservation lifecycle, conflict and TOML-scope tests. **Why separate:** settings/server transport should not parse TOML or arbitrate ownership. **Reality check:** recover only a prefix whose exact bytes match the recorded original hash; preserve the remaining policy bytes, verify the parsed before/after meaning. Keep owned connection markers narrow thereafter. When disabled with retained policy, leave an explicitly disabled URL-only connection (no bearer), so Codex retains a valid server definition and policy survives re-enable.
3. **Produces:** real HTTP verification, implementation commit and reviewable PR fixing #817. **Verified by:** authenticated initialize, tools/list and capability invocation through production settings + host on an ephemeral loopback listener after observed-shape migration, plus targeted checks. **Why separate:** parsing alone cannot prove settings leaves the listener running. **Reality check:** actual MCP protocol and production modules with temporary app/Codex homes; no live user agent actions.

## Isolation
Config ownership stays in the settings integration (extract a local module if needed); server transport, renderer settings and SDK never import its parsing internals. App-owned connection bytes and user-owned nested policy have separate ownership. Existing source/skill validation and compare-before-replace remain intact.

## Unknowns / constraints
- The writer that inserted the approval settings is not independently identified. Test the recorded structure, not attribution.
- Arbitrary reformatting or direct edits to the connection itself remain conflicts; this fix does not take ownership based only on a recognizable URL.
- TOML parent tables, multiline strings and comments can make naive marker relocation unsafe. Compare complete parsed semantics before writing.
- Live app still runs old code until a user-controlled update/restart; do not hot-patch that process.

## Validation record
- Stage 1 verified: the captured structural fixture fails against the original integration with the same ownership error; the credential-conflict assertion already passes.
- Stage 2 verified: `externalCodexConfig.ts` owns the pure transformation and has a single production consumer, the existing file integration. Migration preserves exact policy bytes; restart, policy edit, retry, rotation, disable/re-enable, unrelated tables and multiline-string/bare-key ownership boundaries pass. Existing symlink, skill ownership, unmanaged connection and invalid-table checks also pass.
- Stage 3 verified locally: 9 tests across 5 settings/transport files pass; full `npm run typecheck`, `npm run test:contract` and `git diff --check` pass. A separate curl trial runs the actual integration/settings/host against a private temporary copy of the current user config: initialize, tools/list and tools/call each return HTTP 200; the real status capability reports running; policy values are preserved; the live config remains byte-identical. The trial publishes only the real status capability and does not exercise live renderer agent controls.
- Codex's vendored `config/src/mcp_types.rs` confirms transport is required even for disabled servers, and `enabled = false` skips initialization. This is why retained policy uses a disabled URL-only definition rather than leaving an invalid policy-only table.
- No app restart or live configuration mutation was performed. The currently running app still needs the fixed build to recover. No merge authorization; PR/CI status will be tracked on #817.
