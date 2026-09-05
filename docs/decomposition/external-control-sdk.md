# Internal control SDK and MCP isolation

Status: Approved by the user on 2026-09-04. Implementation in progress.
Stages 0–3 verified; Stage 4 is next.

Product scope: [external control plan](../superpowers/plans/2026-09-04-external-control-mcp.md).
Source evidence: [source inventory](evidence/external-control/source-inventory.json).
Issue: [#793](https://github.com/Juliusolsson05/agent-code/issues/793).

## Why this decomposition applies

The inspected source contains 976 production TypeScript/TSX/MTS files and
199,648 lines, excluding tests and package submodules. The control surface spans
main-owned processes, renderer-owned layouts, provider state, live/transcript
observations, persisted history, and an external transport. The difficult part
is agreeing on ownership and outcomes across these boundaries without making
MCP a dependency of ordinary application code.

The user supplied the staged-decomposition methodology in the conversation and
specifically emphasized isolation and a strong internal SDK. They also said the
recording/testing harness does not generally apply to this task. Accordingly:

- Apply the written stages, independent verification, explicit dependency
  boundaries, unknowns, and stop/revise rule.
- Do not build a general recorder or require recorded fixtures for ordinary
  schema, persistence, dispatch, and command-catalog contracts.
- Use checked-in declarations and existing behavior as evidence; use existing
  recorded/sanitized inputs for uncertain live/transcript reconciliation, and
  capture a narrow missing case only where the source does not settle it.
- Do not claim synthetic fault injection is an observed production incident.
- Keep the supplied approval gate: "Implementation may not start until a written
  decomposition exists and the user has approved it." The existing product plan
  establishes scope; this artifact adds the requested SDK isolation design.

There is no installed `staged-decomposition/SKILL.md` in the searched local
skill roots. This document applies the self-contained methodology pasted by the
user; its linked reference files were not provided or read. The personal
`agent-code-conventions/SKILL.md` and repository `AGENTS.md` were read.

## A — what exists and what we can rely on

The inventory records source hashes, line counts, and neighboring test paths at
`4c641f68c86b7c17ad04e1f3827b98bd581c6693`. It is source evidence, not a live
capture or a claim that those tests passed in this worktree.

| Existing artifact | Trusted responsibility | Not established by it |
|---|---|---|
| Command catalog, descriptors, dispatcher, and admission resolver | Command membership, current UI invocation contracts, and availability policy | Parameterized automation, exact target propagation, completed downstream effects |
| Keybinding defaults/resolver/reservations | Default/customized bindings and declared fixed interactions | Complete inventory of every handler or the current native/provider keymap |
| `workspace/agentIndexNavigation.ts` and its action hook | Seven concrete mode-aware navigation result kinds, wake and positional-target checks | Cross-window stable-ID navigation or buried revival through a single API |
| Workspace store and domain actions | Current layout/session metadata, actual mutations, and UI invariants | A typed control capability registration/invocation boundary |
| `windowRegistry.ts` and `SessionManager` | Window/session ownership and backend lifecycle/readiness | Renderer layout truth or task completion from process activity alone |
| `SessionFeed` and desktop/remote implementations | Existing narrow session-I/O abstraction and transport separation | Application-wide authority; widening it for this feature would change its purpose |
| Existing MCP host and agent-management bridge | Local authenticated MCP and correlated renderer request patterns | External-operator identity, complete app access, durable full call history |
| Transcript reader, management projections, and feed ownership rules | Existing conversation extraction and live/committed evidence handling | Complete cursor-based reads for every provider or duplicate-free new projections without verification |
| Existing storage and workflow services | Persistence/toolchain infrastructure and durable workflow ownership | External workflow attribution or the new invocation history contract |

Issue #242 proposes root access for an internal agent. This feature deliberately
keeps the external operator separate; the old issue is related context, not
authorization to expose external control through built-in agent defaults.

## D — observable finished behavior

1. External Codex can enumerate all commands/keybindings, read a full app/feature
   guide, search by intention, and open the real picker with an acknowledged
   query/selection.
2. It can find an existing agent and reveal the same session across windows,
   tabs, Grid, Dispatch, related-child views, or explicit buried restoration.
3. The agreed broad direct-operation families in the product plan are available:
   creation, prompts, drafts, placement/layout, lifecycle/provider operations,
   reads, terminal/editor navigation, settings/templates, and existing workflows.
4. Agent reads default to user prompts and all visible assistant messages;
   depth/range/pagination/incremental reads are independent and truthful.
5. The operator can retrieve full retained requests/results and outcomes of its
   MCP calls, including uncertain operations, after restart.
6. Computer use and MCP observe and change the same state without relying on
   whatever pane happens to have focus at the moment an async action completes.
7. Features expose control capabilities through a small internal registration SDK.
   Their handlers reuse the same domain operations as ordinary UI actions.
   Disabling/removing the MCP adapter leaves those UI operations independent.
8. MCP is opt-in and excluded from internal agents by default. Core app modules
   contain no MCP server/tool-name dependency for these operations.

## The isolation boundary

### Architecture decision

Build a small internal control SDK first. Features use its registration contract
to expose operations, observations, descriptions, and optional change events.
The MCP adapter uses its invocation contract to discover and call those
capabilities. "Public" means the supported import boundary inside this repo;
this is not a published library or a new mandatory application-wide API.

The user clarified that relevant app code should integrate with the control
SDK, rather than rerouting ordinary UI actions through a new application SDK.
Accordingly, capability handlers live beside their feature/domain owner and
reuse existing domain operations. The SDK owns control plumbing: registration,
validation, target/window routing, request lifetime, and invocation history.
Features retain their business rules and state. MCP owns protocol, connection,
and authentication concerns. Ordinary UI actions do not require the control
executor, history store, or MCP server to work.

```text
External MCP adapter
          |
   control SDK invocation / routing / history
          |
   feature-owned capability handler       Existing UI action
          |                                      |
          +--------- existing domain operation ---+

Feature registration -> small control SDK contract
MCP tools            -> small control SDK invocation API
```

Proposed source homes, replacing the earlier mixed `control/` sketch:

```text
src/control-sdk/
  index.ts                  Explicit registration/invocation contract exports
  contracts/                Capability schemas, results, identity/cursors
  registration/             Typed definitions and lifecycle registration
  client/                   Typed invocation over a narrow request transport
  ports/                    Transport/storage requirements; no app imports
  core/                     Registry and control request execution, kept private
  core/target-resolution/   Private reconciliation of target/ownership evidence
  catalog/                  Catalog queries over provided descriptors
  reads/                    Private depth/range/live-history projection services
  history/                  Invocation lifecycle over an injected persistence port

src/main/control/
  createControlHost.ts       Main composition; installs feature capabilities
  adapters/                 Window/storage/transport implementations
  rendererBridge.ts         Window routing and generation-aware IPC transport

src/preload/api/control.ts   Typed IPC facade; no operation policy

src/renderer/src/control/
  registerRendererHost.ts    Window-level composition, registration and teardown

src/main/<domain>/control.ts
src/renderer/src/features/<feature>/control.ts
  Feature-owned capability descriptors/handlers alongside their real owner
  Workspace capabilities may live beside workspace actions instead of features

src/main/externalControlMcp/
  host.ts                   Independent opt-in authenticated MCP lifecycle
  tools.ts                  MCP registration and result serialization
  connectionSettings.ts     External operator setup and revocation
```

Directory names are proposed. Public exports and import rules are the contract;
do not create an empty file/class for every name before a stage needs it.

### Registration and invocation shape

Each capability declares a stable application ID, description, input/output
schemas, execution owner (main or window), target requirements, availability,
effect/completion semantics, and handler. For example, the workspace owner
registers `agents.show` and binds it to its explicit-ID navigation operation.
The command-picker owner exposes search/open capabilities. Features can also
provide reference-only entries for UI behavior without a direct operation.
Reuse current command/default declarations rather than rewrite their inventory.

The SDK provides typed registration and invocation APIs. Conceptually:
`registerCapabilities(definitions, dependencies)` installs handlers and returns
cleanup; a caller-bound `client.invoke(capability, input)` invokes a validated
contract. Exact signatures are Stage 1 work, not a generic untyped string bus.
Convenience methods can wrap that API where they help a real caller; do not
generate a second app-wide facade simply for symmetry.

Main owns the registry/router and durable control history. Main feature handlers
remain in main; renderer handlers remain in their window. Only serializable
descriptors and requests cross IPC, never closures. Registration is per owning
window/generation, disposed on reload/unmount, and rejects duplicate IDs within
the same owner. App-level composition installs capabilities while their feature
is available, rather than requiring its panel to be visibly mounted. Handlers
obtain fresh state at invocation instead of retaining stale render closures.

The composition root creates a caller-bound client for each trusted transport;
tool arguments cannot forge the actor, source, capabilities, or window identity.
Application capability IDs and shared schemas live in the control contract;
`ac_*` MCP names, protocol annotations, and any selective tool exposure mapping
live in the MCP adapter. Feature code never imports `McpServer` or protocol types.

No public `invokeAnyIpc`, `getStore`, arbitrary `eval`, mutable `SessionManager`,
React hook/context, or untyped dispatcher escapes through the SDK. A typed
internal request union may implement transport, but callers retain typed inputs
and discriminated results. The SDK is a registration/routing contract, not a
second implementation of feature behavior or a universal IPC escape hatch.

Keep `SessionFeed` intact. It remains the existing narrow event/I/O seam used by
desktop and remote. Registered control capabilities reuse compatible services;
it does not turn that feed into a global control interface.

### The genuinely hard component and its single consumer

The hardest control concern is target ownership over time: an external name or
ID must become exactly one app entity, owner window, and relevant backend/view
generation, even while focus, layout, recovery, or provider identity changes.

Confine that reconciliation to `src/control-sdk/core/target-resolution/`. Its only
production consumer is the SDK operation executor. It emits one `ResolvedTarget`
or a typed ambiguity/stale/unavailable outcome. Adapters provide evidence and
mutation-boundary checks, not alternative heuristics. UI and MCP cannot import
the resolver or invent fallbacks from "newest session" or "currently focused."

`ResolvedTarget` is not a lock or proof of future validity. The executor passes
the identity and relevant version constraints to the responsible feature handler;
the domain operation checks them at the actual mutation boundary and after awaits.

The other reconciliation concern is live/committed reading. Isolate it under
`src/control-sdk/reads/` behind a single agent-read service consumer. Input adapters
reuse existing ownership projections and canonical IDs. The SDK produces one
`ConversationSlice`; MCP, history serializers, and UI readers consume it without
each deciding whether a partial live message duplicates a committed message.
If existing projections cannot support that contract, revise this stage before
writing a second renderer or scattering provider-specific filters in tools.

### Enforced import rules

| Code | May import | Must not import |
|---|---|---|
| SDK contracts/registry/client/core | Explicit SDK internals, approved neutral shared contracts, schema library | Electron, React/Zustand, MCP SDK, provider runtimes, app singletons, `window.api` |
| Main feature control registration | SDK registration contracts and its existing main/shared domain operations | Renderer source/hooks, external MCP modules, SDK private resolver/projection internals |
| Renderer feature control registration | SDK registration contracts and its existing renderer domain operations/projections | MCP SDK/tool names, main services, SDK private execution internals |
| External MCP adapter | Supported control client/catalog/history API, public schemas, MCP/HTTP/auth infrastructure | Feature handlers, workspace stores, command closures, SessionManager, provider runtimes, private SDK modules |
| Ordinary UI command/component | Existing domain operations/view helpers; optional narrow SDK integration | MCP code or SDK private execution/ownership internals |
| Existing domain mutation | Its current domain dependencies and narrow operation inputs | MCP objects, external client tokens, or a dependency on a control request being active |

Composition roots may import explicit host factories and adapter constructors.
Name these exceptions, rather than using broad `@main/**` or `@renderer/**`
allowlists that make the boundary meaningless. Check resolved imports, re-exports,
type-only imports, and dynamic imports in CI. Type-only coupling to a private
module is still coupling even if a browser bundler erases it.

### Reuse the behavior, not a new mandatory UI route

Some current behavior exists only inside hooks or UI callbacks. Extract the
smallest explicit-target domain operation needed by the capability, or inject
an existing suitable action at registration. Keep normal UI execution intact:

```text
UI command -> existing dispatcher/admission -> domain function
MCP tool   -> control SDK -> feature handler -> same domain function
```

Both paths preserve domain preconditions and mutation-boundary identity checks.
When a rule is currently buried in UI admission, share that rule deliberately;
do not create looser automation behavior or duplicate policy in a tool handler.
Classified interactive commands can use the existing dispatcher through the
feature's adapter; direct operations use explicit targets. `commands.run`
describes/opens an interactive route when required parameters are missing.

If a particular app caller benefits from invoking the SDK, it may opt in, but
its registered handler must call the underlying operation rather than that same
SDK-backed command. Verify the UI and registered capability reach the same
result for one real navigation action before exposing a family. Removing the
registration must not break normal UI behavior. Do not rewrite the app's action
architecture as a prerequisite for external control.

## Stages and independent gates

All stages below are sequential unless independence is demonstrated in a revised
decomposition. Approval of this artifact authorizes progressing through verified
stages without asking again after each stage. A changed boundary or unresolved
semantic contradiction triggers revision, not another local conditional.

### Stage 0 — source and ownership census (verified)

- **Produces:** `docs/decomposition/evidence/external-control/source-inventory.json`
  and the A/ownership tables in this document, tied to a source commit.
- **Verified by:** reread/hash the listed source; check the seven navigation kinds
  against the actual union and confirm production counts exclude tests/submodules.
  No later implementation is needed to inspect these facts.
- **Why separate:** otherwise MCP tool design quietly defines ownership and
  captures only visible commands, missing fixed inputs and hidden placements.
- **Reality check:** actual catalog, resolver, navigation, window/session, feed,
  bridge, launch, and transcript source. It is not recorded usage or test evidence.

### Stage 1 — registration contracts and enforceable dependency boundary (verified)

Implementation: `src/control-sdk/` contains typed capability definitions,
owner-scoped registry, invocation client, explicit feature/host entry points,
and JSON descriptors/results. `tsconfig.control-sdk.json` compiles the production
SDK with no Node, DOM, React, or Electron ambient types; the normal typecheck
runs this gate. Colocated import-boundary tests scan resolved source imports.
Verification: neutral compilation passed; 9 focused checks passed, covering
pre-dispatch validation, trusted caller identity, window ambiguity, duplicate
batch registration, stale/in-flight generations, uncertain failures, catalog
isolation, and import rules. These are deterministic contract probes, not
recordings of production usage. The existing app uses UUID window identities,
so the SDK preserves string window IDs rather than inventing Electron IDs.

- **Produces:** minimal capability definition/registration/invocation contracts,
  typed results, a registry factory, and a resolved-import boundary check wired
  into project checks.
  Start with observation, catalog, and agent-show contracts needed by the next
  stage; do not generate stubs for the entire eventual tool catalog.
- **Verified by:** compile the neutral SDK without Electron/React/MCP imports;
  run the import check against existing graph and deliberately forbidden edges;
  register/invoke/dispose a capability with contract doubles without loading the
  app, and reject duplicate registration within an owner.
- **Why separate:** hiding main/renderer dependencies behind an `sdk` filename
  would make every later adapter depend on the same tangled implementation.
- **Reality check:** existing `SessionFeed` separation, IPC contracts, and source
  types identify actual boundaries. Compile checks prove contracts, not behavior.

### Stage 2 — main/renderer registration and one canonical observation (verified)

Implementation: main control composition and correlated renderer bridge, typed
preload, window-level registration/cleanup, `app.windows`, and feature-owned
`workspace.observe`. Observation reads the live store without subscriptions or
provider wake; it preserves related, detached, buried, and mirrored placements.
Verification: full application typecheck passed. Twelve SDK/bridge unit checks
and two renderer checks passed. The colocated Electron system trial bundled the
actual host, preload, registration, and workspace capability, opened two isolated
context-isolated/sandboxed windows, observed distinct workspace IDs, reloaded one,
rejected its old generation, and continued observing the other. The final trial
passed twice, including after registration cleanup changes. Its workspace data
is a deterministic setup, not a recording of private user data. No providers or
normal app bootstrap were started. Run renderer checks with the repo's Node 24
version; the shell's Node 25 exposed an incompatible native localStorage global.

- **Produces:** main composition, typed preload transport, feature registration,
  and an SDK observation listing entity IDs, placements, owners, and generations.
- **Verified by:** in an isolated dev workspace compare SDK observations with
  actual windows/layout; reload one renderer and verify generation/stale-response
  handling while other windows remain observable. Dispose registrations and
  verify stale handlers cannot run; verify hidden panels do not remove available
  capabilities. Exercise transport loss without depending on an MCP server.
- **Why separate:** the SDK must know what exists before commands can target it;
  otherwise tool handlers accumulate ad-hoc store reads and focus fallbacks.
- **Reality check:** current workspace shapes, window registry, renderer bridge
  patterns, and narrow observed snapshots from this dev scenario. No provider
  activity is required just to establish window/layout identity.

### Stage 3 — app, feature, command, and keybinding catalogs (verified)

Implementation: `app.describe` defaults to a ten-section crash course and can
retrieve individual sections or the paginated full guide. Thirty-six authored
feature pages live beside 32 feature owners; shared/feed infrastructure is
explicitly assigned to its user-facing page. Command references enumerate the
real unfiltered catalog. Command-picker and control search share description
matching while preserving title priority. Keybinding references use the actual
router's defaults/override resolver (including its existing global context for
custom bindings without defaults), plus feature-owned contextual descriptions,
native reservations and configured keyboard/mouse inputs. External
Monaco/provider keymaps are identified as external rather than invented as
complete app-owned mappings. Settings documentation reads the real registry.
Pagination fingerprints its contents and rejects stale cursors after a change.

