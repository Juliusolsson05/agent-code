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
Pending implementation. Plan is the first commit; PR will include the working fix, not just this document. No merge authorization.
