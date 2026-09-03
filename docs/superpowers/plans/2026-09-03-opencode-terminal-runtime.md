Status: Complete

# OpenCode terminal runtime implementation plan

Issue: #754

## Outcome

Keep the existing `OpenCode` HTTP/SSE renderer and add a separately selectable
`OpenCode Terminal` agent that runs the native OpenCode TUI in a PTY. The
terminal flavor must remain an agent session—not a plain shell—so it retains
Agent Code's managed-skill reconciliation and per-session built-in MCP scope.

Make OpenCode a complete member of the neutral transcript-transform graph at
the same time. Known OpenCode sessions—including those created by the terminal
runtime—must support export-backed parsing, duplication, rewind, and switching
to/from Claude and Codex through the `agent-transcript-parser` package.

## Design constraints

- Do not add `opencode-terminal` to `AgentProviderKind`. Both choices use the
  same installed `opencode` CLI, setup prerequisite, updater, skill locations,
  and provider identity. Treating the runtime flavor as a fourth provider would
  duplicate those authorities and make provider-wide tools misreport support.
- Persist an optional provider runtime flavor on session metadata and carry it
  through spawn, lazy recovery, undo, duplication/placement, and main-process
  backend snapshots. Missing data continues to mean the existing structured
  runtime, preserving old workspaces.
- Give the main OpenCode provider an explicit terminal-session factory. The
  generic session manager still owns skill reconciliation, MCP registration,
  lifecycle forwarding, PTY replay buffering, and ownership; only the provider
  owns how its native TUI is launched.
- Inject built-in MCP servers with OpenCode's documented
  `OPENCODE_CONFIG_CONTENT` runtime override. Merge any existing inline JSON and
  reference generated environment variables from headers so bearer values do
  not appear in argv or project files.
- Force terminal-flavor OpenCode sessions onto `AgentTerminalLeaf`. Global and
  per-pane Agent/Hybrid view settings must not mount the immature renderer for
  this flavor, while ordinary OpenCode remains pinned to its existing rendered
  surface.
- Treat `opencode export` and `opencode import` as the only durable transcript
  boundary. OpenCode owns SQLite storage and migrations; Agent Code and the
  parser must never reach into that private database.
- Compose provider switching through `ConversationDocument`, preserving the
  one-decoder/one-projector-per-provider architecture. Do not add six pairwise
  translators for the three-provider graph.
- Refuse an unfinished OpenCode export before a switch/duplicate/rewind can
  replace a live pane. The native TUI does not emit a reliable busy/idle signal,
  but a completed assistant timestamp is durable evidence at the CLI boundary.

## Implementation

1. Add shared runtime-flavor types to the session spawn/recovery/backend
   contracts and renderer `SessionMeta`; thread the field through IPC and every
   session recreation path.
2. Implement `OpencodeTerminalSession` with node-pty lifecycle, input, resize,
   exit, process identity, minimal provider-neutral conditions/readiness events,
   resume CLI arguments, and safe OpenCode MCP launch configuration.
3. Register the terminal factory beside the existing structured OpenCode
   factory and make `SessionManager` select it only for the validated
   OpenCode-terminal flavor.
4. Add an explicit `OpenCode Terminal` choice to the new-agent picker and carry
   the choice through grid, Dispatch, and linked-agent creation.
5. Update surface selection so terminal-flavor sessions always render the raw
   agent terminal while ordinary OpenCode keeps its structured renderer.
6. Extend `agent-transcript-parser` with an OpenCode export decoder, native
   import projector, exact prompt addresses, unknown-part preservation, and a
   portable-handoff rule for oversized context.
7. Register a host OpenCode adapter that exports/imports through the installed
   CLI, resolves project model metadata, and participates in all six directed
   Claude/Codex/OpenCode switch edges plus duplicate and rewind.
8. Add focused tests for MCP configuration, PTY lifecycle, picker distinction,
   surface selection, and durable spawn/recovery propagation. Run typecheck,
   focused suites, then the repository's applicable checks.

## Verification

- Root contract, checked-in live-fixture, keybinding, TypeScript, and live-resume
  probe checks passed.
- The focused OpenCode/runtime/switch/recovery matrix passed: 15 files / 97
  tests. The MCP policy and host authorization rerun passed: 4 files / 22 tests.
- The parser package's full `npm run check` passed: contract, typecheck, 24 test
  files / 100 tests, build, and packed-artifact verification.
- Isolated OpenCode 1.18.27 CLI `import` → `export` verification passed for a
  blank session and a projected two-message conversation using temporary XDG
  state (no personal OpenCode data).
- The root production application build and packaged-entry verification passed
  with the parser gitlink pinned to its implementation commit.
- The complete root test run reached 351 files / 2,501 tests. 2,498 passed. Two
  unrelated fixed-timeout tests failed only under whole-suite resource
  contention and passed together when rerun (2 files / 17 tests). The remaining
  unrelated provenance assertion references a developer-local Claude transcript
  that no longer exists; it is intentionally active only when a personal corpus
  root exists and is absent on clean CI runners.