Verification: full application typecheck passed; 16 focused unit checks and four
renderer checks passed. The feature-owner coverage gate covers every current
feature directory and validates command links. Full-guide pagination retrieved
all sections without duplication, including late feature pages. Real catalog
description search, hidden commands, explicit unbinding, saved unknown IDs,
mouse configuration and changed-page invalidation were exercised. The actual
two-window Electron trial also retrieved the UI guide and reflected a settings
shortcut change immediately through the registered command capability.

- **Produces:** SDK catalog methods, feature-owned descriptions, complete command
  and shortcut projections, shared description-search rules, and versioned pages.
- **Verified by:** enumerate against the actual generated command catalog and
  effective keybinding resolver; change a real shortcut/visibility preference in
  isolated settings and compare results; check feature/UI/settings references.
- **Why separate:** discoverability must be inspectable before tool wrappers or
  mouse use hide missing entries; a static MCP-only manual would drift.
- **Reality check:** actual command/default/reservation/settings/surface
  declarations and the full application inventory, not a guessed tool list.
  Authored feature explanations remain subject to product review.

### Stage 4 — operation execution and durable invocation history (verified)

Implementation: the neutral executor owns owner arbitration, durable intent,
concurrent admission and caller-scoped retry keys. A separate main-process
filesystem adapter writes private, fsynced JSONL events and immutable SHA-256
payloads. Every authenticated SDK invocation has its own call ID, including
retries; replay returns the original result or explicit uncertainty after a
missing final write. A reused key with changed arguments is rejected. History
list/read/payload capabilities preserve complete data and lossless UTF-8 byte
continuations; list snapshots stop before their own read so pagination finishes.
The store is lazy and its directory is injected, including in Electron trials.
A damaged tail is preserved and blocks new dispatch instead of being truncated.

