# Project-wide Agent Management MCP — Implementation Plan

Status: Implemented and verified on the feature branch; ready for PR review.

Date: 2026-07-23

Feature branch: `feat/project-wide-agent-control`

Feature worktree: `.worktrees/project-agent-control`

Planned PR title: `Add project-wide agent management MCP`

Baseline: `main` at `aa7ac46d`

## Goal

Add a distinct built-in MCP capability that lets one Agent Code agent manage
the other open agents in its own Agent Code project. The caller must be able to:

- list every open agent assigned to the same project, regardless of whether it
  is in the grid, parked in Dispatch, or buried;
- read a bounded, user-visible transcript for one agent or every other agent
  in the project as one budgeted cleanup-review snapshot;
- send a follow-up prompt to one of those agents, waking a parked backend when
  necessary; and
- close one of those agents only when the user explicitly asked for that close.

The finished provider-facing surface is:

| Tool | Purpose |
| --- | --- |
| `agent_management_list_agents` | List all open project agents with transcript locations, lifecycle, and last-activity evidence. |
| `agent_management_read_agent` | Read a bounded clean transcript from one listed agent. |
| `agent_management_read_agents` | Read bounded transcript tails across the project for review/cleanup recommendations. |
| `agent_management_send_prompt` | Send a prompt to one listed agent through its native provider delivery path. |
| `agent_management_close_agent` | Destructively close one explicitly named agent, subject to strict scope and cascade guards. |

This is deliberately not an expansion of Orchestration MCP. Orchestration is a
parent/child coordination API: it may inspect and mutate only children owned by
the caller's orchestration root. Agent Management is a project operator API: it
can see manual agents, linked agents, and orchestration agents that share the
caller's project, but it cannot cross into another project.

## User-visible behavior

The capability is a new independently configurable built-in MCP domain. It is
off by default, can be enabled for new agents in Settings, and can still be
toggled on or off for one existing session through the command picker. Like the
other built-in domains, changing a live session's setting replaces/reloads the
provider process because Claude and Codex discover MCP tools at launch.

A typical interaction should look like:

```text
User: Ask the other agents in this project what they are working on.

Caller:
  agent_management_list_agents
  -> sees manual, linked, and orchestration agents in this project

  agent_management_read_agent(sessionId=...)
  -> receives bounded visible conversation, not raw provider event noise

  agent_management_send_prompt(sessionId=..., prompt=...)
  -> target is woken if parked, then receives the prompt through its provider
```

The primary fleet-cleanup interaction should not require an N-call manual loop:

```text
User: Read all the agents in this project and tell me what looks safe to clean up.

Caller:
  agent_management_list_agents
  -> sees transcript path/availability, last meaningful activity, live state,
     placement, and relationships for every open agent

  agent_management_read_agents
  -> receives bounded recent transcript output for every other project agent,
     under one cross-agent character budget

  -> reports evidence-based recommendations in three groups:
       active / do not close
       uncertain / inspect first
       likely cleanup candidate
  -> DOES NOT call close_agent
```

The list remains a cheap inventory rather than embedding transcript bodies. The
bulk read exists so cleanup review gets the same project snapshot and bounded
degradation behavior across a large fleet instead of issuing dozens of serial
single-agent reads or overflowing the caller's context.

Closing has a stronger policy:

```text
User: Close agent 4.

Caller:
  agent_management_close_agent(sessionId=<agent 4>)
  -> succeeds only if the target is still in scope and closing it affects no
     unnamed session
```

“Tell me what is safe to clean up,” “review the agents,” “manage the project,” a
completed task, inactivity, or a failed read is permission to assess and
recommend only. It is not permission to close anything. The close tool's
initialization instructions and description must say that it is callable only
when the current user request explicitly asks to close the named agent. The tool
is annotated as destructive. List/read/send/review do not grant or imply close
permission.

## Definitions and scope

### “Project” means project-tab ownership, not cwd equality

Agent Code's durable workspace model treats a tab as the project-affinity
boundary. A project tab owns:

- grid leaves in `Tab.root`;
- Dispatch records whose `projectTabId` names that tab; and
- buried records whose `sourceTabId` names that tab.

