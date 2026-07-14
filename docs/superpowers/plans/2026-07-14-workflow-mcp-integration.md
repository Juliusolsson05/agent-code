# Workflow MCP Integration — Implementation Blueprint

Status: Ready for implementation on the long-lived draft PR

Date: 2026-07-14

Agent Code branch: `feat/workflow-mcp-integration`

Agent Code worktree: `.worktrees/workflow-mcp-integration`

Draft PR title: `feat: integrate workflow MCP into Agent Code`

Standalone repository: `Juliusolsson05/workflow-mcp`

## Goal

Make Claude-compatible workflow files executable through Agent Code's existing
built-in MCP host, using the Codex SDK as the first execution provider, and
render each run as a first-class, live workflow card in the session feed.

The finished path is:

```text
Claude Code or Codex session
  -> Agent Code's existing per-session MCP endpoint
  -> workflow_run returns a durable run ID immediately
  -> app-owned WorkflowService executes the workflow with the Codex SDK
  -> every event is persisted before it is published
  -> Agent Code IPC streams those clean workflow events to the renderer
  -> one custom feed row reduces and renders the run
```

This is an implementation branch, not a documentation branch. This blueprint
is the first commit because the work crosses two repositories, two process
boundaries, the MCP protocol, Electron packaging, and both Claude and Codex
feed shapes. The implementation commits described below land on the same PR.

## User-visible result

When either Claude or Codex calls `workflow_run`, its normal tool row is
replaced by a live component with this exact information hierarchy:

```text
 fat-bug-hunt                         Deep multi-agent hunt…
 9/76 agents · 6m16s · running

 ┌─ Find · 17 agents ──────────────────────────────────────────────┐
 │                                                                 │
 │ ✔ find:main-sessions                     Completed · cached      │
 │                                                                 │
 │ ✔ find:main-ipc-preload                  Completed · cached      │
 │                                                                 │
 │ ▼ find:main-orchestration · 3/17         Completed · Fable 5    │
 │ ╭─────────────────────────────────────────────────────────────╮ │
 │ │ Prompt · 49 lines                             Enter expand  │ │
 │ │ You are one finder in a large parallel bug hunt…           │ │
 │ │                                                             │ │
 │ │ Activity · 28 tool calls                                   │ │
 │ │   Bash  rg "spawn|kill|restart" src/main/orchestration     │ │
 │ │   Read  src/main/subagents/SubAgentWatcher.ts              │ │
 │ │   Bash  sed -n 120,260p src/main/tmux/TmuxRegistry.ts      │ │
 │ │                                                             │ │
 │ │ Outcome                                                     │ │
 │ │   3 findings                                                │ │
 │ │   • Orphaned subprocess after failed restart               │ │
 │ │   • Overlapping watcher refreshes duplicate transcript     │ │
 │ ╰─────────────────────────────────────────────────────────────╯ │
 │                                                                 │
 │ ◉ find:main-storage                      Running · 14 tool calls │
 │                                                                 │
 │ ◌ find:main-misc                         Queued                  │
 │                                                                 │
 └─────────────────────────────────────────────────────────────────┘

 ┌─ Dedup · 1 agent ───────────────────────────────────────────────┐
 │ ◌ dedup                                  Waiting for Find        │
 └─────────────────────────────────────────────────────────────────┘

 ┌─ Verify · 138 agents ───────────────────────────────────────────┐
 │ ◌ verify:0:forwarder.ts                 Waiting                 │
 │ ◌ verify:1:sessionIndex.ts              Waiting                 │
 │ …                                                               │
 └─────────────────────────────────────────────────────────────────┘
```

The phases are a vertical list. The agents inside a phase are another vertical
list. Selecting an agent expands it in place; there is no carousel and no
separate detail pane that hides the surrounding work.

## Non-negotiable boundaries

1. **Do not rewrite transcript ingestion.** The current provider parsers,
   semantic reducers, committed ledger, ordering rules, and clean feed objects
   remain the source of truth for the conversation. Workflow rendering starts
   after a clean MCP tool call/result identifies a `runId`.
