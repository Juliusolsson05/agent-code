# Session operation ownership and recovery program

Status: proposed implementation program; planning deliverable complete, runtime implementation not started.

Date: 2026-09-12. Tracking issue: [#918](https://github.com/Juliusolsson05/agent-code/issues/918).

Application baseline: `552914f5610518458f944fa1bdaf63f243685bd1`.

This is an execution plan for a sequence of independently reviewable changes. It consolidates the three architecture reviews supplied in the conversation, resolves their overlapping recommendations, and turns them into ownership contracts, admission rules, recovery procedures, regression oracles, and migration gates. It is not an assertion that proposed services, types, or tests already exist. Approval of this document reviews the program; the present task authorizes writing the plan, not executing every implementation batch or merging a PR.

## 1. Outcome, scope, and decisions

### 1.1 The delivered outcome

A user-recognizable agent retains its identity and exact project membership while its native context, execution attempt, and presentation can change independently. Main admits and records semantic operations. Renderer views project the result and retain authority over local interaction and layout. Native packages retain their specialized execution, history, input, and custody contracts.

An operator should be able to inspect a session change and answer: which agent and source did we capture; which target was prepared; what information changed; which native effects occurred; which binding owns input now; which relationships were preserved; and what recovery remains possible. Those answers must come from bounded, identified operation evidence, rather than reconstruction from several unrelated promises and timestamps.

The initial value comes from repairs to composition failures. The larger membership migration is justified by fewer contradictory authorities and reliable cross-window operations, not by a target file size or desired number of classes. Existing lifecycle and renderer correctness mechanisms remain until a replacement demonstrates the same observable contracts.

### 1.2 Scope boundaries

Included are interactive session lifecycle, exact project membership, typed relationships, conversation continuation, event/history lifetime propagation, orchestration request correlation, quit preparation, OpenCode and LSP reliability, safe resource inventory, package integration contracts, editor crash recovery, and measured fleet performance. Workflows participate through origin/reference and termination contracts; this program does not replace their durable execution engine.

Excluded from the initial program are a generic provider protocol, a universal parent/child tree, moving native transcripts into an application database, automatic credential migration, an Electron/platform rewrite, global workerization without profiles, new providers, and opportunistic UI redesign. Grok integration and extension-platform work can consume the resulting capabilities through their own issues. No benchmark improvement is promised before measurement.

A semantic membership catalog is deliberately small: identity, membership, relationship endpoints, current binding references, and recovery receipts. It does not become the home for split ratios, scroll offsets, composer keystrokes, semantic token accumulators, native transcript copies, Monaco models, or Markdown caches.

### 1.3 Decisions that reconcile the reviews

| Question | Program decision | Why / gate |
| --- | --- | --- |
| Add another logical agent ID immediately? | No. Audit `agentNameId` and its lifecycle first. Prefer formalizing it only if its invariants hold for every session category; otherwise migrate to one replacement identity. | The third review correctly qualifies the first. A naming feature's persistence is not proof of total logical identity. Permanent overlapping identity authorities add risk. |
| What defines a project? | Exact semantic membership corresponding to a project tab, preserving existing tab identity where valid. | A cwd, repository root, or worktree is not a membership scope. Deliberate duplicate tabs remain supported after PR #914. |
| Which state moves to main? | Semantic graph mutations and current binding/operation authority. Layout and hot UI state stay in renderer. | A lost view must not erase membership; moving every token to main would undermine current state isolation. |
| How to store the initial catalog? | A versioned JSON journal/snapshot store with one writer, checksummed records, explicit durable commit points, and recovery tests. | Reuse the repository's storage discipline. SQLite is a later decision if measured query/transaction needs justify it; changing the engine cannot atomically stop processes or publish provider history. |
| Replace the Codex ledger? | No. Continuation receipts reference its transaction/custody evidence. | Logical identity continuity does not prove exclusive native writer custody or successful predecessor teardown. |
| Create another command bus? | No. Reuse control request identity, owner generation, receipt and outcome semantics where applicable; add domain contracts behind existing facades. | The missing guarantee is across operations, not another transport abstraction. |
| What counts as a switched session? | Preparation, native publication, binding activation, and view acknowledgement have distinct outcomes. | A valid target artifact may exist before any live replacement; view failure after activation must not undo truth. |
| What do waits target? | Introduce `WorkRequest` correlation after identity/membership foundations, while preserving separate delivery and execution evidence. | An idle session with yesterday's answer has not necessarily completed today's assignment. |
| What ships first? | Concrete recovery/lifecycle repairs and fidelity propagation; additive contracts and shadow comparisons can proceed alongside them. | They reduce user-work risk and supply trustworthy boundaries for the structural migration. |
| Is editor recovery last? | No. B15 editor recovery and optional-service startup isolation are independent delivery tracks. | They need precise persistence/recovery policy, not completion of renderer optimization or all membership work. |

### 1.4 Invariants to preserve through every batch

| ID | Invariant | Forbidden shortcut |
| --- | --- | --- |
| I01 | One admitted current input owner per logical agent; uncertain predecessor native custody remains represented. | Removing a registry entry means the process stopped. |
| I02 | A stable logical identity can outlive a routing ID, run, native binding and view. | Reusing one string as proof of all lifetimes. |
| I03 | Project scope is exact membership; view transfers preserve it, explicit merges change it transactionally. | Automatically merging same-path tabs or inferring scope from focus. |
| I04 | A current registration/generation authorizes the caller at admission and consequential commit boundaries. | Main ownership grants every caller application-wide mutation. |
| I05 | Prompt staging, transport acceptance, durable queue/user acceptance and execution completion remain distinct. | Boolean success or idle state proves execution. |
| I06 | An unknown post-dispatch outcome never becomes automatic replay permission. | Timeout means no effect. |
| I07 | Source/target native identity includes a namespace; locators are generation-scoped evidence. | Select the newest file or trust a still-readable old path. |
| I08 | Committed/live/ghost/optimistic/queue observations reconcile through the ownership ledger. | Independent array rendering or fuzzy text identity. |
| I09 | Retirement fences producers, buffered work, async history and consumers; dormant history does not require a live run. | Producer-only fencing protects already-buffered events. |
| I10 | Rewind changes context, not project files; duplicate creates independent logical and native identities. | Copy orchestration request completion, bootstrap consumption or credentials with history. |
| I11 | Inventory uncertainty is explicit before destructive reconciliation. | Invalid/partial/future workspace becomes an empty complete inventory. |
| I12 | Every persisted store states its actual publication/durability guarantee and downgrade policy. | Atomic rename implies fsync or a multi-file transaction. |
| I13 | Unknown/partial diagnostic evidence cannot establish absence of an event. | Missing log means nothing happened. |
| I14 | Resource bounds retain correctness and ownership evidence or stop admission explicitly. | Evict an unresolved receipt/lease to satisfy an LRU cap. |
| I15 | Tests exercise the real caller of a safeguard at relevant composition boundaries. | A mocked dispatcher, projector or request method proves the enclosing integration. |
| I16 | Each semantic fact has one authoritative writer after cutover. | Permanent bidirectional catalog/workspace synchronization. |

## 2. Evidence, baseline, and issue ownership

### 2.1 What was actually examined

The full 2,558-line [architecture reference](../../../ARCHITECTURE.md), including diagrams and appendices, was read before this plan. It describes revision `6a19e4ee`, inspected September 11. The source baseline for this plan is the later immutable commit above, including merged PR #914. The original checkout and remote advanced during intake; observations for application findings were re-read from the dedicated baseline worktree rather than assuming all moving branch views matched.

Bounded local reads covered shutdown composition, workspace/tmux inventory, session event routing, LSP request/cleanup and IPC admission, orchestration caches/queue timeout, agent-name design/identity references, provider IPC and continuation transformations, draft reconstruction and native writers. Structured OpenCode wrapper/SSE/stop code was read from the clean package checkout matching the baseline pin. This is a planning verification pass, not a complete source audit or a passing application build.

The user pasted the three reviews in full. Their linked sandbox archives/specification were not available here and were not read. Their reported 58 proposed cases, 47 proposed cases, and 19 isolated checks are external review claims. The scenario tables below are this plan's own consolidated implementation checklist; they do not claim to reproduce the unavailable matrices or add those counts into a test total.

One local primitive probe was run: Node `v24.14.1` scheduled `Number.MAX_SAFE_INTEGER` through `setTimeout`; the timer's observed internal delay was `1` and Node emitted `TimeoutOverflowWarning`. The timer was cleared immediately. This confirms the timer primitive, not a measured OpenCode reconnect rate. No live agents were started/stopped, no user transcript transformations were run, and no application or package suite or benchmark was run for this plan.

### 2.2 Package inventory

The reviews describe six packages. This baseline has seven. Six existing checkouts were clean and matched the pinned revisions; the new terminal package checkout was uninitialized, so its implementation has not been inspected. Its directory must not be treated as a valid checkout merely because `git rev-parse` walks upward and returns the parent HEAD. The plan worktree intentionally does not initialize all submodules for documentation generation. B00 establishes a fully initialized integration worktree before runtime work.

| Package | Baseline gitlink | Planning inspection / required follow-up |
| --- | --- | --- |
| `agent-transcript-parser` | `9c99db00f9cf0097c87271d04fd3e3ebf9f1e894` | Host integration inspected; full package/profile audit remains. |
| `agent-voice-dictation` | `3c6f962843532da2a7ddf2cc80f38cacd3196bb1` | Architecture/integration context; target-ticket and credential policy audit remains. |
| `claude-code-headless` | `dd89f3836d14f1bbc028dcf1523a544f1b9ae930` | Preserve exact source/readiness/semantic boundaries; lifecycle package audit remains. |
| `codex-headless` | `5bfeaca988a7d83be3d1010b03bb6d0eca653edf` | Later than architecture's cited pin; repeat custody/input/compatibility checks at this revision. |
| `opencode-headless` | `4f2ef5de7c80ad7a6199dc09869ea3b728752f0e` | Wrapper, SSE and server-stop source patterns inspected; public-wrapper/native integration tests remain. |
| `opencode-terminal-headless` | `e85b3f53be39912fb295c45907b1fb6abd6e4a26` | New separate package; initialization, instructions, public contract and integration audit required. |
| `workflow-mcp` | `b4b98f8d13f59bae0c999c927533f451b491496a` | Preserve embedded service/source approval/journal/custody policy; full package audit remains. |

The gitlink is the app's integration reference, not permission to modify an upstream main branch. Each package fix has its own issue/branch/plan/PR and private checks. The app integrates a tested package commit through a deliberate gitlink PR, preserving public export compatibility where possible.

### 2.3 Evidence classification

- **S — source-confirmed pattern:** the identified behavior/path exists at the stated baseline. Its complete user-visible reproduction still needs the indicated composed test.
- **P — primitive reproduced:** a local isolated runtime behavior was observed, without claiming application behavior.
- **D — documented/existing tracked issue:** reuse its permanent issue; revalidate current code before implementing.
- **H — hypothesis or proposed design:** requires baseline inspection, a fixture or measurement before claiming a defect or benefit.

The source-confirmed finding registry below is linked to separate issue records. Existing issues were searched across open and closed app/package issue titles before new records were created. Issue bodies preserve expected behavior, source revision, impact, proposed regression, and the absence of integration reproduction. Source paths in later batches identify the owners; immutable links in the issues preserve the exact evidence if line numbers move.

| Finding | Evidence | Permanent problem record |
| --- | --- | --- |
| F01 — legacy/v2 tmux inventory | D + S | [#898](https://github.com/Juliusolsson05/agent-code/issues/898) |
| F02 — preserve services when an editor vetoes quitting | S | [#919](https://github.com/Juliusolsson05/agent-code/issues/919) |
| F03 — avoid broadcasting session content when ownership is unknown | S | [#920](https://github.com/Juliusolsson05/agent-code/issues/920) |
| F04 — keep foreign SSE updates from rebinding the selected conversation | S | [opencode-headless#10](https://github.com/Juliusolsson05/opencode-headless/issues/10) |
| F05 — disable SSE reconnect without overflowing the timer | S + P | [opencode-headless#11](https://github.com/Juliusolsson05/opencode-headless/issues/11) |
| F06 — retain process ownership through bounded OpenCode shutdown | S | [opencode-headless#12](https://github.com/Juliusolsson05/opencode-headless/issues/12) |
| F07 — bound OpenCode ingress and diagnostic accumulation | S; allocation risk, unmeasured | [opencode-headless#13](https://github.com/Juliusolsson05/opencode-headless/issues/13) |
| F08 — fence document cleanup to the owning server instance | S | [#921](https://github.com/Juliusolsson05/agent-code/issues/921) |
| F09 — order changes behind pending document authorization | S | [#922](https://github.com/Juliusolsson05/agent-code/issues/922) |
| F10 — validate completions against their post-synchronization revision | S | [#923](https://github.com/Juliusolsson05/agent-code/issues/923) |
| F11 — release stale read waits when newer document intent arrives | S; latency unmeasured | [#924](https://github.com/Juliusolsson05/agent-code/issues/924) |
| F12 — deduplicate pending reads beyond freshness TTL | S | [#925](https://github.com/Juliusolsson05/agent-code/issues/925) |
| F13 — retain mutation reservations after response timeout | S | [#926](https://github.com/Juliusolsson05/agent-code/issues/926) |
| F14 — preserve native projection fidelity reports | S | [#927](https://github.com/Juliusolsson05/agent-code/issues/927) |
| F15 — publish complete native transcript artifacts atomically | S | [#928](https://github.com/Juliusolsson05/agent-code/issues/928) |
| F16 — report and preserve recoverable prompt attachments | S; full media fixtures required | [#929](https://github.com/Juliusolsson05/agent-code/issues/929) |
| F17 — preserve literal markup when draft provenance is ambiguous | S helper / H decoder reachability | [#930](https://github.com/Juliusolsson05/agent-code/issues/930) |

### 2.4 Existing work and collision handling

| Existing work | Relationship to this program | Integration rule |
| --- | --- | --- |
| #898 tmux inventory | B01 direct fix owner | Extend completeness semantics within that issue rather than duplicating the legacy/v2 mismatch. |
| #879 replacement drops relationships; #854 bootstrap delivery | B05/B11 regression inputs | Carry metadata correctly as a tactical fix before identity migration; don't make users wait for the catalog. |
| #894 native-origin conversation change; #895 adoption conditions | B08/B12 binding and snapshot requirements | Prove native rebind, keep foreign-ID quarantine, preserve current conditions during adoption. |
| #886 / PR #887 close cascade safety | B01/B10/B11 relationship close semantics | Coordinate close targets and reservations; preserve explicit target sets and no incidental tab closure. |
| #913 / merged PR #914 project-tab reuse and merge | Existing baseline behavior, not pending implementation | Preserve deliberate duplicate tabs, owned-session set, grid/Dispatch transfer and no process effects. Main cutover must cover explicit merge and close/merge races. |
| #845 / PR #846 OpenCode export integrity | B07/B08 source/import integrity dependency | Integrate with existing export repair; native import and atomic file publication remain different contracts. |
| #896 OpenCode Terminal rewind | B06/B13 capability and draft consumer | Verify the new terminal package before promising parity or applying structured runtime assumptions. |
| #827 orchestration long waits; #875 control observation waits | B05/B11 wait/result semantics | Transport/backgrounding and request completion are separate acceptance criteria. |
| #774 restore admission; #775 boot critical path | B14/B15 scheduling and degraded startup | Keep visible shell publication immediate; measure startup and cancellation responsiveness independently. |
| #769 history work; #766 PTY snapshots; #764 session host process; #763 renderer isolation | B13/B14 measurement and shared boundaries | Do not preselect workers, ring buffers, or terminal checkpoints without equivalence and cost evidence. |
| #365 heap; #372 proxy pressure | Fleet/resource envelope inputs | Compare all process/renderer/native footprints; per-session caps do not imply a fleet cap. |
| #786 package pin alignment; #833 live switch probe | B00/B13 integration gates | Pin inventory and native compatibility remain distinct from archive round-trip results. |

Issue/PR states above were observed during planning and can change. Before editing an overlapping owner, re-read the issue, current PR head, and landed code. Adopt already-merged repairs and revise this plan's acceptance evidence; do not overwrite an active branch or reopen a resolved problem without a demonstrated remaining failure. This plan leaves the pre-existing untracked loose-ends plan untouched.

## 3. Domain model and operation contracts

### 3.1 Identity audit before type migration

B00 enumerates every producer and consumer of `sessionId`, `sessionRunId`, `agentNameId`, native provider ID, transcript locator, tab ID, relationship fields, workflow origin, and MCP registration. Record birth, persistence, remap, deletion, and recovery rules per field. Include individual/bulk reload, clone/duplicate, rewind, provider switch, native `/clear` or `/new`, hibernate/wake, buried/detached records, shells, naming disabled, imports, restoration, and cross-window handoff.

The name registry already provides durable assignments and selected replacement continuity, but a renderer naming reconciler and optional settings are not sufficient evidence that every session has a valid logical identity before its first mutation. Promotion requires totality before admission, uniqueness across windows, non-reuse after close, durable allocation before exposure, deterministic legacy repair and correct duplicate semantics. Tests must inject an assignment arriving after close/replacement and malformed or colliding legacy values. A corrupt name store must not cause identity reassignment.

If these gates pass, retain existing bytes as logical identity and separate the name presentation API from its identity role. If they fail, create one deliberate successor identity with a migration table from validated old identities/routing IDs. Ambiguous legacy collisions remain recovery-required, not automatically fused by cwd or title. The temporary alias map has an explicit retirement criterion after all persisted consumers and resumable operations migrate; old operation receipts retain interpretable historical addresses. Do not let the optional display-name setting control the existence of a domain identity.

### 3.2 Proposed records and lifetimes

These are contract sketches to refine in B00, not drop-in declarations or an instruction to create one class/table per row.

| Record | Authoritative owner | Lifetime and revision rule |
| --- | --- | --- |
| Logical session | Main catalog | User-recognizable agent or shell; survives backend/view changes; a true duplicate creates another. |
| Project space | Main catalog | Exact membership scope; preserve existing tab IDs where valid; explicit merge records retired-to-target mapping. |
| Native reference | Provider adapter plus persisted binding reference | `(provider, namespace, nativeId)`; namespace identifies configured home/service realm without storing credentials. |
| Conversation binding | Main lifecycle/catalog | A logical session's currently adopted context; increment binding revision for switch/rewind/proven native context reset. |
| History source | Provider source resolver | Locator and source generation; advance on replacement/relocation/rewrite or invalidated cursor assumptions, not every append. |
| Runtime attempt | Runtime registry | One process/service execution with run ID, input authority, cancellation and owned resource set. |
| Project view / pane placement | Renderer/window ownership service | Presentation of catalog members; owns focus/geometry/attachment requests, not native writer custody. |
| Operation receipt | Main operation owner | Intent, canonical target, stages and effect evidence; unresolved effects survive reload/restart. |
| Work request | Main orchestration domain | One assignment/follow-up with delivery/execution evidence and target binding policy. |

A namespace is not a secret or merely an endpoint URL. Resolve it through configured provider state; normalize identity without logging tokens, auth-bearing URLs or full private configuration. Replacing a service connection must not accidentally merge independent native namespaces. Native IDs alone cannot be assumed globally unique across configured homes.

### 3.3 Typed relationships and operation policy

| Relationship | Required meaning | Constraints / operations |
| --- | --- | --- |
| Auxiliary terminal association | Agent-associated shell and explicit close/detach policy | One-level policy remains explicit; not an orchestration tree or shared native context. |
| Orchestration membership | Run, logical member, parent, role, bootstrap submission | Root authoritative in run record; validate project scope, parent existence, cycles and permitted close targets. Cached root index is derived. |
| Native child observation | Native parent/child references plus provider evidence | Observation does not grant app lifecycle authority. Separate promotion/adoption operation required for managed control. |
| Conversation derivation | Immutable source snapshot/anchor, target, operation kind, reports | Historical provenance, not current binding or permission to delete the source/target. |
| Presentation grouping | Related-session selector, lane, pin, displayed target | Input resolves displayed logical session and current binding; PTY size resolves the controlling attachment lease. |
| Workflow origin | Durable logical/project association and native/routing provenance | Pane closure/rewind cannot erase the workflow's independently owned execution/result history. |

| Operation | Logical identity / binding | Relationship and work-request policy |
| --- | --- | --- |
| Hibernate / wake | Same logical and resume binding; run stops or changes | Preserve membership, auxiliary/delegation associations. Wake success is not delivery success. |
| Provider switch | Same logical; new target binding/run | Preserve relationships by explicit allowlist/schema policy. Outstanding requests require reject/cancel/rebind/unknown policy, never synthetic completion. |
| Duplicate | New logical and native identity | Do not inherit active delegation membership, bootstrap-consumed state, credentials or request completion. A new assignment is separate. |
| Rewind in place | Same logical; derived binding/run | Mark old-binding completion evidence as historical; don't erase independently running descendants/workflows. Restore a draft without submitting it. |
| Native context reset | Same logical and potentially same run; new binding | Require adapter evidence of intentional native transition, reset source/mappers/current condition authority; unrelated native events stay quarantined. |
| Move view/window | Same logical/binding/run/project | Transfer presentation/event/attachment authority with acknowledgement; no process duplication. |
| Explicit project merge | Same logical/binding/run; membership moves to target | Reserve all involved scopes, refuse closing/retired targets, validate relationships and requests, persist one graph revision, then reconcile views. |
| Close | Depends on explicit close kind | View close, agent termination, request cancellation and history deletion have distinct contracts; no universal cascading parent rule. |

### 3.4 Canonical target capture and admission

Live transforms accept an application target plus expected lifetime; main derives native provider/reference, configured namespace and execution context. Saved-history transforms accept a native reference and snapshot receipt without requiring a live run. Reject contradictory caller-provided identifiers instead of choosing whichever field happens to form the lock key.

```ts
// PROPOSED contract sketch. Branded names depend on B00's existing-ID audit.
type ContinuationSource =
  | { kind: 'live'; logicalId: LogicalAgentId; expectedBindingRevision: number;
      expectedRunId: SessionRunId | null }
  | { kind: 'saved'; native: NativeConversationReference; snapshot: SourceSnapshotReceipt }

type EffectOutcome<T> =
  | { kind: 'rejected_before_effect'; operationId: OperationId; reason: string }
  | { kind: 'completed'; operationId: OperationId; value: T; evidence: EffectEvidence }
  | { kind: 'outcome_unknown'; operationId: OperationId; receipt: ReceiptReference;
      conflictReservation: ReservationReference }
```

The caller authority is supplied by the authenticated host/window context, not a caller-controlled `callerId` string. Capture the current registration/generation and membership revision, validate input, publish the scoped reservation synchronously, then begin awaits. Revalidate authority where a later action could target a different binding/project; already-issued native effects remain recorded even if authority is subsequently revoked.

Conflict admission is effect-specific. Acquire multi-resource claims in deterministic canonical order or through a single atomic reservation operation; release all if the full set cannot be admitted. Never hold a global queue while waiting for provider readiness, compaction, RPC completion or an editor dialog. Cancellation is an independently admitted intent that immediately revokes future input writes for its target generation, then joins/reconciles owned resources.

| Concurrent operations | Policy |
| --- | --- |
| Two fixed-prefix duplicates | Allowed from validated immutable capture; distinct target identities/publication claims. |
| Source compaction versus latest switch/rewind/close | Conflict on native source/input/custody as relevant; no lock-key alias bypass via saved/live request shapes. |
| History read versus ordinary source append | Allowed with source receipt/cursor validity; harmless append does not invalidate a fixed prefix. |
| Binding activation versus prompt delivery | Conflict on current input owner and expected binding; delayed writes cannot reach successor. |
| Move view versus running native work | Allowed through ownership-transfer protocol; buffered delivery and view acknowledgement remain fenced. |
| Project merge versus close/create/membership mutation | Reserve affected project revisions; reject or reconcile closing scope, no orphan catalog member. |
| Mutation timeout versus same-effect retry | Outcome unknown retains conflict scope until reconciliation; identical request key joins/reads receipt, not a second effect. |
| Cancel versus a long wait | Always record cancellation promptly; report whether any native effect or termination remains uncertain. |

### 3.5 Receipts, persistence and bounded recovery

Record canonical intent before effect. If intent cannot be durably persisted, do not dispatch the effect. Record effect-specific stages rather than one success flag: captured, source-action-authorized, source-effect-observed, target-prepared, target-published/import-uncertain, binding-activated, view-acknowledged, follow-up-complete. An append-only transition history preserves earlier facts even when later work fails. Current projections are derived from that history with schema/version checks.

If a result cannot be persisted after an effect, retain the known effect in the response with a persistence warning where the existing contract permits; do not return a pre-effect failure or authorize retry. Recovery sees the durable intent and reconciles native/lifecycle evidence. Application metadata, native publication and process transitions are not one atomic transaction. A target owned/adopted by another process is not rollback debris.

Initial catalog persistence uses one application-owned writer and a journal/snapshot checkpoint with explicit file and supported directory sync before acknowledging durable domain mutation. Use checksums and sequence continuity to distinguish a valid trailing incomplete append from mid-journal corruption. Unsupported versions enter a read-only/recovery mode. Checkpoint publication retains the prior recoverable generation until the new one is verified; compaction cannot discard unresolved receipts or legacy mappings required to interpret them. Define acknowledged-write loss expectations and inject crashes around each sync/rename before cutover.

Bound receipt payloads using report/artifact references instead of whole transcripts. Completed operation retention and archival have a policy; unresolved effects/custody cannot expire solely by age or memory pressure. If too many unresolved operations accumulate, stop admitting the affected mutation classes and expose inspectable recovery state. That makes the bound honest without manufacturing absence. Sensitive prompt/report content follows explicit retention/redaction rules; diagnostic copies are not the authoritative receipt.

### 3.6 Observation and request identity contracts

Live observations carry application-instance identity, logical/routing identity during migration, run identity, binding revision, relevant source generation, plane and delivery coverage. History replies carry binding/native reference/source generation and request cursor without requiring a runtime. Fields must be useful at the consumer boundary; don't stamp arbitrary IDs into every payload without a rule for advancement and rejection.

Sequence/watermark evidence describes transport delivery, not a universal semantic order across proxy, native history and optimistic UI. Cumulative values can supersede earlier covered ranges; structural start/end/error barriers cannot vanish. Snapshot-subscribe establishes a watermark and buffers/replays newer eligible updates or reports a gap. On overflow, close/resynchronize or expose a bounded gap according to the channel contract; native history cannot reconstruct every terminal screen or transient live observation.

`WorkRequest` captures assignment identity and a target binding. Delivery state (`not_attempted`, `in_flight`, `accepted`, `rejected`, `unknown`) remains independent from execution (`not_observed`, `queued`, `running`, `terminal`, `unknown`). Accepted retains transport versus durable evidence. One assignment may span many native turns; correlation uses provider evidence or remains unknown. A session's latest answer and timestamps are observations, not the authority for a new request's completion. Compatibility wrappers around session-based waits must document degraded certainty until all callers can name requests.

## 4. Execution structure and B00 entry work

The dependency chain is not one enormous implementation PR. Batches identify coherent ownership goals; each can require several focused package/app PRs with its own first plan commit and regression evidence. File extraction comes after a behavior boundary has become testable. The initial facade remains `SessionManager`; constructor injection/small ports prevent the new owners from becoming circular global lookups.

```text
B00 baseline / evidence / contract census
 ├─ B01 inventory + routing   ├─ B02 quit   ├─ B03 OpenCode
 ├─ B04 LSP                  └─ B05 orchestration
 ├─ B06 fidelity → B07 publication/receipts → B08 continuation activation
 ├─ B09 catalog shadow ──(B07 receipt gate)──→ B10 membership ownership
 └─ additive B12/B13 schemas and consumer inventory
 B08 + B10 → B11 stable relationships / WorkRequest → B12 consumer cutover
 B13 package artifacts + correctness oracles → B14 measured optimization
 B15 editor recovery / optional startup isolation can ship independently
```

B01–B05 have no requirement to wait for the new catalog. Repairs touching `src/main/index.ts`, `sessionManager.ts`, provider IPC, renderer session actions or shared contracts need an explicit file owner and serial integration order. Parallel work is appropriate only for disjoint slices with settled contracts; independently editing one coordinator from several worktrees is not a migration strategy.

Before each implementation branch, perform B00 for its scope:

1. Fetch and record the exact current base and all gitlinks. Initialize the required package checkouts and verify their actual repository roots, pinned HEADs and cleanliness. Read root and nested instructions. Do not run repair commands against someone else's dirty package checkout.
2. Reconcile issues/PRs from section 2 against current source. Classify the finding as still present, partially fixed, contradicted, or unverified. Attach exact revision/path evidence to its issue; changed implementation is not a reason to blindly preserve the external review's conclusion.
3. Enumerate existing tests for each scenario family and identify the real public caller/callee boundary. Reuse stronger existing coverage. Add only the missing invariant/interleaving; do not mechanically create one test per row below.
4. Capture baseline commands, environment and relevant failures. A baseline failure needs attribution and its own existing/new issue when meaningful; it is not silently assigned to the new patch. Do not weaken the test or count a reduced model as an application regression.
5. Complete identity/owner census and a mutation inventory: create, close, hibernate, wake, reload, switch, duplicate, rewind, native reset, link, delegate, merge, transfer, restore, imported/dormant sessions and bulk variants. Include user, MCP, external control and remote ingress.
6. Fix shared contract names and map each proposed field to an existing authoritative fact. Move transport-independent spawn/result declarations out of preload into shared domain contracts with compatibility re-exports as needed. This dependency correction does not itself change admission or prove correctness.
7. Record the batch's source owners, acceptance oracles, failure injection points, telemetry, migration gate and rollback boundary before implementation. Tests go beside protected modules; reusable recorded data belongs under `testing/fixtures` with public provenance rules.

B00 exits when a successor can execute the chosen batch from recorded revisions without guessing whether an external claim is current, which writer owns a fact, or whether a passing mocked test covers the disputed boundary. Broad package and performance audits can remain explicit later gates; B00 is not permission to claim the entire suite or all seven packages were verified during this planning turn.

## 5. Reliability repairs (B01–B05)

These batches repair specific ownership failures before moving semantic membership or replacing identifiers. Their entry criterion is B00's reproducible baseline and coverage inventory. The observations below are source-confirmed patterns at that baseline, not reproduced failures in a running application. Each batch must first map its scenarios to existing tests, add only missing behavioral protection, and link the resolving issue and PR under #918. Separate PRs are appropriate where the contracts do not depend on one another; simultaneous changes to application composition, shared routing, or package pins require an explicit integration owner.

The shared rule is that admission, observation, and cleanup must refer to the same lifetime. A missing record does not establish absence of a process; a timed-out promise does not establish absence of an effect; a valid-looking event does not establish authority to adopt its identity. The first release of these fixes must preserve the existing native custody and replacement safeguards. Broader extraction follows demonstrated behavior, with WHY comments at the boundary where an apparently simpler implementation would lose evidence.

### 5.1 B01 — Canonical resource inventory and accountable event routing

**Source and scope.** Startup in [main composition](../../../src/main/index.ts) reads terminal references from the legacy `parsed.workspace.sessions` envelope. The current multi-window format places workspaces under `windows[]`. Address this through the existing tmux recovery issue #898. The [session forwarder](../../../src/main/sessions/forwarder.ts) also needs an explicit unknown-owner policy (#920). These repairs share a principle—unknown ownership must not produce a broader destructive or disclosure action—but should remain separately reviewable changes.

**Resource inventory protocol.** Extract one canonical workspace decoding entry point used by restoration, migration, terminal inventory, and relevant diagnostics. Its result must retain envelope version, accepted records, rejected regions, and completeness evidence. A restoration projection can recover valid windows from a damaged file; cleanup must additionally know that discarded regions could contain surviving resource references. Recovery success for the UI is therefore insufficient authorization for pruning.

Inventory returns one of three meaningful states: complete with references, complete and empty, or incomplete/unknown with recoverable references and reasons. A missing file is also classified explicitly using first-run and recovery evidence; do not infer a genuinely empty prior workspace merely from a read failure. Unsupported future versions, malformed JSON, read errors, and rejected window/session regions must never flow through `?? {}` into an authoritative empty set.

Reconciliation first discovers resources within the application's established managed namespace, then matches exact persisted references, and only then plans actions. An incomplete inventory may recover an explicitly referenced session and report unmatched candidates, but must withhold orphan termination. A complete inventory permits the existing cleanup policy only after checking ownership markers and relevant adoption claims. Decoding does not independently grant process-kill authority. Record the inventory revision/digest and reasons used for the decision so a support report can explain why a resource was preserved or removed without storing terminal contents.

**Routing protocol.** Remove broadcast as the fallback for an unowned session. Resolve a current registered owner and renderer generation before delivery. During a recognized transfer, retain a bounded queue associated with the transfer/ownership generation; complete handoff by installing the successor owner and a snapshot or replay boundary. Recheck buffered envelopes at flush because a correct owner at enqueue time can become stale. Without a recognized transition, quarantine bounded metadata, request ownership repair, and record a rate-limited incident. Do not route to the focused window or infer ownership from matching directories.

Different payload classes require different overflow behavior. Reconstructible observations can discard obsolete buffered values and demand resynchronization. Request responses and ownership-changing events must settle through their operation records or return a typed uncertainty/error; they cannot disappear into the same lossy buffer. Bound pending payload bytes, item count, and retention time. Neither logging nor quarantine becomes an unlimited second transcript store.

**Gate and rollback.** Ship once canonical decoding gives restoration and cleanup compatible answers for legacy, v2, damaged, and future-version fixtures, and routing tests prove no unrelated window receives a session payload. Rollback may disable orphan cleanup or retain sessions in quarantine. It must not reinstate unknown-as-empty inventory or unknown-owner broadcast to restore apparent functionality.

### 5.2 B02 — Reversible quit preparation and committed shutdown

**Source and scope.** [Main composition](../../../src/main/index.ts) stops workflows and disposes services from `before-quit`, while [SessionShutdownGate](../../../src/main/sessionShutdownGate.ts) correctly delays permanent session teardown until unload vetoes have passed. Issue #919 tracks the composition repair. Preserve that gate's one-way shutdown fact and exact teardown-promise ownership while extending the contract to the application. A unit test of the gate alone cannot detect early disposal elsewhere.

**First repair.** Route irreversible application disposals through one committed-shutdown coordinator and hold Electron's exit gate until required work settles. Enumerate service owners and classify each action as reversible preparation, required committed drain, best-effort diagnostic flush, or final synchronous release. Move workflow cancellation, MCP/remote/LSP teardown, dictation teardown, and other irreversible actions out of the vetoable phase. Flushing a coalescer during preparation remains permissible only because it does not revoke a surviving application's capabilities. Update comments that assume “one tick” provides durability; elapsed opportunity is not a completion receipt.

**Preparation protocol.** A quit attempt receives a generation. Capture participating windows, editor buffer revisions, and renderer generations, then collect close decisions through the established editor UX. Any temporary restriction on new conflicting work must be reversible and scoped to this attempt; background execution must not be cancelled while the user considers Keep Editing. Renderer navigation invalidates that renderer's vote. A new dirty revision after an earlier approval invalidates approval for that buffer, including edits delivered while another window's dialog remains open.

Before crossing the commit boundary, revalidate the participant set and dirty-buffer evidence. If edits can race this final validation, use a short coordinated admission barrier to establish a stable revision frontier; do not hold a permanent application shutdown fence while awaiting human decisions. A veto releases preparation reservations, resets transient quitting state, and leaves existing service owners usable. Closing the last window on macOS remains a presentation operation under the existing lifecycle; it does not become implicit cancellation of all work.

**Commit protocol.** Publish committed shutdown synchronously before the first destructive await. All new conflicting session/workflow admission now fails with a specific shutting-down outcome, and repeated quit events join the same attempt. Drain owners in a reviewed dependency order: stop execution producers while retaining services needed to establish stop evidence, settle owned resources, flush required stores and receipts, dispose remaining support services, then release the process lock and mark the run clean. Parallel drains are allowed only where neither depends on the other's services or final records. Clean shutdown must reflect completion of required drains, not simply entry into `will-quit`.

A rejected stop or uncertain native release leaves the application in committed shutdown with inspection and retry facilities, not restored to ordinary operation. Retain the ownership record, distinguish successful drains from outstanding ones, and retry only unresolved work. Retrying must not double-close resources or recreate already stopped providers. A diagnostic flush may fail without pretending a required workflow journal or dictation-history write succeeded; document which guarantees determine whether exit remains blocked. Force termination remains outside the ordinary clean-quit guarantee.

**Gate and rollback.** Require application-composition tests with actual coordinator wiring, a renderer veto, and observable service operations before and after cancellation. Exercise multi-window revision changes and required-drain failures. The small fix can ship before the richer revision-ticket protocol if it proves no irreversible work precedes veto resolution and explicitly records the remaining approval-revalidation gap. A rollback must retain the delayed-disposal safety boundary; reverting only UI preparation refinements is safer than reintroducing partial dismantling.

### 5.3 B03 — OpenCode identity, connection, and resource lifetimes

**Source and scope.** The structured package at [`4f2ef5de…`](https://github.com/Juliusolsson05/opencode-headless/tree/4f2ef5de7c80ad7a6199dc09869ea3b728752f0e) contains the reviewed wrapper, dispatcher, SSE transport, and spawned-server boundaries. Package issues `opencode-headless#10`, `#11`, `#12`, and `#13` track binding, reconnect timers, lifecycle, and ingress respectively. The newly pinned OpenCode terminal package is a separate runtime and requires its own B00 census. A fix verified in structured OpenCode must not be advertised as covering terminal mode. Keep package implementation commits and host gitlink adoption separate, with compatibility and consuming tests for each changed public contract.

**Binding first.** Make create/resume/explicit bind the only operations that choose the native conversation. Obtain the selected ID from the corresponding operation response and namespace, then publish the binding under its lifecycle generation. An incoming `session.created` or `session.updated` event must be classified before any session-scoped field changes; it cannot call a setter that changes the filter's target. Current-conversation observations feed the selected conversation. Known native children feed distinct observational records without acquiring input, permission, resume, or termination authority. Foreign events are ignored or retained only in explicitly scoped diagnostics. Connection-level events affect transport health.

While create/resume is unresolved, buffer bounded identity-bearing evidence under that exact operation, then classify it after the authoritative response. The first plausible event is not a selection rule. A lost create response remains an uncertain create operation requiring reconciliation, not permission to adopt an arbitrary observed child. Raw bus diagnostics may expose broader events to an authorized diagnostic consumer, but must never determine command defaults or offered condition targets.

**Reconnect and start/stop generations.** Replace the enormous-delay sentinel with an explicit disabled policy that exits the reconnect path without scheduling a timer. Enabled retry values must be finite, nonnegative, within the runtime's timer range, and governed by bounded backoff and abortable waits. Classify retryable transport errors separately from terminal authentication/configuration failures; do not spin indefinitely because all failures share a catch branch.

The local Node v24.14.1 probe scheduled `Number.MAX_SAFE_INTEGER`, observed an internal delay of 1 ms, and emitted `TimeoutOverflowWarning`. This verifies the timer primitive; it is not a package reconnect or application test.

Each start owns an abort signal, generation, subscriptions, transport loop, spawned process, and late-acquisition cleanup. Stop invalidates that generation before awaiting preparation. Every continuation after an await checks whether its owner is still current; a resource acquired late is disposed by the old owner rather than installed into its successor. A new SSE loop cannot revive an old sleeping loop through a shared `running` boolean. Switching conversation within a transport, where supported, changes binding identity independently from the transport generation.

**Termination protocol.** The deadline begins before graceful HTTP disposal. Observe process exit before issuing signals, bound disposal, then attempt SIGTERM and SIGKILL with observed-exit waits under the remaining policy. Distinguish an absent/not-started process, confirmed exit, and termination unconfirmed. Sending SIGKILL is an action receipt, not exit evidence. Preserve ownership if exit cannot be established, including the exact process/start identity needed to avoid confusing a reused PID. The host adapts this result into existing custody guarantees; it must not discard a record merely because the package stop promise settled. Shared or externally supplied servers must never be killed as though this wrapper spawned them.

HTTP deadlines are operation-specific. Disposal and metadata reads can have bounded waits without implying a timed-out prompt or import is safe to repeat. Abort transport work when possible, but retain effect uncertainty separately. Test hanging disposal and late response paths through the real transport seam rather than a mocked instantly resolving stop method.

**Ingress bounds.** Add budgets before semantic accumulation: pending wire bytes, decoded frame size, queued frames, HTTP success/error bodies, stderr tail, semantic state, and outbound backlog. Choose limits from supported fixtures and measured large-history needs; record units explicitly. A bounded incremental SSE framer retains scan position, handles delimiter and UTF-8 splits, and yields processing after a work budget when a chunk contains many events. Oversize input produces a typed incident and defined reconnect/resynchronization outcome, never a silently truncated valid-looking message. Reconnect reports observation gaps unless native replay evidence establishes continuity.

**Gate and rollback.** Require public-wrapper identity tests, transport/process lifecycle tests, and a real Node timer-range check in addition to fake timers. Built package exports must carry compatible outcomes before the host adopts them. Roll back the host integration and package pin as a compatible pair only while preserving native ownership records; do not erase uncertain processes or bindings to make an older interface appear usable.

### 5.4 B04 — One LSP document lifecycle across IPC and synchronization

**Source and scope.** [LSP IPC](../../../src/main/ipc/lsp.ts) serializes open/close but permits change to bypass authorization-pending open. [LspManager](../../../src/main/lspManager.ts) protects the server registry by instance while removing documents by reusable server key, and captures completion versions before draft restoration can advance them. Issues #921–#924 separately track cleanup, admission, completion tickets, and obsolete reads. Repair these composed boundaries while preserving aliases, per-file shared documents, draft restoration, reference counting, and stale-result rejection.

**Admission and cleanup.** Introduce an explicit client-document lifecycle associated with renderer generation, authorization evidence, mount identity, and latest admitted buffer revision. Claim it synchronously before asynchronous authorization. Open, change, close, and feature-request admission join the same lifecycle ordering. A change admitted during authorization is retained under a content-byte budget or queued behind open; authorization failure discards it with a clear result. Navigation invalidates that owner immediately, and late authorization cannot install a document for the replacement renderer. Merely finding the same client URI is insufficient proof of the same mount.

Give each language-server process an exact run owner. Client documents, shared server documents, diagnostics, queued synchronization, and request tickets refer to that owner. Delayed old-server cleanup always disposes the old connection/resources but removes shared map entries only if they still belong to that owner. Do not add an early return that avoids successor deletion by leaking the old process. Failed initialization, explicit disposal, stream failure, and process exit must converge on idempotent owner cleanup.

**Synchronization and publication.** Keep client buffer revision separate from protocol document version. While holding the existing shared-document synchronization boundary, restore the requesting alias's draft, await required initialization/synchronization, then capture an immutable request ticket at dispatch. It identifies server run, shared-document identity/version, client mount/buffer revision, and intent epoch. Return or retain this ticket with the result. Completion publication and completion-resolution handles validate it against current ownership and intent. Internal synchronization that the request itself required must not invalidate an otherwise current result; actual later edits, alias changes that supersede authority, or server replacement still must.

**Cancellation without queue starvation.** A newer intent can cancel and locally abandon an obsolete read instead of waiting for the full timeout. Preserve ordered writes and exclusive draft synchronization, but release a stale read's local wait once its publication authority is revoked. Cancellation is advisory to the server; late responses remain associated with immutable tickets and cannot recreate completion handles. Bound outstanding abandoned RPCs and their retained data, remove settled transport bookkeeping, and mark or restart an unhealthy server when it repeatedly ignores cancellation. A queue release is not a claim that remote computation ended.

Keep responsibilities narrow: an internal document coordinator can own admission and tickets while the pool owns process initialization and RPC transport. Preserve the existing manager facade during extraction. Reuse the established authorization checks; moving ownership into the coordinator must not let it authorize arbitrary files or permit a new renderer generation to reuse old grants.

**Gate and rollback.** Tests must enter through real IPC handlers and exercise manager synchronization with a controllable server transport. A completion test that mocks `sendDocRequest` cannot prove post-sync ticket correctness. Prove successor documents survive old exits, authorized latest text reaches the server, valid results publish, and stale work remains bounded. Roll back coordinator extraction separately from behavior fixes; do not restore reusable-key deletion or remove stale checks as a latency workaround.

### 5.5 B05 — Orchestration reads and mutations retain distinct lifetimes

**Source and scope.** [OrchestrationBridge](../../../src/main/orchestration/OrchestrationBridge.ts) applies freshness expiration to promises at creation and releases the global dispatch slot when a renderer response times out. Issues #925 and #926 track pending-read deduplication and mutation uncertainty. Split the read optimization from mutation correctness so deduplication can ship promptly without claiming it resolves ambiguous effects. Preserve current exact-parent/window authorization until B10 establishes main-owned membership.

**Read protocol.** Maintain `inFlightByKey` until settlement or explicit generation invalidation, and `freshValuesByKey` only for settled results. Start freshness TTL at completion. Keys include canonical request parameters, output caps, caller/scope authority, project membership generation, and renderer ownership generation as relevant. Equivalent authorized polls join one admitted read even if it waits longer than several freshness periods. Invalidating a scope prevents new callers joining stale work; a late old result cannot repopulate the new cache. Decide explicitly whether existing callers receive captured-generation results or a stale outcome.

Bound admissions by queued count, estimated retained bytes, and admission deadline. Expired-before-dispatch reads return without contacting a renderer. Record queue age separately from service time, deduplication ratio, pending keys, and observed request volume. Do not retain large result promises indefinitely after settlement. Per-window scheduling can allow independent owners to progress, but increased concurrency is a separate measured change, not a substitute for deduplication or correct mutation reservations.

**Mutation protocol.** Carry one operation ID, caller registration, target scope, and owner generation from admission through dispatch, response, and reconciliation. Reuse existing control-layer receipts, idempotency, and uncertainty semantics where applicable. Distinguish expired before dispatch, rejected without effect, completed with evidence, and outcome unknown after dispatch. Response timeout ends the caller's wait; it does not release a conflict reservation protecting a still-running renderer mutation.

A scoped reservation survives until recorded completion, evidence of no effect, or an explicit generation-retirement/recovery decision establishes the next safe action. Retiring a renderer prevents future authority from that generation but does not undo a backend creation it already initiated. Reconcile through an operation receipt and authoritative state evidence, or retain unknown if the present architecture cannot establish the result. Never blindly repeat create to recover a missing response. This bridge must reference existing native/session operation evidence rather than invent another source of process custody truth.

Revalidate caller registration and target generation before effects and before admitting a returned mutation result. Unrelated projects remain available while one scope is unresolved. A late result can settle its original operation and release its reservation only if its identity and effect evidence match; it cannot become the answer to a successor request. Queue disposal, navigation, parent closure, and transfer settle waiting callers explicitly and leave durable or owner-retained uncertainty records where effects may outlive the waiter.

**Gate and rollback.** Prove polling through the real cache-plus-queue composition produces one pending operation per valid key and bounded retained state. Prove a timed-out mutation followed by a conflicting request cannot create overlapping effects, while another project's operation progresses. Existing timestamp-based completion remains a documented interim behavior until B11 introduces WorkRequest; do not equate improved status caching with assignment correlation. Rollback may remove freshness caching or reduce concurrency; it must preserve ambiguous-mutation reservations and established outcomes.

### 5.6 Required reliability scenarios and release evidence

These IDs identify required behaviors, not a mandated count of new tests. B00 maps stronger existing coverage; implementation PRs record the added boundary, actual commands/results, and any remaining native-only verification. Deterministic scheduling hooks should expose the relevant await boundaries without copying production logic into a reduced model.

| ID | Adverse sequence and required observation |
| --- | --- |
| R01 | Restore a normal v2 multi-window file with surviving tmux sessions; inventory finds every valid reference and preserves those sessions. |
| R02 | Decode valid legacy and complete-empty fixtures; migration preserves references and empty remains explicitly complete. |
| R03 | Malformed, unreadable, or future-version workspace data yields unknown inventory and no orphan termination. |
| R04 | Reject one invalid window while restoring another; retain discovered references and withhold destructive global pruning. |
| R05 | Emit a session event without an owner; no unrelated window receives content and a bounded repair incident is recorded. |
| R06 | Transfer ownership while events are buffered; only the successor generation receives current eligible events, with an explicit replay/snapshot boundary. |
| R07 | Overflow an ownership queue and race tmux adoption with reconciliation; resynchronization and custody checks prevent silent loss or wrong-owner cleanup. |
| R08 | Run workflow/MCP/LSP activity, dirty a file, quit, then Keep Editing; each service still accepts a valid subsequent operation. |
| R09 | One window approves, then its buffer changes while another decides; stale approval cannot authorize final closure. |
| R10 | Repeated quit events during drain join one committed attempt and do not double-stop resource owners. |
| R11 | A required drain rejects or reports uncertain termination; no clean marker/lock release occurs and retry retains unresolved ownership. |
| R12 | Last-window close on macOS and quit during partial startup follow their distinct contracts without premature teardown or invented waits. |
| R13 | Required persistence remains pending while diagnostics finish; exit awaits the required receipt and reports its failure honestly. |
| R14 | Bind structured OpenCode to A, inject supported child-B session updates through the public wrapper, then A/B messages; identity, conditions, and command defaults remain A. |
| R15 | Receive foreign events before create/resume resolves; selection follows the operation response, with bounded pending evidence and no first-event adoption. |
| R16 | Disable reconnect and induce disconnect; no retry timer is scheduled, including in a real Node runtime. |
| R17 | Stop during preparation/history and acquire resources late; the invalidated start cleans them and never publishes a live successor binding. |
| R18 | Start a new SSE generation while an old retry sleeps; waking the old loop creates no connection or observations. |
| R19 | Hang HTTP disposal, then delay process exit; deadline covers disposal/signals and returns observed exit or retained uncertainty. |
| R20 | Split oversized SSE frames/UTF-8 across chunks and flood stderr/error bodies; ingress bounds hold and gaps/errors remain explicit. |
| R21 | Replace an LSP server, open successor documents, then deliver old exit/initialize failure; old resources close and successor state survives. |
| R22 | Admit change while open awaits authorization; the server receives the latest authorized text in lifecycle order. |
| R23 | Navigate or close during authorization, including URI reuse; late completion cannot install a document for the retired mount. |
| R24 | Request completion from an inactive alias requiring draft restoration; its valid post-sync result and resolve handles are accepted. |
| R25 | Edit or replace server after request dispatch; late completion/resolve cannot publish into the newer document lifetime. |
| R26 | Server ignores cancellation while newer edits arrive; synchronization proceeds under policy and abandoned RPC retention stays bounded. |
| R27 | Race aliases, final-reference close, and delayed diagnostics; reference counts, active drafts, and run-specific cleanup remain correct. |
| R28 | Poll identical status keys beyond several TTL intervals while dispatch stalls; exactly one current-generation read remains in flight. |
| R29 | Complete a delayed read; freshness starts at completion, expires normally, and retained results respect count/byte caps. |
| R30 | Invalidate membership or owner generation before a read settles; new callers avoid the old promise and its result cannot refill the new cache. |
| R31 | Queue work beyond admission deadline or budget; it is rejected before dispatch with no implied renderer effect. |
| R32 | Time out child creation, then submit a conflicting mutation; the reservation persists and duplicate creation is not automatically admitted. |
| R33 | Leave one project mutation uncertain while another window/project submits independent work; the unrelated scope progresses. |
| R34 | Receive a late matching mutation receipt after timeout; settle the original operation exactly once without answering a successor request. |
| R35 | Reload/transfer/close the parent after dispatch with a backend effect already started; reconcile evidence or retain uncertainty without treating renderer retirement as rollback. |

Each batch is complete only when its composed tests pass, cleanup/accountability records remain bounded, package/host compatibility is verified where relevant, and the PR states which native behaviors were actually exercised. No isolated counterexample, fake-clock result, or source inspection alone counts as application integration evidence.

## 6. Conversation continuation (B06–B08)

### 6.1. Outcome and ownership

Switch, duplicate, and rewind must describe complete operations whose source, native effects, fidelity, activation, and recovery remain identifiable. The baseline locally confirms that transformation paths consume `projection.values` without returning `projection.report`, that the switch helper reports `switched` after target publication, and that Claude/Codex helpers write directly to discoverable final filenames. These are source-confirmed integration patterns; this plan does not claim a reproduced native failure. Relevant entry points are [switchProvider](../../../src/main/providerSwitch/switchProvider.ts), [duplicateSession](../../../src/main/providerSwitch/duplicateSession.ts), [rewindSession](../../../src/main/providerSwitch/rewindSession.ts), [native writers](../../../src/main/providerSwitch/shared.ts), and [provider IPC](../../../src/main/ipc/provider.ts).

The required user outcome is precise: an independently runnable continuation can be prepared, its information changes can be inspected, and its activation can be recovered after a renderer failure. A prepared continuation does not imply an active replacement; an active replacement does not imply that its pane has rendered. Source compaction, if requested, is a separate native effect that can succeed even when later projection fails. Arrival compaction is subsequent work and cannot retroactively turn successful activation into a failed switch.

Main owns canonical target resolution, admission, operation receipts, publication, and activation coordination. The parser owns interpretation and pure projection rules. Provider adapters own native publication/import details and evidence. Session lifecycle retains execution and native custody authority. Renderer owns user intent, previews, draft editing, and presentation acknowledgement. Existing replacement routing IDs remain in use during these batches; neither `agentNameId` nor a new logical ID is substituted here. B11 performs that migration only after its identity audit and membership prerequisites.

One operation ID crosses these boundaries. An append-only operation history records decisions and evidence; its current summary is a projection of that history. It references the existing [Codex replacement ledger](../../../src/main/sessions/codexReplacementLedger.ts) when custody transfer applies. There must never be two records that independently decide whether an old writer relinquished ownership. The continuation record explains the larger operation; the native ledger remains authoritative for its narrower, harder custody guarantee.

### 6.2. B06: retain fidelity and make stage outcomes explicit

**Entry criteria:** B00 has identified every switch, duplicate, rewind, prompt-picker, and arrival-compaction caller, including saved-history actions and OpenCode Terminal. Capture representative existing result payloads and map current tests before editing them. The first PR changes reporting contracts and propagates evidence without changing process replacement policy or stable identity. Track fidelity in #927, attachment restoration in #929, and literal-markup provenance in #930.

Introduce transport-independent result contracts in shared code, consumed by main, preload, renderer, and any remote/control caller. Proposed names such as `continuation_prepared`, `binding_activated`, and `presentation_pending` describe distinct achievements; they are design vocabulary, not existing exports. Compatibility adapters may translate old payloads while callers migrate, but must not synthesize activation proof from artifact existence. An old success toast must be changed with its caller so it cannot overstate the new contract.

Retain three independently versioned reports:

| Report | Required meaning | Reporting constraint |
| --- | --- | --- |
| Context reduction | Content removed, summarized, or shortened to satisfy target planning policy | Retain estimate method and unresolved capacity assumptions; successful fitting is not proof of native acceptance |
| Native projection | Preservation, loss, demotion, repair, and identity rewriting produced by the real projector | Preserve source addresses and profile/version evidence; same-provider duplicate can still be lossy |
| Draft restoration | Text, attachments, mode, and metadata recovered from the removed prompt | Explicitly distinguish restored, unavailable, unsupported, and ambiguous content |

Copy reports into the immutable preparation receipt before mutable adapter objects can be reused. Large detailed reports may live in a separately checksummed artifact referenced by the receipt, with bounded inline summaries. A missing detailed artifact is an explicit evidence gap; shortening the UI summary must not silently delete the underlying fidelity record. Logs contain operation IDs and safe summaries, not entire prompts, native configuration secrets, or attachment contents.

The UI explains duplicate as creating an independent runnable continuation. It presents material loss before user-dependent activation when current product policy requires a decision, and retains inspection afterward. This does not create a new approval dialog for every switch: existing authorized choices continue automatically when their declared loss policy is satisfied. Unsupported or newly material loss must produce an actionable result rather than an unqualified success. Do not overload a single severity flag: an identity rewrite expected for duplication differs from losing an image or unsupported reasoning/tool structure.

Draft restoration becomes structured. Keep recoverable prose, input-mode evidence, attachment descriptors, source addresses, and unresolved items together. An image-only prompt remains selectable even when no textual preview exists. Preview labels summarize attachment presence; selection resolves the full recoverable draft. A filesystem path is a locator, not proof that today's bytes are the original attachment. Restore exact retained bytes only when provenance and retention permit it; otherwise retain the unavailable reference and explain the omission.

The baseline [transcript engine](../../../src/main/providerSwitch/transcriptEngine.ts) has text-only draft paths and a Claude helper that interprets recognized tags. The helper-level counterexample is conditional; full decoder reachability remains unproven. Replace that ambiguity through decoder provenance: provider-authored wrapper metadata may establish mode, while literal user prose containing `<bash-input>` remains prose. If provenance cannot decide, preserve text and report ambiguity. Never silently turn a historical explanation containing shell markup into executable input. This rule belongs in the common draft projection contract, with provider-specific evidence producers.

Move native-resume validity protection into the parser's universal projection entry point once package work is authorized. The host's rejected-compaction guard should retain useful contextual errors, but duplicate and rewind must receive the same protection as switch. Start with the parser pinned at `9c99db00f9cf0097c87271d04fd3e3ebf9f1e894`; prove the package change in its own repository before updating the application gitlink. Do not assume a shared adapter signature gives Codex/OpenCode the same API-error classification as Claude.

**Exit gate:** composed decoder/projector tests demonstrate report preservation through each actual caller, literal-markup preservation, image-only selection, and stage-accurate results. Tests must include real projection reports; a mock returning only `values` cannot establish this contract. B06 can ship without B07 by honestly reporting current publication limitations. Rollback can hide new presentation, but cannot discard receipts or revert to success wording that asserts unproven activation.

### 6.3. B07: publish native targets with recoverable evidence

**Entry criteria:** B06 reporting is available and the versioned journal/snapshot contract has an explicit fsync policy, integrity checks, recovery reader, and one serialized writer. Track native publication in #928. Choose the acknowledgement strength required before each effect. If durable intent is required and cannot be recorded, fail before publishing; best-effort logging does not meet that gate.

Before the first native effect, persist an operation identity, intended target identity and namespace, source receipt, effect kind, and recovery strategy. Then prepare provider-specific publication. A file-backed target and an OpenCode import are different effects and need separate recovery evidence. The receipt records effect attempts and observations without treating absence of a final acknowledgement as evidence that nothing happened.

For Claude/Codex JSONL, prepare complete encoded bytes in a same-filesystem staging location excluded from native discovery. Validate the whole projection, target native identity, and intended provider namespace before publication. Establish restrictive creation permissions and use the repository's audited filesystem primitives where their actual guarantees fit. A random temporary filename inside a directory scanned for all JSONL files is insufficient isolation. The adapter must document why its staging location is invisible to that provider's discovery.

Publish without replacing an unrelated existing target. Use a verified atomic no-replace primitive supported on the deployment filesystem; ordinary rename-with-overwrite is not acceptable. A link-based strategy may be suitable for local filesystems, but implementation must verify its semantics, staging cleanup, and platform support rather than copy that suggestion mechanically. Flush file contents and directory metadata according to the selected durability contract, then record publication evidence. If the platform cannot meet required semantics, return a supported degraded outcome or refuse that publication mode; do not silently weaken the guarantee.

Publication evidence includes the intended native reference, byte digest/length, artifact identity where available, and the exact phase acknowledged. Readback establishes application encoding/publication integrity, not native resumability. Once activation or another native adopter may have appended to the target, its content fingerprint can legitimately change. Recovery must then consult adoption and custody evidence; it cannot classify a changed digest as an unrelated file and overwrite it.

OpenCode import uses native API semantics. Retain an exact returned native identity and available import correlation evidence. Before retrying after a lost response, reconcile the originally intended target using native capabilities. Where the API cannot establish correlation, retain `effect_unknown` and require an explicit recovery decision; listing similarly named conversations is not identity proof. Structured OpenCode and OpenCode Terminal must each demonstrate how they resolve namespace, import identity, and resume compatibility. Their sharing of a native format does not prove identical execution or adoption behavior.

Cleanup has a narrower authority than publication. A never-published staging artifact can be removed when its operation ownership is proven. A published target can be deleted only when the operation still has exclusive cleanup authority and can establish that no other actor adopted it. Cancellation, age, or a missing renderer acknowledgement is insufficient. Bound storage with retention policies and pressure admission; never reclaim unresolved ownership evidence merely to satisfy a cache limit.

**Ordered PR work:** first introduce receipts and recovery inspection without changing writers; next migrate one file-backed writer and its readback/failure-injection fixtures; then migrate the other and OpenCode import; finally remove direct final-file publication paths. Keep each provider's old and new path mutually exclusive for a given operation ID. B07 completion requires crash-boundary coverage around every publication transition, including persistence failure after the native effect.

### 6.4. Operation transitions and restart behavior

The following is a proposed durable protocol. Stage advancement records evidence; failure is not represented by erasing earlier stages. Cancellation revokes permission for future effects, while cleanup/reconciliation can continue under the admitted operation's ownership. Caller authorization is checked at admission and again before privileged commits; losing a renderer does not authorize an arbitrary replacement renderer to adopt the operation.

| Durable state/evidence | Next permitted action | Failure or restart behavior |
| --- | --- | --- |
| Admitted intent | Resolve/capture authorized source and configuration | No native effect yet; expire safely if its preconditions no longer hold |
| Captured source and resolved plan | Project, or admit declared source compaction | Revalidate the source policy; never substitute a newly discovered conversation |
| Source effect dispatched | Await correlated acceptance and source outcome | Preserve unknown delivery/execution; never blindly send compaction again |
| Source effect confirmed | Recapture required post-effect source and replan | Later failure reports that source context already changed |
| Projection prepared | Stage/publish using frozen target configuration | Pure preparation can be recomputed only against the same validated snapshot |
| Publication intent recorded | Perform native publication/import once under its receipt | Recover interrupted publication by exact identity and effect evidence |
| Target published | Activate after renewed source/configuration/custody checks | Keep a discoverable prepared continuation if activation cannot proceed |
| Activation pending | Join the existing lifecycle/custody transaction | Do not route a second writer while termination or transfer remains uncertain |
| Binding activated | Publish authoritative projection and request presentation | Renderer reload reconstructs presentation; it cannot undo activation |
| Presentation acknowledged | Finish required receipt persistence and optional follow-up | Arrival compaction has its own outcome; preserve original activation success |

The journal reader validates schema, checksums, sequence continuity, and snapshot agreement before recovery effects. Corrupt, future, or partial state does not become “no operations.” Retain inspection and inhibit dependent mutation until the relevant operation can be classified. Replaying metadata projection is safe only for deterministic records; replaying process, import, compaction, or publication effects requires their specific admission/reconciliation protocol.

Maintain an operation-scoped conflict reservation through effect uncertainty. Its caller-facing wait may end without releasing the reservation that protects native ownership. Reconciliation can complete, reject, or retain uncertainty; it cannot manufacture rollback because the user closed a dialog. Reservations remain scoped to the canonical agent/binding and affected native targets so an unresolved operation does not block unrelated projects. Interrupt/cancel remains admissible while a long source action waits.

### 6.5. B08: canonical sources, snapshot policies, and configuration

**Entry criteria:** B07 can retain prepared targets and reconcile publication, and existing replacement tests remain authoritative. B08 replaces overlapping request fields with explicit live-agent and saved-native-source variants. For live sources, the caller supplies its application session reference and expected run/binding revision; main derives provider, namespace, native identity, working directory, and current input owner. Reject contradictory or stale requests instead of accepting a supplied native ID unrelated to the admitted session. Saved sources carry an exact native reference and selected snapshot identity and do not require a running backend.

Resolve once, classify effects, and reserve only conflicting resources. Independent duplicates from the same immutable prefix may run concurrently. Source compaction, latest-context replacement, close, hibernate, and binding replacement need a shared conflict policy. Avoid a global session mutex: readiness waits must not hold cancellation or unrelated history reads hostage. Window transfer is presentation ownership and must not redirect the source to a different agent.

Give capture three distinct contracts:

| Policy | Required evidence | Revalidation boundary |
| --- | --- | --- |
| Fixed-prefix duplicate | Native namespace/identity, source generation, valid record cutoff, retained-prefix evidence | Appends after the cutoff are acceptable; changed retained bytes or source identity are not |
| Latest-context switch | Binding revision, source generation, settled native boundary and admitted input/cutover policy | Prevent omission of an ongoing native turn; revalidate immediately before activation |
| Rewind before prompt | Exact native prompt address, retained-prefix evidence, draft provenance | Validate the selected prompt and retained prefix; unrelated suffix growth need not invalidate it |

`readStableTranscript` handling a partial final JSONL record remains useful within capture. It is not by itself a settlement protocol. Blocking new application input does not stop a native turn already writing, native queued input, or external activity. A provider must establish the requested boundary, or the operation must explicitly offer a fixed-snapshot policy; an adapter cannot claim “latest” from one successful file read.

Binding epoch changes when the application adopts another conversation/context, including `/clear` without a PTY restart. Source generation changes when locator/source replacement invalidates history or capture evidence; ordinary append does not automatically mean a new binding. History, compaction, and transformations consume the same authoritative source-resolution contract. A readable old path is not evidence that it remains active. Compare native identity, source generation, and relevant prefix evidence; avoid relying solely on pathname, modification time, or newest-file heuristics. Preserve dormant-history access without inventing a live run.

Resolve target configuration once into the operation: provider/runtime flavor, configured namespace, destination cwd, model/provider selection, native compatibility profile, capacity estimate with its source, and a safe launch-configuration fingerprint. Do not persist credentials in that fingerprint or receipt. Distinguish requested, resolved, and observed settings. Projection and capacity planning use the same resolved profile. If settings change before activation, either prove compatibility or invalidate preparation and replan; do not silently launch a prepared artifact under different assumptions. Estimated context capacity remains an estimate until native behavior supplies stronger evidence.

### 6.6. Activation, source effects, and bounded preparation

Activation joins existing lifecycle and native replacement coordination. Its commit revalidates the operation target, binding/source policy, caller authority, resolved launch configuration, and custody outcome. Main then publishes the active binding and corresponding operation evidence under the selected metadata transaction contract. The renderer subsequently replaces presentation. A lost presentation acknowledgement must leave a recoverable active session, not trigger another transform. Existing compensation/redirect entries remain until their lifecycle rules prove they can be retired.

Provider switch and in-place rewind preserve the logical-agent policy established by the identity audit; duplicate creates independent logical/native identity and never copies bootstrap consumption, request completion, credentials, or orchestration ownership accidentally. During B08, use existing identities and explicit migration adapters; B11 installs durable relationship semantics. Link outstanding failures to #879, #894, #895, and #896 where their acceptance criteria overlap. Completed descendants/workflows cannot be erased merely because the originating conversation was rewound.

Source compaction and portable-summary delivery need their own correlated evidence within the parent operation. Retain delivery acceptance strength and execution outcome separately; a transport timeout does not authorize resubmission. A source limit/error classification prevents activation only when its evidence is attributable to this source action. Arrival compaction starts from the activated binding and has a distinct cancellation/result record.

The [compaction implementation](../../../src/main/providerSwitch/compactBeforeSwitch.ts) documents caller retention of `plan.conversation`. Replace plans requiring native waits with small action instructions holding source receipts, baseline evidence, and target constraints. Release decoded graphs from every owner before the wait, then capture post-effect context because the old graph cannot represent the result. This is a scope/lifetime change, not an assumption that assigning one local variable to `null` guarantees collection.

Split bounded prompt preview discovery from full selected-draft resolution. Push count and byte budgets into adapters before decoding/indexing all candidates where native access permits. For unavoidable whole-export APIs, state that limit and avoid additional duplicated decoding. Pure conversation reads should not eagerly build prompt indexes unless the caller requests them or a validated reusable index exists. Worker execution remains B14 measurement-gated; B08 defines cancellable snapshot/artifact ownership so a future worker cannot duplicate effects or retain entire conversations after abandonment.

### 6.7. Regression matrix and acceptance gates

Each scenario below is proposed application/package coverage, not an executed test. Reuse stronger existing cases and add only the missing composed boundary. Run fixtures through real decoders/projectors, temporary provider stores or controlled import transport, operation receipts, and lifecycle adoption. Native resume probes are a separate opt-in lane associated with #833; successful encode/readback alone cannot pass that gate.

| ID | Adverse sequence | Required observation |
| --- | --- | --- |
| C01 | Cross-provider projection repairs/drops unsupported content | Exact fidelity report survives preparation, IPC, and UI inspection |
| C02 | Same-provider duplicate rewrites identities and demotes native details | New native/logical identity; report never claims an exact archive clone |
| C03 | Context reduction succeeds while native projection loses an attachment | Independent reports preserve both outcomes |
| C04 | Image-only historical prompt enters the rewind picker | Selectable preview and explicit attachment restoration status |
| C05 | User prose contains a literal `<bash-input>` wrapper | Text preserved; no inferred executable mode |
| C06 | Provider-authored mode metadata has exact provenance | Supported mode restored with source evidence |
| C07 | Historical attachment path now names changed bytes | No silent substitution of current content |
| C08 | Rejected compaction carrier reaches duplicate or rewind | Universal projector guard applies through every entry point |
| C09 | Process stops midway through staging | No incomplete discoverable target; owned staging remains classifiable |
| C10 | Intended native filename already belongs to another target | No-clobber failure preserves the existing target |
| C11 | Publication completes before receipt persistence fails | Recovery identifies the exact published target without repetition |
| C12 | Native adopter appends before recovery inspects target | Changed bytes do not authorize overwrite or deletion |
| C13 | OpenCode import succeeds but response is lost | Exact reconciliation or retained effect uncertainty; no blind reimport |
| C14 | Receipt store cannot durably acknowledge effect intent | Required native effect is not admitted |
| C15 | Future/corrupt receipt is encountered on restart | Inspection remains possible; dependent mutation is inhibited |
| C16 | Fixed-prefix source receives legitimate later appends | Duplicate retains the declared cutoff and can proceed |
| C17 | Retained source prefix is rewritten during preparation | Snapshot revalidation rejects changed source evidence |
| C18 | Latest switch begins while native output is still arriving | Wait/explicit policy; no silent loss of the continuing turn |
| C19 | Rewind suffix grows after the selected prompt | Valid unchanged retained prefix remains eligible |
| C20 | Selected rewind address no longer resolves identically | Reject stale selection rather than matching similar text |
| C21 | Native source relocates while its old path stays readable | Active generation redirects capture/compaction consistently |
| C22 | `/clear` rebinds context without restarting the PTY | Old binding capture cannot activate as current context |
| C23 | Live request combines agent A with conversation B | Canonical admission rejects the contradictory target |
| C24 | Saved dormant conversation is selected without a backend | Capture/history work without a fabricated run identity |
| C25 | Model/namespace/cwd settings drift after projection | Explicit compatible validation or replan; no invisible substitution |
| C26 | Source compaction succeeds and target projection then fails | Result preserves source change and absence of activation |
| C27 | Compaction delivery times out after possible acceptance | Preserve unknown execution and avoid duplicate submission |
| C28 | Old writer termination is uncertain during activation | Existing custody transaction blocks conflicting input ownership |
| C29 | Renderer disappears immediately after activation | Active binding reconstructs without another native transform |
| C30 | Arrival compaction fails after successful presentation | Switch remains activated with separately inspectable follow-up failure |

B08 exits only when these evidence boundaries are covered, relevant existing replacement/delivery tests remain green, and provider-specific limitations are explicit. Review implementation diffs for thick WHY comments at admission, no-clobber publication, source validation, and compensation boundaries. Record rejected alternatives there so the reasoning survives changes to this dated plan.

Roll out per operation/provider behind one authoritative admission path. Readers understand the new receipt schema before writers emit it. Once new durable effects exist, rollback disables new admissions while retaining receipt readers, inspection, and reconciliation; it must not revert to a writer that ignores in-flight operations. A downgrade that cannot understand unresolved receipts requires a documented incompatibility gate. No phase claims atomicity across metadata, native files/services, and processes. Successful completion means their partial outcomes remain explainable and recoverable under the declared evidence and durability guarantees.

## 7. Membership migration and delivery program (B09–B15)

These batches turn the repaired operation boundaries into an enforceable ownership model. They do not authorize a simultaneous rewrite of session lifecycle, workspace layout, providers, and rendering. Each batch must leave an observable compatibility boundary that the next implementation can test. The main catalog initially uses a versioned JSON journal and snapshot with one serialized writer, checksums, and an explicit fsync policy. Persistence acknowledgement must distinguish a write accepted into memory, an atomically published snapshot, and the durability promised for a committed operation. A metadata transaction never claims to atomically include native process or provider effects.

### B09. Establish a read-only main catalog and prove projection parity

**Entry:** B00 has inventoried identity producers, durable fields, membership writers, and replacement behavior. Begin this batch while independent safety repairs proceed; it must not create another graph authority. The existing renderer workspace remains authoritative until individual mutation families cross B10.

Build the smallest useful catalog projection: candidate stable agent identity, current routing identity, exact project-tab membership, typed relationship endpoints, current native binding reference, and references to recovery receipts. Keep layouts, semantic streams, native transcript contents, and presentation caches outside it. Capture source revision, presenting renderer generation, and completeness alongside every imported projection. An absent or invalid window must produce an incomplete observation, not authoritative deletion of its members.

Compare normalized membership and relationship sets at explicit workspace revisions. Reporting every render would create noise and potentially compare unrelated instants. Record bounded, content-free discrepancy evidence identifying missing members, conflicting scope claims, unresolved legacy identities, and relationships with absent endpoints. Do not repair differences automatically during the shadow phase: that would make the observer an undocumented writer and conceal the very disagreement this batch must measure.

Exercise project restoration, hidden windows, provider replacement, hibernation, imported history, shells, names disabled, related-session presentation, and view transfer. Validate the candidate logical identity across those populations. Formalize `agentNameId` only if it proves total, unique, durable, and non-reused; otherwise select one replacement and define a finite legacy mapping. Human-readable names are not sufficient evidence of identity.

**Exit:** every known writer and relationship family appears in the census; fixtures have exact parity at settled revisions; uncertain inventories remain uncertain; discrepancies have actionable classifications. Disabling the shadow reader must leave behavior and authoritative state unchanged. Unexpected production comparisons stop cutover for the affected family rather than encouraging permissive normalization.

### B10. Transfer semantic mutations to main, one family at a time

**Entry:** B09 parity and B07's durable operation-receipt contract are established. The first cutover contains a complete mutation family, including creation, mutation, removal, restoration, and recovery of its facts. Moving only the happy-path create method would leave hidden renderer writers in charge of cleanup.

Choose the family sequence from the writer census: project membership and explicit scope operations; agent admission/removal; then typed relationships. If these share an invariant that cannot tolerate an intermediate owner split, cut them over together in a smaller coherent domain slice. Keep the existing `SessionManager` facade while moving responsibility behind it. Commands resolve registered callers, window generations, exact project scope, expected catalog revision, and current target identity in main. Revalidate authorization and relevant revisions at commit when preparation awaited other work.

Main commits the semantic result and returns its operation ID and catalog revision. Renderer placement is a subsequent projection acknowledgement. A child whose runtime starts but whose placement fails remains discoverable in the exact project catalog with separate placement and runtime outcomes. A placed pane does not certify backend readiness. After reload, obtain the authoritative catalog and unresolved operation receipts before admitting retries; renderers must not infer that a missing pane means an earlier create had no effect.

For each cutover, remove the old authoritative writes in the same delivery boundary. Compatibility adapters may submit commands or translate snapshots, but must not maintain a second writable graph. Retain bounded prior-schema snapshots for recovery; do not continuously backwrite a legacy authority for convenience. Changes arriving from stale renderer generations fail admission or become explicit stale acknowledgements and cannot resurrect removed membership.

**Exact scope and PR #914:** same-directory duplicate project tabs are supported in this baseline. Directory normalization or repository identity must never implicitly merge their membership. The already-merged **Merge Project Tabs** behavior preserves owned sessions and becomes an explicit main membership operation during this batch. Capture source scopes, destination scope, affected membership, and expected revisions; validate relationship endpoints and outstanding scoped reservations before committing. Use one semantic catalog transaction for the merge and subsequent independent view updates. Until policy exists for an incompatible pending operation, return a retryable conflict without modifying scopes. Replaying the same operation ID returns its recorded result. Moving a project view between windows does not perform this merge.

**Exit:** a writer-ownership table names exactly one owner for every migrated fact; stale writer paths are removed or reject mutation; created-but-unplaced agents are recoverable; merge and transfer preserve all retained agents and declared relationship policies. Feature rollback is allowed only while the old schema can represent the resulting graph without loss.

### B11. Adopt stable identity and assignment-specific work tracking

**Entry:** B08 can activate continuations under canonical target/custody rules, and B10 owns membership. Introduce the chosen stable logical identity through additive contracts and bounded migration. Preserve successor routing IDs, redirects, compensation, and replacement receipts until every dependent caller has moved and native custody tests establish safe removal. A stable identity does not establish that a superseded process stopped writing.

Create a transition-policy table in the owning code and protect it with behavior tests. Switch and rewind preserve logical identity and semantic membership while replacing the appropriate native binding. Duplicate creates new logical and native identities and deliberately excludes orchestration assignment identity, consumed bootstrap state, credentials, and previously completed work. Auxiliary terminals, application orchestration, native child observations, derivation provenance, and presentation grouping keep distinct endpoints and close policies. Workflows retain durable origin references even after their originating pane closes. Run roots have one authoritative record; derived indices are rebuilt and checked against it.

Introduce `WorkRequest` as the assignment a caller actually waits for. Record request ID, exact logical target, captured binding, orchestration scope where relevant, delivery attempts, native correlation evidence, and result evidence. Delivery and execution have separate states, and accepted delivery retains its transport-level or durable meaning. A terminal request result remains inspectable after subsequent assignments and view closure. Reject assigning old latest-output text to a new request solely because timestamps or session status appear compatible.

Migrate consumers in order: assignment creation records a request before delivery; delivery returns request/attempt evidence; follow-up tools return request IDs; wait tools capture explicit request IDs or an explicit request set; status presentation distinguishes session activity from assignment completion. Existing session-only callers receive a documented compatibility result with correlation limitations, not fabricated certainty. Provider switching with outstanding work invokes an explicit continuation policy: reject, cancel with evidence, or rebind under a recorded decision. Unknown native effects remain unknown.

**Exit:** references survive switch, rewind, transfer, and restart according to policy; duplicate does not inherit assignment authority; waits for task B cannot complete from task A; existing workflow execution remains in the workflow engine. Remove legacy fields only after persistent data, MCP/control clients, desktop, and remote consumers have migrated.

### B12. Complete generation-aware observation delivery

Add compatible envelope fields after B00, but complete consumer cutover after B11 stabilizes target identity. Inventory producers, coalescers, IPC forwarding, remote transport, async history requests, reducers, mapper instances, and subscription setup. Every queued observation must retain the identity captured at production; relabeling it with the current run at flush would conceal staleness.

For live observations, carry application instance, logical target, runtime run, binding epoch, observation plane, and relevant sequence/coverage information. Binding epochs change on context adoption, including native context changes without PTY replacement; normal transcript append does not increment them. History responses carry binding and source generation without requiring a live runtime. Source generation invalidates cursors when the authoritative locator or file generation changes, even if an old path remains readable.

Specify snapshot/subscription as one protocol. Establish subscriber ownership, capture a snapshot with per-plane watermarks, then deliver or replay updates beyond its coverage. Bound pending delivery by count and bytes. On overflow, unavailable replay, or incompatible instance, require explicit resynchronization and surface gaps in transient evidence. Native history cannot reconstruct every lost terminal screen or semantic event.

Coalescing rules must distinguish replacement values from ordered events. A cumulative text update can cover a range; completion and removal barriers retain order and semantic-before-commit flushing. Validate envelopes at buffer admission, flush, and client application. Keep independent stateful mapper instances for live ingestion, history, and replay; resetting one consumer must not corrupt another's mapping state.

**Exit:** desktop and remote consumers reject old-run, old-binding, and old-source responses; dormant history still loads; intentional coalescing is distinguishable from loss. During compatibility rollout, a legacy client may receive a deliberately reduced safe surface or be required to update. It must not receive invented generation values that imply guarantees it cannot enforce.

### B13. Tighten capabilities and verify all seven package artifacts

The baseline declares **seven** runtime package submodules. Six existing package checkouts match the baseline pins; the seventh, OpenCode terminal, is uninitialized and needs its own pinned baseline audit. Structured OpenCode findings do not automatically describe its implementation. This matrix states required host contracts and planned evidence, not completed package verification.

| Package and baseline pin | Contract to preserve or establish | Package and consuming-host proof |
| --- | --- | --- |
| `agent-transcript-parser` — `9c99db00` | Neutral model, source addresses, archive/native-resume distinction, universal projection guards and fidelity reports | Real fixture decoding/projection, declaration/public-export consumption, report propagation through switch/duplicate/rewind |
| `agent-voice-dictation` — `3c6f9628` | Main credential authority; transcription bound to a target ticket and draft revision | Stale-target refusal; desktop/remote credential-policy agreement; packaged assets and declared dependencies |
| `claude-code-headless` — `dd89f383` | Separate screen/semantic/committed channels; raw input versus evidence-bearing submission | Stop-during-start and late-resource cleanup through public API; durable acceptance fixtures; built runtime exports |
| `codex-headless` — `5bfeaca9` | Exact native attribution, custody/release evidence, attested input behavior | Ambiguous-launch/teardown integration; public declarations preserve uncertainty; resume compatibility lane |
| `opencode-headless` — `4f2ef5de` | Structured HTTP/SSE capabilities, explicit binding, bounded reconnect/stop and ingress | Wrapper-to-dispatcher tests; real timer behavior; disposal deadline; packed HTTP/SSE dependencies |
| `opencode-terminal-headless` — `e85b3f53` | Its own PTY/input/history/condition/lifecycle contract, established from its implementation | Separate capability census, public export tests, host switch/rewind and teardown checks; no borrowed structured assumptions |
| `workflow-mcp` — `b4b98f8d` | Durable jobs, source approval, attempt evidence, browser-safe state exports | Recovery after origin closure; built worker/runtime files; browser import without server execution dependencies |

Move shared spawn, command, and result types out of preload-owned modules into transport-independent contracts. Make raw input and resize available only through PTY capabilities; structured prompt submission uses its supported capability. Condition actions must be admitted against the capability that offered them. Preserve evidence-bearing delivery results and explicit unsupported results at runtime boundaries; do not replace them with booleans or callable no-ops.

Create an explicit browser-safe conversation model boundary for ingestion, identities, ledger ownership, ordering, and feed derivation. Start with internal modules rather than automatically creating an eighth package. Inventory remote aliases and replacements; migrate consumers to intentional exports and assert that browser builds cannot import process, credential, or server entry points.

For each changed package, run its actual pinned package checks and build, then consume a packed artifact from an isolated temporary host without source aliases or repository-relative fallbacks. Check declarations, export maps, ESM resolution, runtime files, licenses, and declared dependencies. The host's packaging checks supplement rather than replace that test. Package implementation commits and the parent gitlink update remain separate reviewable repository changes. Do not update unrelated pins to make the lane pass.

### B14. Optimize measured fleet behavior with a correctness oracle

Baseline instrumentation can begin early; optimization follows the relevant correctness gates. Separate ingestion, candidate collection, ownership reconciliation, ordering, feed derivation, React commit, expensive row rendering, history capture/counting, PTY buffering, and native readiness. Counters should describe bytes, JS code units, retained objects, and estimated heap separately. The documented per-session entry trigger is a sizing input, not measured process memory.

Implement an application-wide pressure policy that accounts for main, each renderer, native processes, terminal models, editor buffers, observation queues, and diagnostic retention. Evict reconstructible caches and reduce hidden presentation work before discarding unresolved operation evidence or identity. Restore panes immediately while bounding expensive starts and replay; reserve progress for foreground actions, cancellation, interruption, and already-running agents. Investigate #774, #775, #769, #766, #763, #365, and #764 against current evidence; host-process extraction remains an investigation until measurements justify it.

For history, decouple first useful suffix from exact total counting where the provider contract permits it. Derived sparse indices require source identity/generation, validated checkpoints, and invalidation for truncation, replacement, and rewrites. For rendering, compare dirty-set or indexed reconciliation with the full rebuild reference. For PTY buffers, benchmark representation changes and replay behavior; a bounded raw tail is not a terminal-state checkpoint. Transform workers require byte-aware admission and small source/artifact handles to avoid duplicating entire decoded histories.

**Exit:** the proposed benchmark protocol in section 8 demonstrates the claimed improvement and no meaningful regression outside it; replay equivalence covers ownership and evidence, not only rendered text. Keep the original reference path available in tests. Retain ghost fallback until equivalent evidence covers the late/missing-commit cases it protects.

### B15. Recover editor work and isolate optional startup failures

These are independently shippable tracks. Editor recovery depends on a settled write/durability contract, not on B14 performance work or completion of the identity migration. Optional-service isolation can proceed once required recovery boundaries are explicit.

Journal recoverable editor content using buffer identity, file reference, base disk-version evidence, local revision, encoding metadata where required, and the acknowledged recovery revision. Bound per-buffer and total retained bytes and define when the UI can truthfully show recovery protection. A disk-full or journal failure must leave the editor usable while making missing crash protection visible. Unsaved untitled buffers need recoverable identities too.

On restart, compare the recovered buffer's base with current disk state and present recoverable content with conflicts when necessary. Do not overwrite files automatically. Save acknowledgement clears only the journal revision actually persisted if no newer edit remains. Edits during save, an old save callback, or a crash between file publication and journal cleanup must never delete newer recovery content. Explicit discard and retention expiration use version-aware deletion. Prompt drafts need a separate retention decision because expanded secrets may be present; editor recovery must not silently enroll them.

Classify startup dependencies into required authority/recovery facilities and optional services. Optional LSP, dictation, or remote service failure should produce a usable workspace with explicit feature health and bounded retry. Failure to decode the authoritative catalog, determine native custody, or establish required journal recovery must restrict the affected operations; degraded mode cannot bypass those guards. Preserve diagnostics sufficient to distinguish unavailable, still initializing, failed, and intentionally disabled services without broadcasting session content.

## 8. Verification and rollout

### Boundary scenarios and evidence recording

The following are proposed obligations, not claims of missing tests. B00 maps each to existing coverage, adds only distinct failure scenarios, and records implementation PR, fixture/command, assertion, and evidence class. Existing deterministic tests may satisfy several obligations when they genuinely cross the relevant boundary. Source-confirmed risks remain distinct from runtime reproductions and measured improvements.

| ID | Interleaving or workload | Required observable result |
| --- | --- | --- |
| M01 | Two tabs use the same directory | Distinct semantic membership survives restore and queries |
| M02 | Shadow import omits an invalid window | Inventory remains incomplete; no member is authoritatively deleted |
| M03 | Disable shadow catalog after parity comparison | Existing behavior and persistent authority remain unchanged |
| M04 | Main creates child; presenting renderer disappears | Child is discoverable with independent runtime/placement outcomes |
| M05 | Old renderer submits a mutation after replacement | Admission or commit rejects its stale authority |
| M06 | Replay an admitted membership command after lost response | Same operation result; no duplicate member |
| M07 | Explicit Merge Project Tabs with agents and auxiliary shells | All retained members and typed associations move once |
| M08 | Merge races an unresolved scoped mutation | Conflict is explicit; neither graph is partially rewritten |
| M09 | Transfer a project view to another window | Membership, binding, and runtime ownership stay stable |
| M10 | Names disabled, imported/dormant sessions and shells migrate | Identity is total and non-reused, or mapping blocks unsafe cutover |
| M11 | Switch with auxiliary terminals and orchestration descendants | Logical references and declared continuation policies survive |
| M12 | Duplicate an agent with completed/bootstrap work | New logical/native identity; no copied request or credential authority |
| M13 | Rewind an origin with running descendants/workflows | Removed-suffix completion does not apply; independent work remains inspectable |
| M14 | Task A completed; task B delivered while session remains idle | Wait for B cannot return A's result |
| M15 | Delivery outcome unknown, followed by wait/retry | Unknown remains explicit; no automatic repeated native effect |
| M16 | Native binding changes while request remains outstanding | Recorded reject/cancel/rebind policy controls continuation |
| M17 | Old-run event enters buffer before replacement, flushes after | Client rejects it despite previously valid production |
| M18 | Native context resets within the same PTY | Binding epoch fences prior context while valid runtime continues |
| M19 | Dormant history replies after source relocation | Correct generation loads without a live run; stale response is rejected |
| M20 | Snapshot creation races coalesced and ordered events | Watermarks provide complete coverage without lost barriers |
| M21 | Desktop/remote queue exceeds byte or count budget | Explicit gap/resync; bounded memory and no invented replay |
| M22 | Independent live/history/replay mapper activity | Stateful identity mapping remains isolated and equivalent |
| M23 | Structured provider receives raw-input request | Capability admission rejects unsupported operation explicitly |
| M24 | Consume all seven built packages without source aliases | Public declarations/exports/runtime assets resolve correctly |
| M25 | Replay 1/8/32 agents with independent visibility counts | Reconciliation matches oracle and latency/memory remain measured |
| M26 | Cancel/interrupt during a large restore backlog | Foreground control progresses within registered latency budget |
| M27 | Editor crashes after newer edit during save | Latest recoverable revision survives old save acknowledgement |
| M28 | Recovered editor base differs from disk | Conflict is presented without overwriting either version |
| M29 | Optional service fails while required catalog recovery succeeds | Workspace remains useful with bounded retries and explicit health |
| M30 | Unsupported catalog version or older binary opens migrated store | No silent downgrade/write; recovery guidance preserves authoritative data |

### Reproducible benchmark protocol

Use fixed, sanitized native recordings and source snapshots with declared sizes and workload seeds. Measure 1, 8, and 32 active agents; independently vary visible feeds at one, a small visible subset, and all feasible feeds. Include small frequent semantics, large individual tool results, long histories, hidden panes, reconnect gaps, and repeated wake/hibernate/replacement cycles. Run recorded host workloads separately from opt-in live native workloads so model/network latency does not disguise application regressions.

Record machine/OS, build mode, application SHA, seven pins, native versions, workload identifiers, warm/cold cache conditions, and instrumentation overhead. Use a warm-up followed by repeated runs with paired baseline/candidate order; publish sample counts, dispersion, p50/p95/p99 where sample size supports them, peak retained memory, event-loop delay, queue age, and post-churn resource counts. A single best run is not acceptance evidence.

Before optimizing, register the target metric and acceptable regression budgets in the implementation issue using baseline variance and user-visible requirements. Measure command admission separately from native readiness, observation-to-paint separately from model completion, and first useful history separately from exact indexing. Compare main and renderer memory separately and account for native children. Pressure tests must show bounded queues and eventual resource release, not merely stable final heap after forced collection.

Run the full-rebuild oracle over identical event sequences, including altered batch boundaries and delivery delays. Compare selected and suppressed owners, order, tool pairing, unknown evidence, fallback eligibility, stable identities, and final feed derivation. Only then compare performance. Any unexplained correctness mismatch blocks optimization rollout regardless of speedup. Preserve the recording and minimized counterexample with the owning regression test.

### Commands, native lanes, and review discipline

The baseline [package scripts](../../../package.json) and [testing conventions](../../../testing/README.md) define these existing commands. They are instructions for later implementation verification; this planning pass did not execute them:

```bash
npm run submodules:check
npm run test:contract
npm run typecheck
npm run test:unit -- src/main/sessionManager.lifecycle.test.ts
npm run test:system
npm run test:renderer
npm run test:package
```

The lifecycle command demonstrates a focused existing suite; select the owning implementation's actual relevant tests before execution. Prefer filtering the smallest meaningful boundary suite over repeatedly running every project. `test:integration` aliases `test:system`; it is not another independent lane. `typecheck` builds workflow artifacts and runs the control SDK plus project checks. `test:package` builds the application and verifies its output; it does not by itself prove all seven packed public APIs.

Use `npm run check` for the repository's integrated gate when the PR is ready; it includes fixture/keybinding checks, type checking, resume-probe type checking, tests, and packaging verification. Read each changed package's pinned `package.json` before choosing private build/test/pack commands; do not assume every package has the same scripts. Add consuming-artifact checks under the existing test architecture and colocate behavioral tests beside their owning source.

Native compatibility needs a separately reported opt-in lane with isolated native namespaces and disposable fixtures. Existing entry points include `npm run test:live:conversations`, `npm run smoke:tmux`, `npm run smoke:tmux:minimal`, `npm run verify:package:mac`, and `npm run smoke:package:mac`; select them only where their actual contract applies. A passing fake transport, parser round trip, or `test:live` invocation with no matching tests cannot establish native resume compatibility. Pin and report supported provider versions rather than implying universal behavior.

Track this program under umbrella #918. Search existing issues before creating a new substantive bug/refactor record, and link the existing issue when scope matches. An implementation defect discovered while fixing the same problem normally updates that record rather than producing issue noise. Each implementation PR uses a dedicated outcome-named worktree/branch, starts with its committed focused plan, and carries Conventional Commit/PR titles. Keep the issue as the problem record and the PR as the implementation/verification record; use `Refs` for partial delivery and `Fixes` only for complete resolution.

### Release gates, rollback, and completion

Roll out additive contracts, shadow observation, one-family authority cutover, consumer migration, and legacy removal as separate gates. A feature flag selects a coherent ownership protocol at startup; toggling it must not create concurrent writers. Persist schema/version and migration status before relying on migrated facts. On restart, recover interrupted migration or receipt publication before admitting related mutations.

Before each persistent cutover, produce and exercise a rollback/downgrade matrix: old reader versus new snapshot; old writer versus new facts; interrupted journal migration; unknown schema; partial inventory; and rollback after native side effects. Keep checksummed pre-migration copies under an explicit retention budget. After effects that the prior schema cannot represent, rollback means compatible forward recovery or a deliberately restricted build, not replacing the authoritative store with a stale backup. Never resurrect old bindings, lose created agents, or replay uncertain effects to make an older UI appear functional.

Each batch is complete only when its owning issue acceptance criteria pass, operation and uncertainty outcomes are inspectable, relevant fixtures and checks pass, package pins are coherent, and the final diff has been reviewed for unrelated changes. Move lasting invariants and rejected-alternative reasoning into generous WHY comments beside the owning code. Update architectural documentation when responsibility changes; keep this dated plan as the implementation record rather than a second evergreen authority.

The program is complete when migrated facts have one writer, every session-changing operation preserves its target and evidence across restart, all supported consumers enforce the lifetime contract, seven-package consumption is verified, recovery preserves user work, and any performance claim has reproducible measurements. Record remaining intentional limitations explicitly. Resolve valid review feedback and ensure current CI passes before proposing merge; neither this plan nor an instruction to open a PR authorizes merging without explicit user confirmation.

## 9. Owner extraction, implementation ledger, and review coverage

### 9.1 Extract owners only when their cleanup and mutation contracts are known

The names below are responsibility labels, not a requirement to introduce seven independently configurable services. Retain the existing facade and use small injected ports. Move one responsibility with its tests and all cleanup paths; do not split a method from the state whose lifetime makes it safe. Parallel maps may remain appropriate when they represent different lifetimes. Grouping every map into a runtime object would be incorrect if a delivery reservation or custody tombstone must outlive that runtime's routing entry.

| Proposed owner | Current starting point | Extraction acceptance |
| --- | --- | --- |
| Session catalog | Workspace ownership/persistence, agent identity, bridge relationship indices | Durable semantic graph only; project and relationship mutation families have one writer. |
| Lifecycle coordinator | `SessionManager` spawn/recover/replace and shutdown gates | Publish admission before awaits; join recovery; cancel without global waits; preserve current registry generation and custody compensation. |
| Runtime registry | Provider records, handles, listeners, snapshots and owned helpers | Resource accounting identifies process, watchers, timers, proxies, temporary credentials, MCP registration and attached resources; late acquisition cleans through its own generation. |
| Prompt delivery coordinator | Manager reservations and provider delivery adapters | Stable submission/attempt correlation, captured binding, absolute deadlines and unchanged acceptance/retry evidence; removal of visible entry cannot release an uncertain write. |
| Native replacement coordinator | Existing Codex replacement ledger and provider resume resources | One native custody authority; metadata activation references its evidence and never replaces compensation with a UI acknowledgement. |
| Observation hub | Forwarder, coalescers, snapshot/history delivery | Run/binding/source evidence survives buffering and consumer application; structural barriers and output budgets are explicit. |
| PTY attachment owner | Manager attachment maps, terminal dispatcher and renderer ownership helper | Exactly the selected view controls size; a view change never spawns another agent; bounded tail is not misrepresented as a complete checkpoint. |

These extractions follow the relevant B01–B13 behavior gates. Shared type relocation can ship earlier, but passing TypeScript after moving types is not proof of lifecycle preservation. Avoid making preload a dependency of domain services; use shared contracts and thin IPC adapters. Browser model extraction likewise must preserve stateful mapper lifetimes and provider renderer capability policies.

### 9.2 Dictation, secrets, and scope transitions

B13's voice integration audit must produce a concrete target-ticket contract: logical/routing session identity during migration, binding revision, draft identity/revision, initiating renderer/mount generation and recording ID. Partial/final transcription may update only its captured owner. Moving focus does not retarget a recording. A changed draft can accept an explicit merge policy only when the composer owns that decision; otherwise preserve the transcript as an unsent recoverable result or return a stale-target outcome. Auto-submission, if offered elsewhere, must pass the ordinary evidence-bearing delivery path and cannot be inferred from transcription completion.

Default credential-resolution decision for the proposed implementation is to route both authorized desktop and remote transcription through one main-owned resolver: explicit environment override first, then the saved encrypted dictation key. Remote transports receive transcription results, not the key. Enabling a paired transcription endpoint authorizes use under that feature's existing policy, not unrestricted credential disclosure. Verify settings/status and error behavior when environment and stored keys differ; if remote use needs a separate product setting, add that explicit policy rather than silently preserving two unrelated lookup implementations.

Do not record raw audio by default. Recording history and recovery must preserve current opt-in diagnostic capture policy. The editor crash journal excludes composer/dictation prompt drafts unless a separate privacy and retention decision enables them; plaintext released from the vault can exist in drafts and must not gain a new persistent copy accidentally. Namespace fingerprints and operation diagnostics exclude secrets and auth-bearing URLs. This policy belongs in the actual main resolver/target-admission code with WHY comments, not only here.

### 9.3 Proposed PR ledger and dependency gates

Each row describes a delivery family. A large row splits into focused PRs with its own issue and first plan commit; it is not an instruction to open an empty implementation PR. The current branch contains only this completed plan. Future branches are named after their delivered behavior. Open implementation PRs fully built and verified for their scope; never use this planning PR to claim runtime issues are fixed.

| Batch | Suggested scope / branch outcome | Primary evidence before merge |
| --- | --- | --- |
| B00 | `chore(architecture)` baseline census / `chore/session-contract-census` | Exact pins, instructions, test mapping, owner/writer matrix and baseline failures attributed. |
| B01 | `fix(terminals)` resource inventory; `fix(windows)` scoped delivery | #898/#920, complete/partial/future inventory and transfer/buffer cases. |
| B02 | `fix(lifecycle)` reversible quit | #919, veto through real composition, revision revalidation, required-drain failure. |
| B03 | `fix(opencode)` native binding/transport lifecycle | Package #10–#13, public-wrapper and real timer tests, package/app compatibility. |
| B04 | `fix(lsp)` document lifetime | #921–#924, old-server exit, authorizing open, real post-sync completion, stale read bounds. |
| B05 | `fix(orchestration)` read dedupe and effect reservations | #925/#926, queued freshness, invalidation generations, unknown mutations with unrelated scope progress. |
| B06 | `fix(provider-switch)` continuation fidelity | #927/#929/#930, real projection/draft reports and honest stage vocabulary. |
| B07 | `fix(provider-switch)` native publication | #928, no-clobber target creation, interrupted receipts and native import uncertainty. |
| B08 | `refactor(sessions)` continuation admission/activation | Canonical live/saved sources, capture policy/config drift and existing custody integration. |
| B09 | `refactor(workspace)` catalog shadow | No new mutation authority, exact settled-revision parity, incomplete-source handling. |
| B10 | `refactor(workspace)` main membership | One writer per cutover family; explicit merge/close/create/transfer recovery and stale caller rejection. |
| B11 | `refactor(sessions)` identity and request correlation | Identity audit, #879 lineage continuity, B-specific waits and preserved native custody. |
| B12 | `fix(sessions)` observation lifetime | #894/#895, all buffers/clients/history responses fenced; snapshot and coverage guarantees. |
| B13 | `refactor(providers)` capabilities and artifact consumers | Seven public package artifacts, browser-safe boundary, unsupported runtime operations refused. |
| B14 | `perf(sessions)` measured fleet bottlenecks | Registered metrics, paired workload results, replay equivalence, unchanged ownership evidence. |
| B15a | `feat(editor)` crash recovery | Crash/save/conflict/ENOSPC/untitled recovery evidence and explicit privacy scope. |
| B15b | `fix(startup)` optional service isolation | Required authority failure still gates mutations; optional services can fail/retry independently. |

Before implementing B08–B15 feature/refactor families, create or identify their specific issue with motivation, acceptance criteria and scope; #918 alone is the program index. For findings already recorded, update the existing issue rather than copying its problem into a competing record. A plan-only PR uses `Refs`, not `Fixes`, for the program and linked runtime issues.

Do not treat this as a calendar estimate. The critical path is evidence-dependent: safety fixes and additive contracts first; receipt/publication evidence before continuation activation; shadow parity before graph ownership; stable references before legacy removal; correctness oracle before optimization. A blocked native compatibility lane blocks only the capability claim it proves, unless shared custody or migration integrity makes the block broader. Record that scope explicitly.

### 9.4 Coverage of all three supplied reviews

The shorthand Rv1, Rv2 and Rv3 refers to the first, second and third pasted reviews, respectively. This table makes adoption or deliberate qualification visible so a future implementer need not reread the conversation to discover a missing recommendation.

| Review recommendation | Planned disposition |
| --- | --- |
| Rv1 §1 preserve difficult existing distinctions | I01–I16; existing provider, ledger, custody and state-plane mechanisms are required oracles. |
| Rv1 §2 separate identities and namespaces | §3.1–3.2, B08/B11/B12; qualified by Rv3's existing-name-identity audit. |
| Rv1 §3 typed relationship families | §3.3 and B10/B11; explicit lifecycle/merge policy, no universal parent ID. |
| Rv1 §4 main semantic membership | B09 shadow, B10 single-family cutover; renderer keeps layout and interaction. |
| Rv1 §5 lifetime-based manager refactor | §9.1 and B00 contracts; extraction follows behavior proof. |
| Rv1 §6 provider capabilities and submission identity | B03/B13 and §3.6; no callable no-ops or boolean delivery. |
| Rv1 §7 lifetime-carrying transport | B12; source-aware dormant history, per-plane coverage and resynchronization. |
| Rv1 §8 ledger and incremental profile | B13/B14; full rebuild oracle, mapper isolation and ghost fallback retained. |
| Rv1 §9 destructive recovery/routing/storage | B01 and §3.5; unknown inventory preserved, JSON journal chosen initially, no automatic SQLite migration. |
| Rv1 §10 editor crash recovery | B15a; independent of performance tranche and excludes prompt drafts by default. |
| Rv1 §11 package-specific contracts/artifact tests | B13 seven-package matrix, §9.2 dictation; new terminal package added to baseline audit. |
| Rv1 §12 fleet/performance/start/history/PTy | B14 benchmark protocol, #774/#769/#766; no claimed speedup or forced workerization. |
| Rv1 §13 migration order/regression inventory | §4 dependencies, §9.3 ledger and R/C/M scenario matrices; inaccessible external counts not treated as coverage. |
| Rv2 §1 cancelled quit dismantles services | B02/#919; preparation reversible, commit drains held, approvals revision-scoped. |
| Rv2 §2 wrapper defeats OpenCode session filter | B03/package#10; classify before state mutation, including permissions and child observations. |
| Rv2 §3 LSP cleanup/admission/completion/stale waits | B04/#921–#924; one document lifecycle with post-sync request tickets and bounded abandoned RPCs. |
| Rv2 §4 pending promise TTL duplicates polls | B05/#925; pending dedupe separate from completion-based freshness and generation invalidation. |
| Rv2 §5 transport timeout is not effect serialization | B05/#926 and §3.4; unknown effect retains scoped reservation with reconciliation. |
| Rv2 §6 reconnect timer overflow | B03/package#11; actual Node primitive probe recorded, package/public wrapper test still required. |
| Rv2 §7 stop deadline and start/stop generation | B03/package#12; dispose deadline includes HTTP, observed exit or retained custody. |
| Rv2 §8 ingress bounds before parse | B03/package#13; wire/frame/HTTP/diagnostic budgets, gaps and processing slices. |
| Rv2 §9 WorkRequest | §3.6 and B11; assignment completion cannot be inferred from session latest output. |
| Rv2 §10 composed test boundaries | R01–R35, C01–C30, M01–M30 and B00 mapping; no mechanical test-count target. |
| Rv3 §1 reuse identities and define transition policies | §3.1/3.3 and B11; promotion gate, deliberate duplicate semantics, names feature not domain authority. |
| Rv3 §2 continuation as complete operation | B06–B08, §3.5; prepared/published/activated/view outcomes with one operation ID. |
| Rv3 §3 canonical targets/effect-specific conflicts | §3.4 and B08; live/saved variants, no global readiness mutex. |
| Rv3 §4 projection and draft fidelity | B06/#927/#929; reports survive IPC/persistence/UI independently of context fit. |
| Rv3 §5 provider-aware native publication | B07/#928; no-clobber file publication, import reconciliation and bounded owned cleanup. |
| Rv3 §6 capture consistency and readable old locators | B08, C16–C24; fixed prefix/latest/rewind policies and source-generation evidence. |
| Rv3 §7 structured drafts and literal-markup ambiguity | B06/#929/#930; full decoder reachability remains a gate, preserve ambiguous prose. |
| Rv3 §8 resolved continuation configuration | B08; requested/resolved/observed distinct, capacity estimates retain evidence and drift policy. |
| Rv3 §9 retained graphs/prompt indexing/workers | §6.6 and B14; narrow plans before waits, bounded preview discovery and byte-aware worker measurement. |
| Rv3 §10 package boundaries and universal guards | B06 parser guard and B13 contract matrix; native API-error capabilities remain provider-specific. |
| Rv3 §11 smaller main catalog | B09/B10, §1.2; no hot renderer/transcript state centralized and no permanent two-way graph synchronization. |
| Rv3 §12 realistic transformation tests | C01–C30 and artifact/native lanes; real decoder/projector/store/adoption composition. |

### 9.5 Final implementation acceptance record

The executing PRs must leave a per-batch record of actual baseline/candidate revisions, linked issues, relevant test and native-probe commands, observed outcomes, intentional limitations, migrated writer families, schema/downgrade compatibility and performance results when claimed. Check boxes in this plan are not a substitute for that evidence. A later agent updates status when work ships or is superseded and moves enduring decisions into the owning code and architecture/design references.

Program acceptance requires: one owner per semantic fact; native writer custody and post-effect uncertainty preserved; no unplaced orphan agents after view failure; no stale input/history/event targeting across run or binding changes; inspectable continuation fidelity and recovery; safe quit and editor-work preservation; exact project/relationship behavior across merge and transfer; verified supported package capabilities; and measurements supporting any optimization. Unresolved native capability limitations remain explicit rather than weakening these guarantees.

This planning change adds no application implementation, generated diagrams, migrations, test fixtures, runtime binaries or dependency changes. It does not close the tracked bugs, claim the 95 proposed scenarios pass, or authorize a merge. The next implementation task should choose a bounded batch from the ledger, revalidate its current baseline, and follow the same issue/first-plan/worktree/PR discipline.