The cwd is session launch metadata. It is not a safe project authority: two
project tabs can point at the same cwd, and an agent assigned to one project tab
can intentionally run in a sibling worktree. Therefore the caller's MCP
`scope.cwd` must never be used as “same project” authorization.

Every tool request derives the caller's project tab from the renderer's current
workspace ownership graph using the caller session ID from the authenticated MCP
scope. The model does not provide a project ID. A target is authorized only if
the same resolver assigns it to that exact tab at the moment of the operation.

### “Open agent” means owned session metadata, not only a live process

`WorkspaceState.sessions` is the durable metadata map for sessions owned by a
grid, Dispatch, or buried surface. Detached and buried sessions intentionally
hibernate after an app restart and may have no `SessionManager` backend until
they are used again. They are still open user-owned agents and must appear in
the list.

The inventory excludes:

- terminals;
- stale/unowned metadata rows;
- historical provider transcripts that are not open in the workspace; and
- every session owned by another project tab, even when its cwd matches.

The caller itself remains in the inventory with `isCaller: true` so “all open
agents” is literal and the result explains why that row is not actionable.
Sending a prompt to or closing the caller is rejected: delivering input into a
provider that is synchronously waiting on its own MCP result can corrupt the
composer, while closing it can destroy the transport before the tool result is
returned.

### Reads, sends, and closes have different wake behavior

- Listing is metadata/status only and never wakes a backend.
- Reading uses the renderer's provider-normalized feed and may hydrate durable
  history from disk, but never starts a provider process merely to inspect it.
- Sending wakes a hibernated target under its existing Agent Code session ID,
  revalidates project membership, then uses the provider's hardened prompt
  delivery implementation.
- Closing never wakes a target. It removes live or hibernated workspace
  ownership through the renderer's lifecycle action.

This distinction prevents a read-only management call from recreating dozens of
parked Claude/Codex processes and per-session proxies after a restart.

## Current architecture

### The built-in host is one authenticated server with domain slices

`BuiltInMcpHttpHost` owns one loopback Streamable HTTP listener. Every live
provider session receives a random bearer token bound to:

```ts
type McpSessionScope = {
  sessionId: string
  cwd: string
  domains: BuiltInMcpDomain[]
}
```

`createBuiltInMcpServer` creates a cheap request-scoped `McpServer` and
registers only tools allowed by that token's domains. The new feature should
follow that model as an `agent_management` domain. It must not start a second
HTTP listener or introduce another credential path; “new MCP server” means a
new independently selectable built-in tool domain on the existing secure host.

The provider matrix remains centralized in `src/mcp/shared/types.ts`:

| Domain | Claude | Codex | OpenCode |
| --- | :---: | :---: | :---: |
| `agent_management` | Yes | Yes | No |

OpenCode remains excluded because its launcher does not inject Agent Code's
built-in MCP configuration yet. This feature may manage an OpenCode target from
a Claude/Codex caller when that target exists in the same project, but an
OpenCode session cannot itself be an MCP caller until the provider launch path
supports built-ins.

### Main owns the MCP connection; renderer owns project truth

Main has the authenticated caller session and provider delivery services, but
`SessionManager` only knows active processes plus launch cwd. It does not own
tabs, grid placement, Dispatch affinity, buried records, titles, or hibernated
workspace sessions.

The renderer has the full workspace graph and provider-normalized feed, but it
must not host MCP networking. The existing `OrchestrationBridge` solves the same
process-boundary problem for parent-owned children by sending correlated typed
requests from main to renderer. Agent Management needs a separate bridge and
contract because its authority and lifecycle rules are different.

```text
Claude/Codex caller
  -> bearer-scoped BuiltInMcpHttpHost (main)
  -> agent_management_* tool handler
  -> AgentManagementBridge (main, correlated + serialized)
  -> preload IPC
  -> renderer workspace snapshot
       resolve caller project from scope.sessionId
       re-resolve target membership for every operation
       read/mutate through canonical workspace actions
  -> typed result back to MCP caller
```

The new bridge must not be folded into `OrchestrationBridge`. That class carries
orchestration-specific prompt counters, child-to-parent caches, closed-agent
tombstones, run reads, and ownership semantics. Sharing those would let one
policy accidentally authorize the other. A small duplicated correlated-request
shell is preferable to coupling the two authority models; a generic bridge
extraction may be considered only if it leaves orchestration behavior and tests
unchanged.