2. **Agent Code is the MCP host.** The workflow package does not start a second
   server inside the desktop app. It registers tools on the existing
   `McpServer` created by `BuiltInMcpHttpHost`.
3. **The workflow service is app-owned.** A run can outlive the session that
   started it, so it must not be stored in a session runtime, React component,
   or settings store.
4. **Persist before publish.** A renderer crash, reload, missed IPC message, or
   provider reconnect must be recoverable from an append-only event log.
5. **Claude-compatible workflow source stays portable.** Agent Code metadata,
   cursors, caches, provider session IDs, and UI state live beside a run, never
   inside the workflow file.
6. **Both Claude and Codex must work.** The parent MCP client may be either;
   the first workflow execution provider is the official Codex SDK.
7. **Read-only first.** The first integrated policy is `sandbox=read-only`,
   network disabled, approvals never. A workflow cannot widen that policy.
   Write-capable workflows require a later explicit approval design.
8. **Package the real app before declaring success.** `npm start` is not an
   Electron distribution test. The workflow worker and Codex CLI override must
   also work from the packaged `.app`.

## What already exists

### Agent Code

- One authenticated Streamable HTTP MCP host bound to loopback.
- Per-session token and domain scopes.
- Claude `--mcp-config` and Codex `mcp_servers.*` injection.
- Built-in MCP toggle commands with agent replacement/reload semantics.
- Main-to-renderer IPC and a single preload API composition point.
- Clean live and committed feed render paths for Claude and Codex tools.
- Tool-call/result pairing contexts in the committed feed.

### workflow-mcp

- Claude-compatible source discovery and loader.
- Workflow executor with `agent`, `parallel`, `pipeline`, phases, nesting,
  budgets, cache reuse, and cancellation.
- Fake provider and official `@openai/codex-sdk` provider.
- Event union, pure run-state reducer, prompt/outcome references, and activity
  normalization.
- Atomic persistent journal and Claude journal import/resume support.
- Async event stream and an awaited event sink. That sink is the correct seam
  for the persist-before-publish invariant.

The missing layer is not another workflow evaluator. It is the durable service,
MCP facade, Electron worker adapter, Agent Code bridge, and renderer.

## Architecture

```text
┌──────────────────── provider session ─────────────────────────────┐
│ Claude Code                         Codex CLI                      │
│      └──────── MCP Streamable HTTP ────────┘                      │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ session token + workflows domain
┌──────────────── Agent Code main process ──────────────────────────┐
│ BuiltInMcpHttpHost                                                │
│   └─ createBuiltInMcpServer(request scope)                        │
│       └─ registerWorkflowMcpTools(server, workflowService, scope) │
│                                                                  │
│ WorkflowService (one instance for the application)               │
│   ├─ discovery / validation                                      │
│   ├─ active-run registry + AbortControllers                      │
│   ├─ CodexAgentProvider(codexPathOverride=<setup-resolved CLI>)   │
│   ├─ ElectronWorkflowWorkerLauncher -> utilityProcess.fork       │
│   └─ FileWorkflowStore                                           │
│       └─ manifest + source + args + journal + events.jsonl        │
│                                                                  │
│ WorkflowBridge                                                   │
│   ├─ snapshot/read-events/cancel/resume IPC handlers             │
│   └─ coalesced event batches -> renderer                          │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ durable cursor + best-effort IPC push
┌──────────────── Agent Code renderer ──────────────────────────────┐
│ IpcWorkflowClient -> WorkflowRunStore -> workflow-mcp/state       │
│                                      └─ WorkflowRunRow            │
│                                         ├─ phases (vertical)      │
│                                         └─ agents (vertical)      │
└────────────────────────────────────────────────────────────────────┘
```

The MCP host creates a fresh protocol server for each HTTP request. Therefore
tool registration is deliberately cheap and request-scoped, while the
`WorkflowService` dependency is long-lived and shared. Reconstructing the
service per request would lose cancellation ownership, duplicate writers, and
make idempotency impossible.

## Protocol contract

### MCP domain and tools

Add `workflows` to `BuiltInMcpDomain`. When disabled, no workflow tools are
registered for that session. When enabled, the existing Agent Code endpoint
exposes:

