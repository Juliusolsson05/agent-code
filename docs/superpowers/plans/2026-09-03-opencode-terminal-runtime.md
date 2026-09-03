Status: In progress

# OpenCode terminal runtime implementation plan

Issue: #754

## Outcome

Keep the existing `OpenCode` HTTP/SSE renderer and add a separately selectable
`OpenCode Terminal` agent that runs the native OpenCode TUI in a PTY. The
terminal flavor must remain an agent session—not a plain shell—so it retains
Agent Code's managed-skill reconciliation and per-session built-in MCP scope.

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
6. Add focused tests for MCP configuration, PTY lifecycle, picker distinction,
   surface selection, and durable spawn/recovery propagation. Run typecheck,
   focused suites, then the repository's applicable checks.

## Verification

- `npm run typecheck`
- Focused Vitest files for the new runtime, launch config, picker policy, and
  workspace recovery
- `npm test`
- `npm run test:package` if the source-level suite and typecheck pass