## MCP contract

### Domain and server instructions

Add `agent_management` to `BuiltInMcpDomain`, the configurable-domain list, and
the Claude/Codex provider allowlists. It remains absent from the default setting
until the user opts in.

`createBuiltInMcpServer` currently supplies workflow-only initialization
instructions. Change instruction composition so enabled domains can contribute
independent paragraphs. When `agent_management` is enabled, initialization must
state:

1. project-agent tools are limited to the caller's current Agent Code project;
2. cleanup-review requests should use the inventory plus bulk transcript read,
   distinguish active/uncertain/likely candidates, and cite the evidence behind
   each recommendation rather than treating age alone as proof;
3. asking what is safe to clean up authorizes assessment only;
4. reading or sending a prompt does not grant permission to close the target;
   and
5. `agent_management_close_agent` may be called only when the current user
   request explicitly asks to close that specific agent.

Workflow instructions must remain unchanged when Workflow MCP is the only
instruction-bearing domain.

### Shared records

Add a boundary-neutral contract under
`src/mcp/shared/agentManagementTypes.ts`. The exact record may evolve during
implementation, but it must carry enough information for the model to identify
targets without leaking provider internals:

```ts
type ManagedAgentPlacement = 'grid' | 'dispatch' | 'buried'

type ManagedAgentBackendState =
  | 'live'
  | 'spawning'
  | 'hibernated'
  | 'failed'

type ManagedAgentRecord = {
  sessionId: string
  kind: AgentProviderKind
  cwd: string
  title?: string
  project: {
    tabId: string
    title: string
    index: number
  }
  placement: ManagedAgentPlacement
  backendState: ManagedAgentBackendState
  activityState: 'running' | 'waiting' | 'completed' | 'failed' | 'unknown'
  statusSummary?: string
  transcript: {
    path: string | null
    availability: 'available' | 'not_created' | 'provider_managed' | 'unavailable'
    lastModifiedAt?: number
  }
  lastActivityAt?: number
  lastActivitySource?: 'transcript' | 'runtime' | 'backend'
  idleForMs?: number
  processActive: boolean
  awaitingAssistant: boolean
  requiresUserAction: boolean
  conditionSummary?: string
  isCaller: boolean
  linkedParentId?: string
  orchestrationParentId?: string
  orchestrationRootId?: string
  orchestrationRunId?: string
  orchestrationRole?: string
}
```

The canonical transcript path is intentionally exposed because it is one of the
main fleet-audit handles: the caller can identify exactly which durable session
was reviewed and, when Agent Transcripts MCP is also enabled, use that path for
a deeper projection. This domain never accepts an arbitrary path from the model.
It resolves only the authorized target's provider transcript from main-owned
observed state or durable `{kind, cwd, providerSessionId}` metadata. Return
`path: null` with an honest availability reason when the provider has no durable
file.

Do not expose MCP bearer material, provider command lines, raw screen buffers,
or a transcript path belonging to an agent outside the authorized project.

### `agent_management_list_agents`

Input: no project/cwd selector. Optional status filters can be added only if the
unfiltered result remains the default.

Output:

```ts
{
  ok: true
  observedAt: number
  project: { tabId: string; title: string; index: number }
  agents: ManagedAgentRecord[]
}
```

Ordering is deterministic: project placement order first (grid depth-first,
Dispatch oldest-detached-first, buried order), with defensive de-duplication.
The list path derives status without materializing transcript text, matching the
existing orchestration polling optimization.

Every record includes the canonical transcript path when one can be resolved,
its availability/mtime, and last-activity evidence. `lastActivityAt` is the most
recent meaningful timestamp among normalized transcript messages, runtime
turn/phase changes, and main's observed backend activity; `lastActivitySource`
states which signal won, and `idleForMs` is computed against one response-level
`observedAt` timestamp so every row's age is comparable. The raw components must
remain distinguishable internally and in tests: a screen repaint/heartbeat is
weaker cleanup evidence than a recent user or assistant transcript message.
Current provider conditions are summarized as `requiresUserAction` plus a safe
condition label; an agent waiting on trust, permission, or a user answer must
not look like an idle completed cleanup candidate.