| Tool | Purpose |
| --- | --- |
| `workflow_list` | List definitions visible from the scoped project directory. |
| `workflow_describe` | Return normalized metadata without executing source. |
| `workflow_validate` | Parse and validate a definition and its provider policy. |
| `workflow_run` | Allocate/persist a run and return its ID immediately. |
| `workflow_run_status` | Return manifest summary and the latest cursor. |
| `workflow_run_events` | Read durable events after a cursor, optionally long-polling. |
| `workflow_run_cancel` | Request cancellation of an active run. |
| `workflow_resume` | Resume a managed run or import-and-resume a compatible Claude run. |

Do not use experimental MCP Tasks in the first release. Cursor reads are the
portable source of truth; Agent Code's IPC push is only a local optimization.

`workflow_run` must not wait for the workflow to finish. Its result is stable
and deliberately small:

```ts
type WorkflowRunToolResult = {
  ok: true
  run: {
    runId: string
    status: 'queued' | 'running'
    workflow: {
      name: string
      title?: string
      description?: string
    }
    cursor: number
  }
}
```

Return the same data as MCP `structuredContent` and as JSON in a text content
block. Claude and Codex do not expose tool results to the feed in identical
shapes, so the text fallback is a compatibility surface, not duplication.

`workflow_run_events` accepts:

```ts
type WorkflowRunEventsInput = {
  runId: string
  after?: number
  limit?: number
  waitMs?: number
}
```

The service caps `limit` and `waitMs`; a caller cannot pin the host indefinitely.
An optional `idempotencyKey` on `workflow_run` prevents a provider retry from
starting the same workflow twice.

### Durable event envelope

Do not add storage details to every engine event. Wrap the existing event:

```ts
type StoredWorkflowEvent = {
  runId: string
  cursor: number       // strictly increasing within one run
  recordedAt: string
  event: WorkflowEvent
}
```

The storage append completes before the event is delivered to the in-process
async stream, MCP long poll, or renderer IPC bridge. A client receiving cursor
`N + 2` after `N` must fetch the missing range from storage before reducing
newer events.

Add only the engine events the UI cannot infer honestly:

- `phase.completed` and `phase.failed`, so a phase does not appear running
  merely because no later phase has entered.
- `run.interrupted`, written during boot recovery when a previous process left
  a run non-terminal.

### Snapshot contract

The renderer does not replay an unbounded log on every mount:

```ts
type WorkflowRunSnapshot = {
  manifest: WorkflowRunManifest
  state: WorkflowState
  cursor: number
}
```

The service may materialize snapshots for speed, but `events.jsonl` remains the
auditable source of truth and the reducer must reproduce the same state.

### Resume semantics

Resume creates a new run linked by `resumedFromRunId`; it does not append a
second execution into the old terminal/interrupted event stream. The new run
imports the compatible journal prefix and provider session IDs, then emits its
own ordered events. This keeps each run log monotonic and makes the UI honest
about which execution produced an outcome.

For a Claude-origin run, `workflow_resume` accepts a Claude run directory plus
an optional live workflow path. The existing importer verifies the saved
source, journal version, and byte identity before registering it. Arbitrary
paths are not an escape hatch: the import must be inside the scoped project or
an explicitly recognized Claude workflow/run root.

## Persistence layout

Use a local file store first. SQLite would add a native rebuild/signing burden,
and Electron 31 embeds Node 20.14, which has no stable built-in SQLite API. One
main-process service is the only writer, so an append-only file layout is the
smaller and safer system:

```text
<app.userData>/workflows/
  runs/
    <run-id>/
      manifest.json        # atomic temp + rename
      workflow.js          # exact source snapshot used for this run
      args.json            # exact normalized arguments
      journal.json         # cache/resume state
      events.jsonl         # append-only StoredWorkflowEvent records
      snapshot.json        # optional rebuildable acceleration
      artifacts/
```

Directories are created mode `0700`; files are `0600`. Startup scans manifests,
truncates only a final partial JSONL record, marks abandoned non-terminal runs
`interrupted`, and never mutates an already terminal run.