Verification: 13 focused registry, boundary and real-temporary-filesystem checks
passed, including concurrent retry/reopen, lost final-write recovery, damaged
tail preservation, private file mode, large Unicode reconstruction and bounded
history paging. The two-window Electron trial passed with actual persisted
execution, reload and live catalogs. Its main bundle now externalizes Node
builtins rather than treating filesystem imports as browser dependencies.
These are controlled fault probes, not production traffic recordings. Entity
placement remains feature-owned; the private resolver arbitrates explicit
window generations, never focus guesses. Protocol-frame recording is connected
with the external transport in stage 7.

- **Produces:** private target resolution, execution lifecycle, deduplication,
  a persistence port/implementation, and SDK history list/read/payload methods.
- **Verified by:** real writes/reopen against temporary storage, controlled
  termination between intent/dispatch/result, duplicate argument checks, late
  result handling, history-read recursion bounds, and full payload retrieval.
  Verify harmless test-domain operations before routing real agent mutations.
- **Why separate:** logging after mutations cannot recover missing intents;
  putting retries in tool handlers duplicates effects and makes SDK callers differ.
- **Reality check:** existing uncertain-prompt/renderer-timeout behavior plus
  actual persisted artifacts from fault probes. Newly injected faults are
  labeled contract probes, not fabricated production recordings.