Transcript resolution follows this order:

1. main's observed `SessionManager.resolveTranscriptFile` for a live session;
2. the provider registry resolver using authorized durable session metadata;
3. `null` plus `not_created`, `provider_managed`, or `unavailable`.

Codex path discovery can scan a date-bucketed global rollout tree. Resolve in a
bounded/coalesced batch keyed by provider session ID instead of starting one
full tree walk per row. Listing a large fleet must not become N concurrent Codex
filesystem scans.

Annotations: `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`.

### `agent_management_read_agent`

Input:

```ts
{
  sessionId: string
  maxMessages?: number          // 1..100
  maxCharsPerMessage?: number   // 50..100_000
  maxCharsPerAgent?: number     // 100..500_000
}
```

Output contains the managed-agent record, bounded user/assistant messages, the
latest assistant excerpt, and `truncated`/`totalChars` metadata. Defaults and
truncation markers must match Orchestration MCP (`20` messages, `4_000` chars
per message, `24_000` chars per agent) so models see one bounded-read dialect.

The implementation should extract provider-neutral visible-message budgeting
from `orchestrationMcp.ts` rather than create a second almost-identical scanner.
Orchestration keeps its inherited-context cut and record-specific lifecycle
overlay; Agent Management reads the target's complete user-visible session
conversation. Raw tool-event projections remain the separate Agent Transcripts
MCP responsibility.

For hibernated Claude/Codex sessions, await the existing initial-history loader
against durable provider metadata and then read the normalized runtime. Do not
call `ensureSessionLive`. If no durable history exists—for example a parked
OpenCode session after its server-owned history disappeared—return a typed
`transcript_unavailable` result rather than waking the agent or pretending an
empty transcript is complete.

Annotations: `readOnlyHint: true`, `destructiveHint: false`.

### `agent_management_read_agents`

This is the project-fleet review primitive behind “read all agents in this
project and tell me what looks safe to clean up.” It is not a close or cleanup
mutation.

Input:

```ts
{
  // Absent means every other open agent in the caller's project. An explicit
  // subset is useful for re-reading only the uncertain candidates.
  sessionIds?: string[]
  includeCaller?: boolean       // default false; avoids echoing current context
  maxMessagesPerAgent?: number // 1..100
  maxCharsPerMessage?: number  // 50..100_000
  maxCharsPerAgent?: number    // 100..500_000
  maxTotalChars?: number       // 1_000..1_000_000
}
```

The default all-project read excludes the caller's own transcript because that
conversation is already in the caller's model context and cannot be a close
target. The response still includes the caller's inventory record, explicitly
marked `isCaller`, so the project census remains complete. `includeCaller: true`
supports a literal archival “read every transcript” request. If `sessionIds` is
provided, every ID must resolve to a current agent in the project; one
cross-project or unknown ID fails the request instead of returning a partially
authorized result. Including the caller in a read never grants self-prompt or
self-close authority.

Output:

```ts
{
  ok: true
  observedAt: number
  project: { tabId: string; title: string; index: number }
  agents: ManagedAgentRecord[] // complete census; never dropped for text budget
  outputs: ManagedAgentTranscriptOutput[]
  unavailable: Array<{
    sessionId: string
    reason: 'transcript_unavailable' | 'not_created'
  }>
  truncated: boolean
  totalChars: number
}
```

Apply per-message/per-agent caps first, then one cross-agent total budget using
the same fairness rule as orchestration run reads: preserve a status record and
short newest-assistant excerpt for every agent before spending remaining budget
on fuller tails. A large early transcript must not consume the budget and make
later agents disappear. Default to a review-sized tail (six messages per agent,
`4_000` chars per message, `24_000` per agent, `200_000` total); callers can
re-read one uncertain agent with `agent_management_read_agent`.

History hydration is bounded and concurrency-limited. Durable hibernated agents
are read without waking them. Agents with no durable readable transcript stay
in `agents` and `unavailable` so missing evidence cannot be mistaken for an
empty/completed conversation.

The MCP initialization guidance should tell the caller how to reason from this
response:

- `running`, `processActive`, `awaitingAssistant`, `requiresUserAction`, a live
  condition, or very recent transcript activity means do not recommend closing;