## Runtime and packaging decisions

### Node 20 is a hard compatibility gate

`workflow-mcp` currently declares Node `>=22.12.0`; Electron 31 embeds Node
20.14.0. Before Agent Code imports it, run its build and complete test suite on
Node 20.14 and remove or replace any Node 22-only API. Do not hide this with a
package-manager engine override.

### Electron owns the worker process

The standalone package can keep using `child_process.fork`, but packaged Agent
Code must launch the workflow evaluator through `utilityProcess.fork`. Electron
documents it as the supported Node child-process equivalent, and it avoids
depending on the `runAsNode` fuse.

Add an injectable `WorkflowWorkerLauncher`:

```ts
interface WorkflowWorkerLauncher {
  launch(options: WorkflowWorkerLaunchOptions): WorkflowWorkerHandle
}

interface WorkflowWorkerHandle {
  postMessage(message: ParentToWorkerMessage): void
  onMessage(listener: (message: WorkerToParentMessage) => void): () => void
  onExit(listener: (exit: WorkflowWorkerExit) => void): () => void
  terminate(): void
}
```

The package's default adapter wraps `child_process.fork`. Agent Code's adapter
wraps `utilityProcess.fork`. The worker transport supports both Node's
`process.send`/`message` and Electron's `process.parentPort` without leaking
either process API into the evaluator.

Build `src/main/workflows/workflowWorkerEntry.ts` as a separate main entry named
`out/main/workflowWorker.js`. The packaged smoke test is the authority on ASAR
behavior. If the Electron version cannot fork that entry from `app.asar`,
unpack the worker entry and its complete generated chunk graph and resolve it
through `app.asar.unpacked`; never unpack only the entry while leaving its
relative imports behind.

### Reuse Agent Code's installed Codex CLI

`@openai/codex-sdk` transitively installs a platform-specific Codex package
that is hundreds of megabytes. Agent Code already resolves and validates its
Codex CLI. Construct the SDK with `codexPathOverride` set to the absolute path
from the setup resolver, and exclude optional `@openai/codex-*` platform
packages from the app payload. A packaged integration test must prove that the
SDK launches that exact path.

### Model names are host policy

Claude workflow files may name `haiku`, `sonnet`, or `opus`; those are not
Codex model names. The package must not pretend they are equivalent. Agent Code
provides an explicit alias policy. In the first integration, `inherit` and the
three Claude tiers use the configured Codex default and emit one visible run
warning explaining the mapping. A later settings UI can expose per-tier
choices without changing portable workflow source.

## Intended repository trees

### workflow-mcp

```text
src/
  index.ts                         public Node entry
  state.ts                         browser-safe event/reducer entry
  agentProvider.ts
  codexProvider.ts
  fakeProvider.ts
  findWorkflows.ts
  loadWorkflow.ts
  runWorkflow.ts
  workflowEvents.ts
  workflowState.ts
  workflowJournal.ts
  persistentWorkflowJournal.ts
  workerMessages.ts
  workflowWorker.ts
  workerLauncher.ts                platform-neutral worker interfaces
  nodeWorkflowWorkerLauncher.ts    standalone child_process adapter
  workflowStore.ts                 durable store interface + records
  fileWorkflowStore.ts             append-only local implementation
  workflowService.ts               long-lived run owner
  workflowMcp.ts                   tool schemas + registrar
  standaloneServer.ts              stdio / authenticated loopback host
  cli.ts
test/
  workflowService.test.ts
  fileWorkflowStore.test.ts
  workflowMcp.test.ts
  workflowRecovery.test.ts
  workerLauncher.test.ts
  ...existing tests
```

Public exports become:

- `workflow-mcp`: loader, executor, provider interfaces, service, store, and
  MCP registrar.
- `workflow-mcp/state`: browser-safe events, reducer, and state types only.

The browser entry must have no transitive dependency on `fs`, `child_process`,
the MCP SDK, or the Codex SDK.

### Agent Code

