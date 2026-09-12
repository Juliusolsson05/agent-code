# Root Agent Code Management

Status: implemented, tests green, PR open for review.
PR: [agent-code#907](https://github.com/Juliusolsson05/agent-code/pull/907). Merge requires explicit approval.

Feature Issue: [agent-code#906](https://github.com/Juliusolsson05/agent-code/issues/906).
Branch: `feat/root-agent-code-management`. Worktree: `.worktrees/root-agent-code-management`.
Base: `origin/main` at `4c32a9cf8ca22c41d05bbbc0504f59270f8395b8` (2026-09-11).
This plan is the first commit on the branch; the implementation landed in
four follow-up commits on the same outcome-named branch.

## Outcome

A session command, **Root Agent Code Management**, gives one agent running
inside Agent Code the same application-wide control surface an external
operator gets: every window, project tab, agent, terminal and layout, through
the existing `ac_*` operator tools. It is a per-agent toggle, off by default,
never a Settings default, and turning it on requires a confirmation dialog that
says what the switch grants and why it is usually the wrong switch. Turning it
off reloads the agent without the tools and needs no confirmation.

The motivating moment is concrete: an agent has just audited the whole fleet
and the user wants that same agent, with its audit context, to reorganize the
workspace so only the work that needs attention stays open.

## What exists today, and why the boundary is deliberate

- `agent_management` (built-in MCP domain) is scoped to the caller's exact
  project tab. `src/renderer/src/workspace/agentManagementMcp.ts` enforces it
  with `agent_not_in_project`; the tool descriptions and instructions repeat it.
- The external operator server (`src/main/externalControlMcp/`) projects the
  control catalog (`src/control-sdk`, `src/main/control`) as `ac_*` tools. Its
  instructions end with: "This server is reserved for an external operator and
  is not installed in Agent Code agents." The Settings row says the same.
- `CONFIGURABLE_BUILT_IN_MCP_DOMAINS` is a closed list so a persisted default
  cannot turn a diagnostic or dangerous domain on for every new agent (see the
  `ping` WHY comment in `src/mcp/shared/types.ts`).

Root management crosses the second boundary on purpose, for one agent, after an
explicit confirmation. It must not weaken the first or third.

## Design

### Domain, not a flag

`root_management` becomes a `BuiltInMcpDomain`:

- listed in `BUILT_IN_MCP_DOMAINS` and in every provider's supported list
  (Claude, Codex, OpenCode all inject built-in MCP at launch);
- **absent** from `CONFIGURABLE_BUILT_IN_MCP_DOMAINS`, so the Settings defaults
  normalizer drops it and no "for New Agents" row can exist for it.

WHY a domain rather than a separate SessionMeta flag: domains already ride
`builtInMcpDomains` through spawn, reload, provider switch, duplicate and
rewind (`mcpDomainContinuity`), are minted into the scoped MCP token by main,
and are what the MCP server reads to decide which tools to register. A parallel
flag would need every one of those paths taught a second field, and would drift.

### Tool projection reuses the operator catalog

`src/main/externalControlMcp/tools.ts` currently owns the descriptor → MCP tool
projection for the low-level `Server` used by the external HTTP host. It gains
`registerOperatorControlTools(server: McpServer, port: ControlOperatorPort)` for
the high-level `McpServer` the built-in host uses. Both projections derive from
one descriptor listing (`operatorToolCatalog`) and one invocation path
(`invokeOperatorTool`), so names, `_control` routing, application-visibility
hiding and the result envelope cannot diverge.

Constraint that shaped this: `McpServer.registerTool` accepts only Zod schemas,
while window capabilities cross IPC as JSON Schema. Zod 4.4 ships
`z.fromJSONSchema`; a probe confirmed the merged input schema (capability input
plus `_control`) round-trips with descriptions, `additionalProperties: false`,
`$ref` recursion for `z.json()` and enum/nullable shapes intact. The built-in
projection converts the exact JSON schema the external projection publishes.
If conversion ever throws for a descriptor, that tool is registered with a
permissive object schema and the original JSON schema embedded in its
description, and the app-run journal records it; the capability still validates
its own input on execute. Output schemas are not published on the built-in
path: the envelope is described in prose and clients inside Agent Code do not
consume `outputSchema`.

Import boundaries (`src/control-sdk/importBoundaries.test.ts`): only
`src/main/index.ts` may import `externalControlMcp`, and `externalControlMcp`
may import only the SDK entry point and npm packages. So `createBuiltInMcpServer`
does not import the projection; main composition injects a registrar
dependency, `rootControlTools(server, sessionId)`, which the built-in server
calls when the scope carries `root_management`. Main builds the port with
`controlHost.forCaller({ kind: 'agent', id: sessionId })`.

### Caller identity

`ControlCaller.kind` gains `'agent'`. The executor's application-visibility
rule changes from "refuse external" to "allow only application", so an agent
caller can never reach `externalControl.configure` or the task-lifecycle
capabilities even if a future projection forgot to hide them. Durable control
history records `agent:<sessionId>` as the caller, which is the audit trail the
user wanted for a switch this broad.

### Instructions

`createBuiltInMcpServer` adds root instructions when the domain is on: the
switch was a deliberate user action; the tools are application-wide; start with
`ac_app_describe`; use stable session and tab IDs; the caller's own session ID
is named so it never closes, buries, detaches, reloads or switches itself;
prefer reads and the smallest layout change; never close, kill, bury, restore,
switch providers for or prompt another agent unless the user's current request
names that agent or outcome; the app's confirmation dialogs still apply and a
declined dialog is a refusal, not a retry.

### Command and confirmation

- Command id `enable-root-agent-code-management`, category `session`, surface
  `session`, picker tier `advanced`, toggle badge from the session's domains,
  risk `destructive` (it can end and rearrange sessions app-wide).
- **On → confirm first.** The command opens `rootManagementPromptSessionId` on
  the UI shell (same shape as the bury and title prompts, so Dispatch focus
  drift cannot retarget it). The dialog, `RootManagementConfirmDialog`, shows
  the agent's identity, a "What this turns on" list, a "Why this is usually the
  wrong switch" list, an acknowledgement checkbox that gates the confirm
  button, and the note that confirming reloads the agent. Confirm calls the
  shared reload helper with the domain added to the session's existing domains
  and pins `targetSessionId`. Cancel, Escape and the overlay change nothing.
- **Off → reload immediately** without the domain, mirroring the other MCP
  toggles.
- The reload helper (`reloadSessionWithBuiltInMcpDomains`) is the single owner
  of "replace this session with these domains and toast the result" for the
  root paths. The five existing toggles keep their inline copies for now; a
  later cleanup can move them once their small differences (target pinning)
  are reconciled deliberately.

### Composition order in `src/main/index.ts`

`builtInMcpHost.setDependencies` refuses to run after any session registers,
and today it runs before the control host is created. The control host block
(external settings, host, `forCaller`) moves above the dependency injection so
the registrar closes over a constructed host instead of a later `const`.

## Tests

- `src/mcp/shared/types.test.ts`: `root_management` normalizes as a domain,
  is dropped by the configurable-defaults normalizer, and is supported by all
  three providers.
- `src/main/externalControlMcp/tools.test.ts` (new): for one fixture catalog
  (recursive JSON input, nullable/enum shapes, an application-only capability)
  the `Server` and `McpServer` projections publish the same tool names, input
  properties and property descriptions; a call through the `McpServer` path
  reaches `port.invoke` with the same `input`, `owner` and `requestKey` as the
  external path; the application-only capability is neither listed nor callable
  on either.
- `src/mcp/runtime/createBuiltInMcpServer.test.ts`: the domain calls the
  registrar with the server and the scope's session ID and adds the root
  instructions; without the domain no `ac_*` tool exists; with the domain but
  no registrar the server still builds and records the gap.
- `src/control-sdk/core/executor.visibility.test.ts` (new): an `agent` caller
  is refused application-only capabilities; an `application` caller is not.
- `sessionCommands.renderer.test.ts`: enabling opens the confirmation and does
  not reload; disabling reloads without the domain and without a prompt.
- `RootManagementConfirmDialog.renderer.test.tsx` (new): confirm is disabled
  until acknowledged; confirm and cancel reach their callbacks.
- `builtInMcpReload.test.ts` (new): the helper adds the domain to existing
  domains, pins the target session, and toasts the enabled/disabled outcome.

Verification: `tsc -b` on both projects under Node 24, the touched suites,
`npm run test:contract`, and CI's quality gate on the PR.

## Out of scope

- Making the five existing MCP toggles share the reload helper.
- A Settings default for root management (deliberately impossible).
- Following the reorganization itself; that is the user's next request once
  the capability exists.