- an old hibernated/completed agent whose recent transcript contains a clear
  final handoff may be a likely cleanup candidate;
- missing/truncated transcript, unresolved user requests, tool work without a
  final response, uncertain delivery, or unknown activity belongs in an
  “inspect first” group; and
- transcript/lifecycle evidence cannot prove the worktree is clean unless the
  transcript or another tool actually checked it. Say what is unknown.

The model returns recommendations to the user with session ID/title, transcript
path when present, last activity, and evidence. It must wait for a later explicit
close instruction before calling `agent_management_close_agent`.

Annotations: `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`.

### `agent_management_send_prompt`

Input:

```ts
{
  sessionId: string
  prompt: string // trimmed, non-empty, bounded
}
```

The renderer handler performs this sequence inside one serialized management
request:

1. derive the caller project from the authenticated caller session ID;
2. authorize the target in that project and reject the caller itself;
3. wake the target through `ensureSessionLive` if needed;
4. re-read current workspace state and repeat project authorization after the
   await; and
5. call `window.api.deliverPrompt` so `SessionManager.deliverPromptToAgent`
   selects Claude, Codex, or OpenCode's hardened provider protocol.

Do not wrap the text in an orchestration bootstrap prompt and do not mutate
orchestration prompt counters. This is a normal user-authored follow-up to an
existing session, regardless of how that session was originally created.

Return the provider delivery disposition faithfully: retry-safe pre-write
failure is different from an uncertain post-write failure and must never lead
the model to duplicate a possibly submitted task.

Annotations: `readOnlyHint: false`, `destructiveHint: false`,
`idempotentHint: false`.

### `agent_management_close_agent`

Input:

```ts
{ sessionId: string }
```

The close description must begin with its policy, not bury it in notes:

> Destructive. Call only when the current user explicitly asks to close this
> specific agent. Never infer close permission from task completion, inactivity,
> a request to assess what looks safe to clean up, an error, or permission to
> list/read/prompt agents.

Annotations: `readOnlyHint: false`, `destructiveHint: true`,
`idempotentHint: false`.

MCP does not expose the caller's raw user message to the server. The server can
therefore enforce project/target/blast-radius facts, but it cannot cryptographically
prove the semantic fact “the user explicitly asked.” Do not add a model-supplied
`confirmed: true` field and call it enforcement; the same model choosing to call
the tool would also choose the boolean. The honest v1 boundary is explicit MCP
policy plus structural server guards. A future hard semantic gate would require
a host-minted user approval token or an interactive Agent Code confirmation UI,
which is outside this feature unless plan review requests it.

Structural guards are mandatory:

- reject the caller's own session;
- re-resolve caller and target project membership immediately before mutation;
- reject targets missing from current owned workspace state;
- close through renderer lifecycle actions so workspace metadata, backend
  ownership, runtime state, Dispatch state, undo bookkeeping, and toasts stay
  consistent; and
- reject with `close_would_affect_additional_sessions` if the canonical close
  action would cascade into any unnamed linked child, detached sibling, buried
  record, terminal, or other project session.

That final guard matters because closing the last grid leaf currently closes its
project tab and detached children, and closing a linked parent recursively closes
linked children. A tool named “close one agent” must not silently widen into
“close this project.” The error returns the additional affected session IDs so
the model can explain the conflict. If the user explicitly asks to close several
agents, the model may close those agents individually, children/detached agents
first, until the final single-target close has no hidden cascade.

Buried targets use the buried lifecycle action; detached/grid targets use the
explicit session close path. Closing never wakes a hibernated backend.

## Detailed implementation phases

### Phase 1 — Add the domain and shared contracts

**Files:**

- `src/mcp/shared/types.ts`
- `src/mcp/shared/types.test.ts`
- new `src/mcp/shared/agentManagementTypes.ts`
- affected exhaustive fixtures that spell every built-in domain.

**Changes:**

- Add `agent_management` to the built-in and configurable domain lists.
- Allow it for Claude and Codex; keep OpenCode unsupported as an MCP caller.
- Define renderer request/response unions, public records, transcript locator
  and activity evidence, single/bulk bounded transcript outputs, delivery
  result, and typed errors.