### Stage 5 — navigation and the first feature-owned control slice (verified)

Implementation: registered cross-window search/observation, stable-ID locate/show,
explicit buried restoration, title/pin, project-open, detached create, grid
placement discovery/attach, and provider prompt delivery. The feature owns each
handler. UI labels and stable IDs share the existing navigation action/reducer;
hidden related children can use their parent's view, and a wake cannot replace
a different slot after focus moves. Showing verifies focus, a rendered pane and
its window-relative bounds. The executor records owner resolution/window focus
steps. Target arbitration uses all live window observations and rejects missing
or duplicate ownership. App documentation alone opts into replicated-read
routing, so the crash course works as the operator's first call in a multi-window
app; window-specific shortcuts and actions retain explicit ownership.

The command picker stays lazy. A feature-owned request rendezvous acknowledges
the rendered query/selection on a frame and never executes the highlighted row.
Creation returns the actual spawn ID instead of inferring it from a before/after
census. If the project disappears during spawn, cleanup carries the captured
scope to main's existing atomic ownership check, including before React refs
catch up. Prompt delivery preserves drafts and distinguishes acceptance from
completion; post-write uncertainty is never retried.

Verification: full app typecheck and the neutral SDK check passed. Fifty-seven
focused checks plus two placement/restore checks passed, including all existing
seven-kind navigation cases, stable-ID/UI equivalence, focus-during-wake, hidden
related reveal, picker frame acknowledgement, prompt target revalidation and
uncertain delivery. The actual two-window Electron trial routed a title mutation
to the right window from only its session ID, found it globally, rejected an
injected duplicate owner, retrieved the owner-free UI guide, and survived reload.
The trial builds real production bundles with a separate build budget; its app
runtime deadline remains 25 seconds. The full packaged hybrid operator trial
remains in stages 7/10; these checks do not claim provider tasks were run.