```text
packages/
  workflow-mcp/                    git submodule

src/main/workflows/
  ElectronWorkflowWorkerLauncher.ts
  WorkflowBridge.ts
  createWorkflowService.ts
  workflowWorkerEntry.ts

src/main/ipc/
  workflows.ts

src/preload/api/
  workflows.ts

src/shared/workflows/
  types.ts                         IPC-only contracts

src/renderer/src/features/workflows/
  client/
    WorkflowClient.ts
    WorkflowClientContext.tsx
    IpcWorkflowClient.ts
    NoopWorkflowClient.ts
  model/
    workflowTool.ts                Claude/Codex run-ID extraction
    WorkflowRunStore.ts            cursor/gap/reconnect ownership
  ui/
    WorkflowRunRow.tsx
    WorkflowPhaseSection.tsx
    WorkflowAgentRow.tsx
    WorkflowAgentDetails.tsx
    WorkflowActivityRow.tsx
    WorkflowOutcome.tsx
  workflowTool.renderer.test.tsx
  WorkflowRunStore.renderer.test.ts
  WorkflowRunRow.renderer.test.tsx
```

## Complete Agent Code file impact

| File | Change |
| --- | --- |
| `.gitmodules` | Register `packages/workflow-mcp` from the public standalone repository. |
| `packages/workflow-mcp` | Add the submodule gitlink; update it as standalone commits land. |
| `package.json`, `package-lock.json` | Own the exact SDK/package dependency graph and scripts used by the app. |
| `electron.vite.config.ts` | Compile workflow-mcp source, add browser-safe alias, and build the worker entry. |
| `electron-builder.yml` | Exclude unused native Codex platform packages; unpack worker graph only if the packaged gate proves necessary. |
| `tsconfig.node.json`, `tsconfig.web.json` | Add matching package and `workflow-mcp/state` paths. |
| `vitest.config.ts` | Resolve the same aliases in Node and renderer tests. |
| `src/remote-client/vite.config.ts` | Resolve only the browser-safe state subpath if the shared feed imports the workflow row. |
| `src/mcp/shared/types.ts` | Add and normalize the `workflows` domain. |
| `src/mcp/runtime/createBuiltInMcpServer.ts` | Accept `workflowService` dependency and register workflow tools for the domain. |
| `src/mcp/runtime/BuiltInMcpHttpHost.ts` | Carry the service dependency and enforce localhost `Origin` validation. |
| `src/mcp/runtime/BuiltInMcpHttpHost.test.ts` | Cover domain isolation, auth, origin rejection, and per-session scope. |
| `src/main/index.ts` | Create/start/stop the singleton service and bridge after `app.ready`. |
| `src/main/workflows/*` | Add Electron worker, service construction, CLI resolution, and renderer bridge. |
| `src/main/ipc/workflows.ts` | Snapshot, cursor read, cancel, resume, and subscription handlers. |
| `src/main/ipc/index.ts` | Register workflow handlers with explicit dependencies. |
| `src/preload/api/workflows.ts` | Expose the narrow workflow IPC client. |
| `src/preload/api/index.ts` | Compose the new API once. |
| `src/preload/api/types.ts` | Add the renderer-visible methods/events. |
| `src/shared/workflows/types.ts` | Define clone-safe request, snapshot, and pushed-batch contracts. |
| `src/renderer/src/features/workspace/commands/sessionCommands.ts` | Add the MCP toggle and the same replacement warning used by existing domains. |
| `src/renderer/src/app/main.tsx` | Mount one desktop workflow client provider; remote gets a no-op client. |
| `src/renderer/src/features/feed/ui/rows/Block.tsx` | Replace committed Claude/Codex workflow tool pairs with `WorkflowRunRow`. |
| `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx` | Replace the live tool call once its result yields a run ID. |
| `src/renderer/src/features/workflows/**` | Own parsing, durable synchronization, state reduction, and the vertical UI. |

Do not add workflow run state to the settings/app-state store, SessionRuntime,
or feed ledger. Those stores have different lifetimes and ownership.

## Implementation sequence

Each task must leave its own repository green. Standalone package work lands in
a workflow-mcp PR first; the Agent Code PR then advances the submodule pointer.

### Task 1 — Make workflow-mcp embeddable in Electron 31