- Update orchestration child-domain schema construction so an explicitly
  configured child may receive the new domain without another hand-maintained
  string union drifting from `BUILT_IN_MCP_DOMAINS`.

**Tests:**

- normalization accepts/deduplicates the new domain;
- configurable defaults retain it;
- provider filtering accepts Claude/Codex and removes it for OpenCode; and
- invalid/stale values cannot become domains.

### Phase 2 — Build the renderer project authority and transcript projection

**Files:**

- new `src/renderer/src/workspace/agentManagementMcp.ts`
- new `src/renderer/src/workspace/agentManagementMcp.test.ts`
- `src/renderer/src/workspace/orchestrationMcp.ts`
- a new small provider-neutral visible-message helper if extraction is needed.

**Changes:**

- Implement one project-affinity resolver covering grid, Dispatch, and buried
  ownership, with ambiguous/corrupt ownership failing closed.
- Build deterministic all-agent inventory from that resolver and filter through
  `isAgentProviderKind`.
- Derive placement, project metadata, relationships, backend/activity state,
  and caller identity without transcript scanning.
- Extract/reuse bounded visible message projection while preserving
  orchestration-specific inherited-context behavior.
- Build a fair cross-agent transcript budget that retains every agent's status
  and newest useful excerpt before allocating fuller tails.
- Add pure close-impact calculation so a single-agent tool can reject implicit
  tab/linked cascades before mutation.

**Tests:**

- same tab plus different worktree cwd is allowed;
- same cwd plus different tab is denied;
- grid, detached, and buried agents are included exactly once;
- terminals and orphan metadata are excluded;
- manual, linked, and orchestration agents are all visible;
- caller row is marked but self send/close is denied;
- transcript budgets/truncation match orchestration;
- bulk reads do not let one large transcript erase later agents;
- unavailable histories remain explicit rows rather than empty successes; and
- every implicit cascade shape is detected before close.

### Phase 3 — Add a dedicated main/renderer bridge

**Files:**

- new `src/main/agentManagement/AgentManagementBridge.ts`
- new `src/main/agentManagement/AgentManagementBridge.test.ts`
- new `src/main/ipc/agentManagement.ts`
- new `src/preload/api/agentManagement.ts`
- `src/preload/api/index.ts`
- `src/main/ipc/index.ts`
- `src/main/index.ts`
- `src/renderer/src/workspace/hook/index.ts`

**Changes:**

- Add correlated typed main-to-renderer requests and renderer-to-main responses.
- Serialize management requests so reads and destructive workspace mutations do
  not race each other through stale snapshots.
- Apply bounded queue/pending state and a 30-second renderer-response timeout;
  ignore late/unknown responses.
- Wire renderer handlers through refs to current state, runtimes,
  `ensureSessionLive`, initial history hydration, prompt delivery, closeSession,
  and killBuried.
- Resolve canonical transcript paths and mtimes through main-owned observed
  session state/provider resolvers with bounded batching and per-request
  de-duplication.
- Stamp inventory/bulk responses with one `observedAt` and derive comparable
  last-activity ages without treating backend repaint noise as transcript work.
- Revalidate project membership after every await that can let workspace state
  change.
- Journal timeouts and unexpected delivery failures without recording prompts,
  transcripts, cwd contents, or MCP tokens.

**Tests:**

- responses correlate by request ID;
- requests serialize and drain after success/failure;
- timeouts remove pending state and late responses no-op;
- a moved/closed target fails the second authorization check;
- hibernated read hydrates history without backend wake;
- project-wide reads hydrate with bounded concurrency and preserve all status
  rows under total-budget pressure;
- live/durable/provider-managed transcript locators report honest paths and
  availability states;
- last activity uses the documented source precedence and one observation time;
- pending provider conditions/user-action requirements prevent a false cleanup
  recommendation;
- hibernated send wakes before delivery;
- provider delivery failures retain retry/uncertainty facts; and
- close uses the correct placement action without waking.

### Phase 4 — Register the MCP tools and host dependency

**Files:**

- `src/mcp/runtime/BuiltInMcpHttpHost.ts`
- `src/mcp/runtime/BuiltInMcpHttpHost.test.ts`
- `src/mcp/runtime/createBuiltInMcpServer.ts`
- `src/mcp/runtime/createBuiltInMcpServer.test.ts`
- `src/main/index.ts`