- **Produces:** registered search/locate/show/palette-open capabilities and an
  explicit-ID domain navigation action shared with the existing UI path.
  Follow with project-open/create/prompt/title/pin/placement operations from Tier A.
- **Verified by:** demonstrate UI and SDK reach the same existing agent without
  duplicates; cover all seven navigation kinds, related-child reveal, explicit
  buried restoration, cross-window routing, and focus changes during wake.
  Verify lazy palette mounting and acknowledged query selection separately.
  Remove the control registration and verify ordinary UI navigation still works.
- **Why separate:** one complete UI/control slice exposes policy and ownership
  mistakes before dozens of wrappers copy the wrong integration pattern.
- **Reality check:** `navigateToAgentIndexTarget`, current wake/revalidation code,
  actual placement shapes, and observed isolated UI navigation. Capture a narrow
  unresolved case before asserting new behavior; do not invent a replacement policy.

### Stage 6 — lightweight canonical agent reads

**Status: verified and implemented.** `features/feed/controlRead/` is the only
control consumer of the canonical adapter/ledger/feed bridge. `agents.read`
exposes independent depth/range, frozen message pages, delta upserts and transient
removals, status-only polling, and separate older-history cursors. Default prose
includes visible intermediate assistant blocks and actual user prompts; queued
prompt carriers and compact summaries cannot become user prompts.