**workflow-mcp files:** `package.json`, `package-lock.json`, `src/runWorkflow.ts`,
`src/workflowWorker.ts`, `src/workerMessages.ts`, new `src/workerLauncher.ts`, new
`src/nodeWorkflowWorkerLauncher.ts`, and their tests.

- [ ] Run build/tests under Node 20.14 and fix actual incompatibilities.
- [ ] Change the engine range only after the Node 20 suite passes.
- [ ] Replace direct `ChildProcess` coupling with `WorkflowWorkerLauncher`.
- [ ] Keep the Node launcher as the standalone default.
- [ ] Make cancellation and abnormal exit semantics identical across adapters.
- [ ] Add thick WHY comments around the launcher boundary and message transport.

**Gate:** Node 20.14 and current Node both pass `npm run check`; cancellation,
worker crash, invalid source, and message ordering tests are green.

### Task 2 — Add the durable service and file store

**workflow-mcp files:** new `src/workflowStore.ts`,
`src/fileWorkflowStore.ts`, `src/workflowService.ts`; modify
`src/runWorkflow.ts`, `src/workflowEvents.ts`, `src/workflowState.ts`,
`src/persistentWorkflowJournal.ts`, and `src/index.ts`.

- [ ] Allocate a run ID and persist its manifest/source/args before execution.
- [ ] Make the service the only owner of active run controllers and writers.
- [ ] Append and fsync each event before publishing it.
- [ ] Implement cursor reads, bounded long polling, snapshots, and gap replay.
- [ ] Add phase terminal events and boot-time `run.interrupted` recovery.
- [ ] Recover a partial final JSONL record without hiding earlier corruption.
- [ ] Implement idempotent `start`, `cancel`, and linked resume.
- [ ] Preserve the existing journal as cache/resume data rather than treating it
  as the event log.

**Gate:** kill a fake run mid-write, restart the service, recover it as
interrupted, resume it, and prove the new run reuses completed calls without
duplicating cursors or outcomes.

### Task 3 — Publish the MCP facade and standalone server

**workflow-mcp files:** new `src/workflowMcp.ts`,
`src/standaloneServer.ts`, `src/state.ts`; modify `src/cli.ts`, `src/index.ts`,
`package.json`, `README.md`, and tests.

- [ ] Register the eight baseline tools with explicit Zod schemas.
- [ ] Return structured content plus text JSON for all machine-readable tools.
- [ ] Enforce service-level project scope even if a tool passes a direct path.
- [ ] Add `serve --stdio` for ordinary MCP clients.
- [ ] Add an authenticated loopback Streamable HTTP mode for standalone use.
- [ ] Validate HTTP `Origin`; never bind to a public interface by default.
- [ ] Export a browser-safe `workflow-mcp/state` subpath.
- [ ] Document exact Claude source compatibility and honest resume limits.

**Gate:** an MCP SDK client can list, start, follow, cancel, disconnect,
reconnect by cursor, and resume a fake-provider workflow over stdio and HTTP.

### Task 4 — Add the submodule and build wiring to Agent Code

**Agent Code files:** `.gitmodules`, submodule gitlink, `package.json`, lockfile,
`electron.vite.config.ts`, both tsconfigs, `vitest.config.ts`, remote Vite
config if required, and `electron-builder.yml`.

- [ ] Add `Juliusolsson05/workflow-mcp` at `packages/workflow-mcp`.
- [ ] Compile source like the existing local packages; do not require a prior
  package build in a fresh clone.
- [ ] Keep main imports on the public Node entry and renderer imports on
  `workflow-mcp/state`.
- [ ] Build the Electron worker as a named main entry.
- [ ] Pass Agent Code's setup-resolved Codex binary as `codexPathOverride`.
- [ ] Exclude the unused platform Codex payload without excluding the SDK code
  needed at runtime.

**Gate:** fresh recursive clone, `npm install`, `npx tsc -b`, root test suite,
and `npm run build` succeed without building the submodule manually.

### Task 5 — Mount workflows inside the existing Agent Code MCP host