**Changes:**

- Inject `AgentManagementBridge` into the host before sessions register.
- Register the five tools only when `scope.domains` contains
  `agent_management`.
- Pass `scope.sessionId` as the caller authority internally; never accept a
  caller/project selector in tool input.
- Compose management and workflow initialization instructions without changing
  either domain's behavior when enabled alone.
- Return structured JSON as text consistently with existing built-in tools.
- Apply strict zod caps and explicit tool annotations.

**Tests:**

- absent domain means no management tools and no management instructions;
- present domain exposes exactly five tools;
- all bridge calls use the authenticated scope session ID;
- cross-project/unknown/self targets surface typed safe errors;
- single/bulk read caps, subset authorization, total budget, and prompt
  validation are enforced before bridge dispatch;
- close metadata contains the explicit-user policy and destructive annotation;
- initialization instructions distinguish cleanup recommendations from close
  permission and teach the evidence/uncertainty buckets;
- no confirm boolean exists; and
- host registration filters the domain for unsupported caller providers.

### Phase 5 — Add Settings default and session toggle surfaces

**Files:**

- `src/renderer/src/features/settings/lib/settingsRegistry.ts`
- `src/renderer/src/features/settings/lib/settingsRegistry.test.ts`
- `src/renderer/src/features/workspace/commands/sessionCommands.ts`
- `src/renderer/src/features/workspace/commands/sessionCommands.renderer.test.ts`
- affected MCP continuity/recovery fixtures.

**Changes:**

- Add `Agent Management MCP for New Agents` under Agents settings.
- Add `Agent Management MCP` as a per-session command using the existing
  replace-session toggle pattern.
- Explain that it can inventory transcript paths/activity, bulk-review recent
  agent work, and prompt all agents in the current project, while close remains
  explicit-user-only.
- Preserve the domain through reload, recovery, provider switch, duplicate,
  rewind, undo-close, and orchestration-child creation using the existing
  explicit session snapshot rules.
- Keep the default off and avoid a settings store version bump: the persisted
  field already exists as a normalized domain array, so this adds an accepted
  value rather than a new persisted property.

**Tests:**

- settings add/remove only this domain;
- session command is available for Claude/Codex and hidden/guarded for OpenCode;
- toggling replaces the target with the exact next domain snapshot;
- explicit `[]` still overrides defaults; and
- lifecycle continuity retains `agent_management` where provider-supported.

### Phase 6 — Documentation, regression coverage, and acceptance

**Files:**

- `README.md` built-in MCP/fleet-management description.
- focused tests above plus any test-contract ownership declarations required by
  `scripts/check-test-contract.mjs`.

**Changes:**

- Document the distinction between parent-owned Orchestration MCP and
  project-scoped Agent Management MCP.
- Keep thick WHY comments at every authority, wake, transcript, and destructive
  boundary; do not copy this plan's prose into comments that merely restate code.

**Verification:**

```bash
npm run test:contract
npm run typecheck
npm run test:core
npm run test:system
npm run test:renderer
npm run test:coverage
npm run test:package
```

Run targeted MCP/bridge/renderer tests during implementation, then the full
quality gate before requesting review.

## Acceptance matrix

| Scenario | Expected result |
| --- | --- |
| Caller lists a project with grid, Dispatch, and buried agents | Every owned agent appears once with transcript availability/path and comparable last-activity evidence; terminals do not. |
| Another tab uses the same cwd | Its agents do not appear and cannot be targeted. |
| Same project contains a sibling worktree cwd | The agent appears because tab affinity, not cwd, is authoritative. |
| Caller reads a live Claude/Codex/OpenCode agent | Bounded normalized visible transcript is returned. |
| Caller reads a hibernated durable Claude/Codex agent | History hydrates from disk; no provider process starts. |
| Caller reads a hibernated agent with no durable history | Typed `transcript_unavailable`; no wake. |
| Caller asks to read all project agents | One bulk call returns the full census plus fair bounded tails for every readable non-caller agent by default; `includeCaller` supports a literal archival read. |
| One early transcript exceeds the total budget | Later agents retain status and useful excerpts; response is marked truncated. |
| Transcript has no durable file | List returns `path: null` plus a truthful availability reason. |
| Caller asks what is safe to clean up | Agent reports active/uncertain/likely candidates with transcript path, age, and evidence; it does not close. |
| Caller prompts a hibernated agent | Existing session ID wakes, scope revalidates, native delivery runs once. |
| Delivery fails after possible write | Result is uncertain and does not encourage automatic retry. |
| Caller targets itself for prompt/close | Rejected before mutation. |
| Caller targets another project | Rejected on every tool, even with matching cwd. |
| Close target has linked children or would tear down a tab | Rejected with additional affected session IDs. |
| Close target is detached or buried and has no cascade | Ownership is removed without waking it. |
| User did not explicitly request close | MCP instructions/tool description prohibit calling close. |
| Domain toggled off for one session | Replacement launches without tools; Settings default remains unchanged. |
| Workflow and Agent Management domains enabled together | Both instruction blocks and tool sets are present; Claude still never receives Workflow MCP. |