The main-owned `sessions/control.ts` adapts existing file-window readers and the
supported OpenCode export operation as `transcripts.page`; it never wakes agents
or populates UI runtime/scroll state. Exact file cursors validate inode, size and
record hash, including records without UI markers. A deliberate same-size boundary
rewrite exposed the existing reader's catch-to-empty fallback; strict control reads
propagate failures while ordinary UI fallback policy remains unchanged.

Evidence: `evidence/external-control/read-corpus.json` identifies three existing
provider incident fixtures and hashes, with the OpenCode reconstruction gap stated.
Focused checks cover UI-visible assistant-block parity, full-depth prose retention,
lossless frozen message paging, Unicode boundaries, unchanged delta/replacement
reset, no-IO status/no-wake cold reads, all cold Claude history across more than
16 snapshots, repeatable archive cursors, and real-file position/rewrite probes.
The fixtures are static real observations; live partial-to-committed behavior and
native terminal visibility remain part of the stage 7 operator trial, not a claim
that a synthetic provider-transition harness ran here.


- **Produces:** one SDK agent-read service and `ConversationSlice` contract with
  conversation-default depth, independent range, payload continuations, and deltas.
- **Verified by:** compare reads to real user/assistant records and the visible
  active message; show partial-to-committed updates without duplication, exact
  large-message recovery, and explicit cursor reset on rewind/replacement.
  Measure that status/delta requests avoid whole-runtime/history serialization.
- **Why separate:** each transport otherwise creates its own role filters,
  partial-message ownership rules, and interpretation of an empty result.
- **Reality check:** existing sanitized transcript/rendering fixtures and actual
  supported provider history formats. Collect only missing live-transition
  evidence; no general recording framework is a prerequisite.

### Stage 7 — external MCP adapter and hybrid operator trial

**Status: protocol, multi-window routing and exclusion verified.** The removable
`main/externalControlMcp/` adapter imports only its own modules, SDK contracts and
protocol/platform dependencies. It wraps registered public capabilities as `ac_*`
tools, publishes input/output schemas, accepts explicit window/generation routing,
and records full authenticated protocol requests/responses without HTTP secrets.
A main-owned connection setting applies to all windows, persists disabled by
default, copies private configuration locally and supports key rotation/disable.

Verification uses a real SDK HTTP client against two isolated context-isolated
Electron windows, real renderer registration/catalogs and a temporary durable
journal. It covers automatic agent ownership, explicit window selection, ambiguous
ownership, reload rejection, per-window bindings, crash-course retrieval, call
history and continuing SDK operation after server disable. A separate HTTP codec
probe covers recursive output schemas, large Unicode payloads, private capability
exclusion, origin/auth rejection and full protocol records. Settings tests cover
private persistence, rotation and credentials staying out of tool results.

`provider-exclusion.json` records actual disposable Claude/Codex CLI observations
and the narrower OpenCode configuration/source evidence. No user MCP configuration
was changed. Full native-provider/computer-use smoke coverage remains in final
integration (stage 10); these protocol trials are not presented as that coverage.
The user explicitly waived a broad recording harness, so this distinction stays
visible instead of inventing provider recordings to fill a test-count target.


- **Produces:** opt-in loopback MCP host, connection UI, wrappers generated from
  public SDK schemas, full transport-call capture, and internal-launch exclusion.
- **Verified by:** connect a real external client; search/show/open picker/read/
  prompt through MCP, finish an interaction with computer use, and inspect the
  resulting state/history. Disable the adapter and verify the SDK/UI still work.
  Verify exclusion in disposable provider configurations, including recovery.
- **Why separate:** independently working SDK behavior is the substrate; mixing
  protocol handling into it would hide whether failures belong to app or transport.
- **Reality check:** real SDK outputs, actual MCP requests/results from the trial,
  and provider configuration behavior. Keep any captured private material local.

### Stage 8 — Tier B operations through the same SDK