**Agent Code files:** `src/mcp/shared/types.ts`,
`src/mcp/runtime/createBuiltInMcpServer.ts`,
`src/mcp/runtime/BuiltInMcpHttpHost.ts`, host tests,
`src/main/workflows/createWorkflowService.ts`,
`src/main/workflows/ElectronWorkflowWorkerLauncher.ts`, worker entry, and
`src/main/index.ts`.

- [ ] Construct one `WorkflowService` under `app.getPath('userData')`.
- [ ] Inject the Electron worker launcher, Codex provider, model policy, and
  read-only execution policy.
- [ ] Add the service to `BuiltInMcpDependencies`.
- [ ] Register tools only when the request scope includes `workflows`.
- [ ] Scope discovery and run control to the registered session cwd/project.
- [ ] Harden the shared host with the MCP specification's localhost Origin
  check while preserving token authentication.
- [ ] On graceful quit, request cancellation and close writers; on next boot,
  recovery decides which unfinished runs are interrupted.

**Gate:** two sessions with different cwd/domain scopes cannot see or control
each other's runs; a session without the toggle cannot list workflow tools.

### Task 6 — Add the MCP toggle command

**Agent Code file:**
`src/renderer/src/features/workspace/commands/sessionCommands.ts` plus focused
command/metadata tests.

- [ ] Add “Enable/Disable workflow MCP” beside the existing domain toggles.
- [ ] Persist `workflows` through the existing domain normalization path.
- [ ] Reuse the existing explanation that the focused agent must be replaced or
  reloaded before a new MCP config applies.
- [ ] Verify both Claude and Codex receive the same Agent Code MCP endpoint.

**Gate:** enable, replace, inspect provider launch arguments, call
`workflow_list`, disable, replace, and prove the tools disappear.

### Task 7 — Build the main/preload workflow bridge

**Agent Code files:** new `src/shared/workflows/types.ts`,
`src/main/workflows/WorkflowBridge.ts`, `src/main/ipc/workflows.ts`,
`src/preload/api/workflows.ts`; modify both IPC/API aggregators and preload
types.

- [ ] Expose snapshot, cursor read, cancel, and resume calls.
- [ ] Expose one subscription that emits clone-safe event batches.
- [ ] Coalesce noisy live activity updates for roughly one animation frame,
  without coalescing them in durable storage.
- [ ] Include cursor bounds in every pushed batch.
- [ ] Clean subscriptions when a renderer reloads or window closes.

**Gate:** a synthetic high-volume run remains ordered, main does not grow one
listener per React row, and dropping an IPC batch heals through cursor replay.

### Task 8 — Add the renderer client and run store

**Agent Code files:** new `features/workflows/client/*`,
`features/workflows/model/WorkflowRunStore.ts`; modify
`src/renderer/src/app/main.tsx`.

- [ ] Define a transport-neutral `WorkflowClient` so shared feed code never
  imports `window.api`.
- [ ] Mount one IPC client/provider in desktop.
- [ ] Supply a no-op remote implementation until remote workflow control is a
  deliberate feature.
- [ ] Give each observed run a `useSyncExternalStore`-compatible store.
- [ ] Fetch snapshot, subscribe, reject stale cursors, fill gaps, and reduce
  through `workflow-mcp/state`.
- [ ] Reference-count observed runs and dispose idle subscriptions.

**Gate:** mount/unmount/remount a row during execution and prove it reconstructs
the identical state without duplicate activity items.

### Task 9 — Recognize workflow tools in both feed paths

**Agent Code files:** new `features/workflows/model/workflowTool.ts`; modify
`features/feed/ui/rows/Block.tsx` and
`features/feed/ui/semantic/BlockRow.tsx`; add renderer fixtures/tests.

- [ ] Recognize Claude MCP names such as
  `mcp__agent_code__workflow_run` and Codex's exposed `workflow_run` name.
- [ ] Extract the stable result from structured content, text JSON, and known
  provider result envelopes.
- [ ] In the committed path, use the existing tool-result index and suppress
  the paired generic result row once the workflow row owns it.
- [ ] In the live path, keep the normal pending tool row until a run ID exists,
  then converge to the same `WorkflowRunRow`.