## Non-goals

- Creating agents. Orchestration MCP and the normal Agent Code UI already own
  creation semantics.
- Managing terminals.
- Managing agents across all Agent Code projects from one caller.
- Discovering closed/historical sessions from provider storage.
- Accepting arbitrary transcript paths or replacing Agent Transcripts MCP's raw
  projections/search tools. Inventory may expose only each authorized session's
  canonical resolved path.
- Provider switching, rewind, duplicate, layout moves, permission answers, or
  arbitrary PTY input through the management server.
- Inferring that a completed/failed/inactive agent should be closed.
- Adding a fake confirmation boolean that the model can self-assert.
- Adding an interactive confirmation modal or host-minted approval token unless
  plan review explicitly strengthens the close requirement to a hard user gate.

## Risks and mitigations

### Project-scope confusion

Using `scope.cwd` would be simpler but wrong for duplicate tabs and worktree
agents. The renderer's ownership graph is the only authorization source, and
each mutating operation rechecks it after awaits.

### Hidden destructive cascades

Canonical UI close actions can intentionally close linked children or an entire
last-pane project. A pure impact preflight plus fail-closed single-target policy
prevents a narrowly worded MCP call from inheriting that wider UI behavior.

### Parked-agent fork bomb

Reusing `ensureSessionLive` for reads would recreate the resource regression the
rehydration code explicitly fixed. Reads hydrate transcript history only; sends
are the sole non-destructive operation allowed to wake.

### Renderer pressure

Listing must not scan transcripts. Reads are bounded and requests serialize
through main. Reuse the existing initial-history concurrency limiter and
orchestration character caps rather than add unbounded per-agent extraction.
Bulk reads add a cross-agent budget with fair degradation so a “read all” audit
cannot multiply the per-agent maximum by an unbounded fleet size.

### Transcript discovery and activity quality

Codex transcript resolution can be much more expensive than a Claude path join,
and backend activity can be noisier than meaningful conversation activity.
Prefer observed live paths, coalesce durable provider lookups, bound concurrent
filesystem work, expose which activity source won, and never present an mtime or
screen event as proof that useful work is complete.

### Semantic close enforcement limit

The MCP handler cannot see the raw user message. Tool/server instructions are
the enforceable interface available to the model; runtime checks enforce only
observable scope and blast radius. The implementation and docs must state this
limit honestly so future work does not mistake a model-authored boolean for a
security boundary.

### Authority drift between Orchestration and Agent Management

Sharing bridge state or ownership predicates could let parent authority widen
into project authority or vice versa. Separate public contracts and pure scope
resolvers keep each capability auditable even when they share transcript
budgeting helpers.

## Implementation sequence after approval

1. Land shared domain/types and pure project-scope tests.
2. Extract bounded visible transcript helpers with unchanged orchestration tests.
3. Implement renderer inventory, transcript/activity enrichment, fair bulk
   reads, and close-impact logic with tests.
4. Add the dedicated bridge and IPC/preload plumbing.
5. Register MCP tools/instructions and main composition.
6. Add Settings and per-session command surfaces.
7. Run targeted suites, then the complete quality gate.
8. Update this plan status, finish the same feature PR, obtain review, and merge
   only after valid feedback is resolved.

No implementation phase should begin until this plan is reviewed.