First control slices implemented (2026-09-05): contextual command dispatch,
revision-checked draft reads/edits, backend-authoritative advertised condition
actions, explicit project layout and Dispatch row/lane operations, editor buffer
inventory/navigation, and window create/focus. These do not complete Stage 8;
remaining lifecycle/provider/history/terminal slices still follow this gate.

The command host mounts lazily and rejects stale selection or a competing native
invocation. Draft integration uses the real composer setters and persistence
notification. Condition reconciliation is confined to the main-owned adapter:
renderer metadata proves scope; the manager supplies current backend generation
and action state; validation and dispatch have no intervening await. No arbitrary
condition payload or guessed key sequence is accepted. Grid shape passes explicit
source-row identity to the existing owner rather than rebuilding its invariants.

Evidence: the real composer hooks and dispatcher were exercised through React;
the existing persisted `dispatch-global-d23` workspace drove layout edits. The
condition test uses the recorded Claude 2.1.251 screen preserved by the pinned
headless parser test (debug bundle `2026-08-30T23-51-06-471-9bd68e14`), copied
verbatim with its already-neutralized path into
`testing/fixtures/external-control/claude-trust-2.1.251.txt`. Its real parser and
condition module produce the advertised actions. This verifies semantic trust
dispatch and stale generation/dialog refusal, not every provider's live dialog.

- **Produces:** implemented SDK methods/adapters and MCP wrappers for lifecycle,
  provider switching, conditions, Dispatch/layout, terminal I/O, history/rewind,
  drafts, and editor navigation, as listed in the product plan.
- **Verified by:** complete each operation through its domain owner and verify
  identity/side effects before registering its wrapper. Check UI parity and
  supported provider/runtime differences per slice; rerun the import gate.
- **Why separate:** adding whole tool families before proving their domain
  operations encourages handler-specific behavior and bypasses.
- **Reality check:** existing provider transactions, close policy, layout rules,
  draft/buffer versions, and concrete isolated app trials for the changed paths.

### Stage 9 — Tier C breadth and complete reference coverage

- **Produces:** SDK multi-agent reads/prompts, templates, supported settings,
  external-owned workflow operations, usage/worktrees, and surface navigation;
  feature/command/shortcut references updated alongside each operation.
- **Verified by:** real end-to-end tasks with per-target partial results, bounded
  reads, supported setting changes, and an existing workflow. Enumerate the full
  reference and verify UI-only features remain explained and reachable.
- **Why separate:** batch and workflow ownership add real shapes; they should not
  be smuggled into a single-agent API as optional fields without explicit semantics.
- **Reality check:** existing service interfaces and real batch/workflow outcomes.
  Full workload stress/soak tooling is added only for an evidenced requirement.

### Stage 10 — packaged integration and removal proof

- **Produces:** verified packaged connection/setup, persisted history/read
  behavior, final SDK export documentation, boundary checks, and reviewed PRs.
- **Verified by:** applicable type/unit/system/renderer/package gates; external
  connect/reconnect/revoke; history after restart; closed-palette cost; disable
  external MCP and demonstrate registered control and UI operations still function;
  remove feature control registration and verify its ordinary UI path still works.
- **Why separate:** dev aliases and available Node processes can mask coupling
  and packaging failures; source tests do not establish the shipped lifecycle.
- **Reality check:** actual packaged artifacts and recorded verification results,
  not a tool-count target or assumed compatibility.

## Unknowns and decisions to settle at their stage

1. Which fixed/native/editor shortcuts are discoverable from runtime declarations,
   and which need a small feature-owned descriptor? Reservations are incomplete
   as a description of runtime consumption. Settle in Stage 3.
2. Which command closures have truly completed effects versus fire-and-forget
   behavior? Classify from source and observed completion before SDK adoption.
3. Which renderer actions can be exposed without triggering a render/subscription
   regression? Start with one navigation slice; preserve the closed-palette model.
   Settle registration ownership, teardown, fresh-state access, and availability
   of capabilities whose panels are hidden before exposing more feature families.
4. What is the correct outcome when the requested destination disappears while
   a target wakes or a provider switches? Preserve existing mutation checks;
   don't redirect silently. Ask for product judgment if existing semantics conflict.
5. How should session/window migration and duplicate visible placements affect
   operation preconditions? Use relevant generation/ownership, not a global
   revision invalidated by unrelated streaming activity.
6. How much existing transcript projection can be reused without importing
   renderer internals or copying the rendering ledger? Verify live/committed
   identity and provider coverage before finalizing the Stage 6 port.
7. How should current-exchange range distinguish accepted prompts from queued,
   optimistic, or provider-compaction carriers? Derive from actual delivery and
   transcript evidence, not only top-level role labels.