- [ ] Leave all unrelated tools on their current renderer paths.

**Gate:** recorded Claude and Codex fixtures produce one workflow card, no raw
JSON duplicate, and all existing feed renderer tests remain green.

### Task 10 — Build the vertical workflow UI

**Agent Code files:** new `features/workflows/ui/*` and renderer tests.

- [ ] Render workflow title/description, aggregate agent progress, elapsed time,
  terminal status, and resumed-run link.
- [ ] Render phases vertically in definition order.
- [ ] Render agents vertically in call order with queued/running/completed/
  failed/cancelled/cached states.
- [ ] Expand one selected agent inline while leaving siblings visible.
- [ ] Show prompt, normalized activity timeline, and structured outcome.
- [ ] Format command, file change, tool call, web search, reasoning, todo, and
  error activity with existing feed primitives where they genuinely fit.
- [ ] Add cancel while active and resume when interrupted/failed and resumable.
- [ ] Use semantic buttons, keyboard navigation, focus-visible states, and
  reduced-motion-safe activity indicators.
- [ ] Cap rendering for 100+ agent phases with list windowing only after a
  measured fixture proves it necessary; do not preemptively build a virtual
  list framework.

**Gate:** fixtures for 1, 17, 76, and 138 agents are readable at narrow and wide
feed widths; expansion does not reorder rows or move keyboard focus.

### Task 11 — Prove real Claude, Codex, resume, and distribution paths

- [ ] Claude session -> enable toggle -> `workflow_run` -> live card -> finish.
- [ ] Codex session -> enable toggle -> same definition -> live card -> finish.
- [ ] Stop Agent Code during a fake run -> restart -> interrupted card -> resume.
- [ ] Import and resume the existing read-only Claude bug-hunt run with its
  source/journal compatibility checks intact.
- [ ] Disconnect/reload the renderer while 10+ agents emit activity -> recover
  without missing or duplicating events.
- [ ] Cancel during queued work and during an active SDK turn.
- [ ] Run `npx tsc -b`, unit, integration, renderer, and root suites.
- [ ] Build the macOS `.app`, launch it outside the repository shell, and run a
  two-agent read-only workflow using the setup-resolved Codex CLI.
- [ ] Inspect the packaged contents to prove the optional platform Codex payload
  was excluded and the worker is present where the launcher expects it.

The feature is not done until the packaged smoke test passes. Preview-only
success cannot validate utility process paths, ASAR behavior, signing,
environment inheritance, or the Codex binary override.

## Deliberate non-goals for this PR

- Replacing or modifying clean provider transcript parsing.
- A global Workflow Manager page.
- Write-capable workflow permissions or a new approval modal system.
- WebSocket transport.
- Experimental MCP Tasks.
- SQLite, a database daemon, or distributed locks.
- A provider plug-in marketplace.
- Recreating Claude's private scheduler internals where observed workflow file
  behavior and journals do not provide evidence.
- A generic renderer DSL for every possible MCP tool.

These omissions are how the integration stays comprehensible: one durable
service, one existing MCP host, one IPC bridge, and one first-class feed row.

## Acceptance criteria

The PR can leave draft status only when all of the following are true:

- A Claude-compatible workflow file runs unchanged through Agent Code.
- Both Claude and Codex parent sessions can call the same workflow MCP tools.
- `workflow_run` returns before the workflow completes and the UI updates live.
- Every visible state can be reconstructed from durable cursored events.
- A missed IPC batch and renderer reload recover without duplicates.
- The UI matches the vertical phase/agent/inline-detail hierarchy above.
- Cached agents, failures, cancellation, interruption, and resume are explicit.
- The current feed ledger and semantic ingestion tests remain unchanged/green.
- The default execution policy is read-only and cannot be widened by tool input.
- The standalone package works over stdio outside Agent Code.
- The packaged macOS app launches the utility worker and the configured Codex
  CLI successfully.

## Primary references

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Tasks are experimental](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [MCP TypeScript server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [Official Codex SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Electron 31 release and embedded Node version](https://www.electronjs.org/blog/electron-31-0)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron ASAR archives](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