8. Which source provides efficient message cursors for each provider, and which
   needs an index? Avoid a fake lightweight API that reparses all history.
9. How does each provider merge globally configured MCP entries on launch/resume,
   including workflow workers? Verify reserved-server exclusion rather than assume it.
10. How should external workflows be owned without inventing an internal session?
    Confirm WorkflowService/bridge requirements before the Stage 9 adapter.
11. Which storage budget/retention settings should ship for full prompt/result
    history? Keep payload completeness honest; no silent deletion or secret capture.
12. Which result framing belongs to the SDK and which to MCP? Use one invocation
    store: SDK records canonical operations/steps, and a trusted transport-recording
    hook appends the actual MCP request/result envelope under the same call ID.
    Do not implement two disagreeing audit trails or expose that hook as a tool.
13. Which app features have no canonical descriptor today? Source inventory is
    the discovery input; explanations require review rather than filename inference.

This list is intentionally non-empty. A green compile or large test count does
not resolve these semantic questions.

## Evidence and fixture plan

| Evidence | Where it comes from | Produced/checked in stage | How it is used |
|---|---|---|---|
| Source census | Tracked declarations and source hashes | 0 | Ownership and coverage review |
| Catalog/keybinding reference | Actual catalog exports, default/custom override resolution, fixed-interaction owners | 3 | Enumeration/search/default-versus-effective verification |
| Transport/storage probes | Actual SDK adapter requests and temporary journal writes, with deliberate lifecycle faults | 2, 4 | Routing, persistence, uncertainty, and deduplication contracts |
| Navigation observations | Isolated app workspace exercising actual layout modes and stable session identities | 5 | Expected destination and no-duplicate behavior |
| Conversation/live fixtures | Existing checked-in sanitized records; narrowly captured missing provider transition if needed | 6 | Text/role selection, live ownership, cursor transitions |
| External operator trace | Actual MCP calls/results and UI changes from an explicit trial | 7–9 | Hybrid loop, full history, capability coverage |
| Package evidence | Built macOS artifacts and observed lifecycle | 10 | Shipping verification |

Keep source evidence under `docs/decomposition/evidence/external-control/`.
Colocate implementation tests with their modules. Place new behavioral fixtures
beside those tests unless they must join the shared rendering corpus. Never
commit private transcripts, operator credentials, real prompt payloads, or a
machine-wide state dump merely to satisfy a fixture requirement. Sanitize real
inputs while preserving the identities/relations needed by the assertion and
record provenance without exposing private source paths.

Tests for known contracts may use deterministic doubles and faults under the
user's harness exception. For an unenumerated provider shape, acquire evidence
first rather than fabricate an input and call it reality. A failing real case
is a reason to revisit ownership, not delete the case or loosen assertions.

## Approval and ongoing checkpoints

The proposed decision is: small internal registration/invocation SDK first;
feature-owned capability handlers reuse existing domain operations; private
target/read reconciliation; MCP only as an outer adapter; no mandatory UI
migration; enforceable imports; no broad recorder/harness prerequisite.

After approval, implement Stage 1, independently verify its artifact, then
continue stage by stage. Record the exact evidence/check results in this document
and the implementation PRs. Product behavior remains governed by the detailed
plan; this decomposition governs architecture and stage order where its earlier
file-tree/phase sketch differs.

If a stage invalidates the public boundary, authoritative owner, or promised
result semantics, stop that implementation path, revise this artifact with the
new evidence, and obtain approval for a materially changed design. Routine
implementation details within the approved boundary do not need repeated approval.

## Operator documentation and skill addition (2026-09-05)

User steering explicitly requires multi-window operation, model-facing tool
clarity checked against MCP documentation, and the `agent-code-computer-execution`
skill. These extend the approved operator surface; no new implementation approval
is needed. Its source lives in
`operator-skills/agent-code-computer-execution/SKILL.md`, outside app-managed and
provider auto-discovery directories. It is intended to be installed by the external
operator client, not distributed automatically to managed agents. It uses the live
`app.describe` and catalogs instead of copying the complete UI manual.

Tool descriptions and field-level Zod descriptions remain beside the owning
capability. The MCP adapter translates capability references to their public tool
names, adds explicit window/generation/request-key routing and publishes the actual
SDK result envelope as outputSchema. Structured results are also serialized in a
text block for compatible clients. Annotations remain hints; application-only
capabilities are excluded from discovery and rejected by the SDK for external callers.

Source guidance checked: the official MCP 2025-11-25 tools specification (matching
the installed SDK's supported protocol generation), current MCP server concepts,
and Anthropic's Writing effective tools for AI agents. The concrete authoring rule
is purpose/selection, parameter sources and units, result meaning, significant
side effects, and useful continuation/recovery instructions—not word-count tests.
