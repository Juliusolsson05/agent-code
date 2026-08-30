# Live worktree attribution recovery

Issues: #658, #685

Status: decomposition only. No production implementation is authorized until
this document is explicitly approved.

## Why staged decomposition applies

The repository contains roughly 241,000 tracked TypeScript/TSX/MTS lines, and
the displayed worktree is reconciled from Git identities, two provider record
formats, Codex rollout ownership, an asynchronous renderer cache, accumulated
runtime state, and several UI consumers. The previous repair correctly added
modern Codex record grammar but proved only a direct tracker replay, not the
live path that is failing now. This is exactly the multi-source, partially
completed subsystem for which another local conditional would create a second
40–70% fix.

## A — trusted inputs and current behavior

The following existing artifacts are trusted independently:

1. `git worktree list --porcelain`, exposed as `WorktreeIdentity[]` by
   `src/main/ipc/git.ts`, is the source of truth for a matched checkout's
   canonical path, current branch, HEAD, and detached state.
2. Provider recordings are the source of truth for what an agent actually did:
   Claude JSONL conversation envelopes and tool inputs, and Codex rollout
   `CommandExecution` / `FileChange` records.
3. `src/shared/work-context/provider-evidence/`, `matching.ts`, and `tracker.ts`
   already convert provider records plus Git identities into `active`,
   `primary`, and `touched` worktree state. Direct replay of the affected Codex
   rollout through this layer selects the linked worktree correctly.
4. `packages/codex-headless/src/transcript/` is the existing owner of rollout
   identity and at-most-one-tail policy. The renderer does not get to select a
   rollout file.
5. Agent Code's existing session recorder, proxy log, feed-debug log, and
   workspace snapshot record the actual live boundary without requiring an
   imagined reproduction harness.
6. `WorktreeBadge` prefers `workActivity.active` over the longer-lived primary
   context. Given correct runtime state, the final badge projection is already
   correct.

The current observable failure is that an agent performing work in a linked
worktree can still display `main`. Two independent real recordings explain why.

### Recorded Claude failure

The reported resumed Claude session currently contains:

- 161 assistant and 82 user envelopes whose top-level `cwd` is the grid
  worktree while `gitBranch` remains `main`;
- 30 recorded assistant tool paths inside that worktree;
- nine assistant records where the envelope `cwd` is still the main checkout
  while the same record's tool path is inside the grid worktree; and
- 21 assistant records where both the envelope and tool path identify the grid
  worktree but `gitBranch` still says `main`.

The current adapter appends tool evidence first and the generic envelope cwd
second. The generic seed can therefore overwrite stronger evidence from the
same record. When the path does match the worktree, `contextFromPath` also
prefers the stale provider branch over Git's matched branch, so the badge label
still becomes `main` even though its path is the grid worktree.

### Recorded Codex failure

At the complaint-time cutoff, the affected Codex 0.151.0 rollout ends with 12
consecutive completed commands in the UI worktree. Launch and per-turn metadata
continue to report the main checkout, as expected. A direct production-parser
replay chooses the UI worktree as active and keeps main only as the accumulated
primary context.

The matching live Agent Code recording contains 9,020 semantic events, 2,813
screen events, and **zero** `session:jsonl-entries`. Its workspace metadata has
launch `cwd = main` and no provider session id. Startup records
`Codex prompt evidence disabled: unsupported-cli`, because fresh-rollout prompt
attestation is deliberately pinned to Codex 0.149.1. With no rollout entries,
the renderer never invokes the fixed parser and can only display its main-cwd
fallback.

The same per-session Responses proxy recorded 253 real `/responses` requests.
All 253 bodies are zstd encoded; all 253 decode to one exact
`client_metadata.thread_id`; all 253 have equal `session_id` and `thread_id`;
and that id equals both the real rollout filename UUID and its
`session_meta.id`. The proxy's current `request_shape` extractor does not see
this because it attempts to parse the compressed bytes directly, so the exact
identity remains forensic data instead of entering rollout ownership.

## D — observable end state

1. The recorded Claude grid session displays the Git worktree's canonical
   branch, not the stale envelope branch, throughout both recorded disagreement
   shapes.
2. An activity-producing tool path in a Claude record outranks that record's
   generic envelope cwd. Generic launch/conversation cwd can bootstrap an empty
   state but cannot repossess `active` from stronger direct activity.
3. The recorded Codex 0.151.0 session uses its exact per-session proxy identity
   to acquire and tail only the rollout whose filename UUID and
   `session_meta.id` both match. Its live runtime and badge then move from main
   to the UI worktree when the recorded commands arrive.
4. Concurrent Codex sessions cannot tail one another's rollouts. Missing,
   malformed, ambiguous, or conflicting proxy identity fails closed and never
   falls back to "newest file" or cwd-only selection.
5. The actual `SessionFeed -> Git identity availability -> runtime -> badge`
   path is covered by recorded fixtures. A direct tracker replay is no longer
   accepted as proof of live behavior.
6. Main is shown as active only when direct activity or an allowed empty-state
   fallback supports main. Weighted historical primary state and launch cwd do
   not override a more recent direct action in another worktree.
7. Historical indexing, the Worktrees surface, Dispatch, tiled panes, and
   ordinary pane badges consume the same canonical result without adding
   provider-specific branches.

## Proposed source-of-truth decisions requiring approval

These decisions are semantic policy, not facts that tests can infer. Approval
of this decomposition approves them for Stage 2 contracts:

1. **Matched Git identity owns the branch label.** Once an evidence path matches
   a current `WorktreeIdentity`, Git owns canonical path and branch. A provider
   branch remains diagnostic/fallback data only for an unmatched path; it may
   not relabel a matched checkout.
2. **Direct activity owns `active`.** Explicit worktree enter/exit and recorded
   commands, writes, and reads describe where work is happening. Session or
   conversation cwd is bootstrap/affinity evidence and may fill an empty state,
   but it may not overwrite stronger direct activity merely because it was
   appended later in the same envelope or repeated by a later metadata record.
3. **Per-session proxy identity can prove exact Codex ownership.** A thread id
   observed on that session's private proxy request is only accepted after the
   existing exact locator proves requested id = filename UUID =
   `session_meta.id`. It enters the existing process-wide lease system; it does
   not create a second tail policy.
4. **No evidence is preferable to false certainty.** If exact ownership and
   prompt ownership are both unavailable, the system may keep a clearly
   fallback launch context, but it must not manufacture direct activity or
   select a global rollout by recency/cwd.

## Stage 1 — extract and catalog the real failing corpus

**Produces**

- A deterministic extension of `scripts/extract-work-context-fixtures.mts` (or
  a narrowly named sibling if keeping the existing cutoff immutable) that
  emits sanitized fixtures under
  `testing/fixtures/worktree-live-attribution/`.
- `docs/decomposition/evidence/worktree-live-attribution/shape-census.md`, with
  counts for the Claude disagreement sequence, Codex live channel population,
  compressed proxy identity, matching rollout identity, command-location
  transitions, and Git identities.
- A fixture provenance manifest containing source fingerprints and extraction
  rules, never home paths, prompts, command bodies, raw ids, or assistant text.

**Verified by**

- Two consecutive extractions at a fixed cutoff are byte-identical.
- Existing sensitive-value gates reject home paths, source ids, prompts,
  commands, tool results, tokens, and unapproved free text.
- Census assertions reproduce the measured contradictions: Claude worktree
  tool paths with main envelope/branch metadata, and Codex exact proxy identity
  plus zero live JSONL delivery despite worktree rollout commands.
- Every minimized row maps back to an immutable source fingerprint and ordinal.

**Why separate**

The current Codex parser is already correct when fed the rollout. Combining
fixture capture with a fix would let an implementation silently redefine the
missing boundary it is supposed to explain. Likewise, hand-authoring a stale
Claude branch literal would only test our story about the bug.

**Reality check**

This stage projects the user's exact Claude resume recording, the affected
Codex rollout, the matching Agent Code session recording/feed log/workspace
snapshot, its per-session proxy log, and the current Git worktree list. Existing
instrumentation already captured the failure, so adding another recorder before
extracting it would create a redundant source.

### Stage 1 completion record

`scripts/extract-worktree-live-attribution-fixtures.mts` now discovers the
sources through structural joins rather than committed private ids: current Git
identities select the main/grid/UI topology, the fixed-cutoff Codex corpus
selects the unique 0.151.0 rollout ending in the recorded UI-worktree command
tail, and the per-session proxy thread id joins that rollout to the matching
Agent Code recording and workspace entry.

The checked-in corpus contains five JSON fixtures, a provenance/privacy
manifest, and an aggregate shape census. At the fixed provider/session cutoff
it records 26 direct Claude tool paths in the grid worktree, both required
Claude conflict rows, and a Codex tail of 12 consecutive completed UI-worktree
commands. A fixed source-order prefix of 128 proxy requests is zstd encoded,
decodes successfully, and matches one exact rollout thread/session id in all
128 cases; the current proxy `request_shape` is absent in all 128. The matching
live Agent Code recording contains zero `session:jsonl-entries` despite 7,403
semantic events and 2,358 screen events through the same cutoff.

The proxy fixture keeps the real zstd/parser boundary but contains only a
tokenized `client_metadata` object that the exporter deterministically
recompresses and immediately round-trips. Other fixtures discard prompts,
assistant prose, screen/semantic payloads, commands, tool results, raw ids, and
raw paths. The canonical sensitive-value scan, strict path/UUID/string gates,
explicit decoded-body inspection, and two consecutive byte-identical
extractions pass. Repository typecheck includes the exporter and passes; the
test-contract and whitespace checks also pass. No Stage 2 tests or production
behavior were added during this stage.

## Stage 2 — record ownership semantics as failing contracts

**Produces**

- A checked-in ownership catalog mapping each recorded source to one of:
  exact identity, direct active evidence, bootstrap/affinity evidence,
  diagnostic-only metadata, or explicit non-evidence.
- Failing tests, written before production changes, for:
  - Claude same-envelope cwd/tool disagreement;
  - Claude matched-path/stale-branch disagreement;
  - Codex zstd proxy metadata -> exact rollout identity;
  - exact-id mismatch and concurrent-sibling negatives;
  - the recorded no-JSONL live session becoming tailed after exact proof;
  - async Git-cache arrival plus real SessionFeed entries producing the runtime
    state consumed by `WorktreeBadge`; and
  - direct active versus weighted primary behavior.

**Verified by**

- Every positive expectation names a Stage 1 fixture id and catalog row.
- Negative ownership cases reuse recorded concurrent/subagent rollout fixtures
  and mechanically mutated identity fields; invented provider envelopes are not
  presented as recordings.
- Tests demonstrably fail against `origin/main` for the intended reason. Their
  fixtures and expectations are reviewed before production implementation.

**Why separate**

If implementation and tests are written together, the same invented precedence
can bless itself. The catalog makes human-approved ownership policy explicit,
while the red suite proves the current substrate violates recorded reality.

**Reality check**

The expected Claude precedence comes from 30 real worktree tool paths and two
observed disagreement shapes. The Codex exact-identity contract comes from 253
of 253 requests matching the actual rollout, while the live-hook test uses the
recorded absence-then-arrival order instead of a preconstructed final state.

## Stage 3 — restore exact Codex rollout ownership

**Produces**

- A content-safe proxy request projection that recognizes the recorded zstd
  envelope and exposes only validated identity fields needed for ownership.
- One exact-identity handoff into the existing rollout locator/coordinator,
  with the same process-wide path lease and cleanup rules used by resume.
- Normal `rollout-entry` delivery from the proved 0.151.0 rollout, which keeps
  worktree extraction, committed feed rendering, and provider-id discovery on
  their existing shared path.

**Verified by**

- Stage 2 exact-identity and no-JSONL recovery contracts turn green one at a
  time.
- Filename UUID, `session_meta.id`, and proxy thread id must all agree before a
  tail opens.
- Recorded concurrency, duplicate-tail, stop-during-acquire, resume, malformed
  compression, oversized-body, and no-proxy contracts remain fail closed.
- The affected fixture emits the original rollout records; no worktree-specific
  shortcut is added to proxy semantic tool events.

**Why separate**

The renderer cannot safely repair a transcript it never receives, and parsing
arbitrary semantic tool arguments would repeat the MCP-child-cwd class of bug.
Restoring exact provider ownership fixes the missing authoritative stream at its
source and benefits every committed-rollout consumer, not only this badge.

**Reality check**

The authority is the exact id repeated in every recorded private proxy request
and independently confirmed by the rollout filename and `session_meta`. Cwd and
file recency are deliberately absent from the proof.

## Stage 4 — canonicalize provider activity against Git identity

**Produces**

- Shared reconciliation rules in `src/shared/work-context/` that apply the
  approved branch and activity precedence once for live and historical users.
- Provider adapters that emit evidence in an order/shape that cannot let a
  generic envelope seed erase direct evidence from the same record.
- Diagnostic preservation of the provider-reported branch when it disagrees,
  without letting it become the canonical label.

**Verified by**

- Both recorded Claude contracts turn green without changing fixture values.
- Existing Codex command/FileChange, MCP negative, Claude worktree-state,
  detached-worktree, longest-root, tracker retention, and historical parser
  tests remain green.
- A matched detached identity stays branchless rather than inheriting a stale
  provider branch.

**Why separate**

Codex transcript ownership answers which stream belongs to the pane; worktree
reconciliation answers what that stream means. Mixing them would teach the
rollout coordinator about UI branch labels or make the shared tracker depend on
proxy mechanics.

**Reality check**

The rule is constrained by the recorded Claude conflict rows and current Git
identity, not by a new guessed provider field. No unobserved Claude exit shape
is added as a "real" fixture.

## Stage 5 — isolate and prove live renderer reconciliation

**Produces**

- A small module under `src/renderer/src/workspace/work-context/` that owns the
  asynchronous Git identity cache, bounded recent raw records, replay on cache
  arrival, fallback application, and canonical runtime projection.
- One consumer: `useIpcSubscriptions`. It forwards SessionFeed records and
  applies returned runtime patches; it no longer owns worktree arbitration
  inline inside its 2,000+ line subscription effect.
- Bounded, metadata-only debug output recording cache state, evidence count,
  active/primary source, and projection outcome. It must not record prompts,
  command bodies, or raw provider records.

**Verified by**

- The Stage 2 real SessionFeed/cache-order fixture turns green through the new
  module and `useIpcSubscriptions` harness.
- Tests cover cache-before-entry, entry-before-cache, in-flight coalescing,
  failed probe/retry, newly created worktree after stale cache, session teardown,
  and the affected Codex/Claude sequences.
- The final badge receives active UI/grid worktree state; Worktrees live-agent
  projection receives the same canonical context.

**Why separate**

PR #663's direct tracker projection passed while the real live path failed.
Keeping cache/replay ownership buried inside the subscription megafile makes
that gap easy to repeat and impossible to test without mounting unrelated feed
machinery. The isolated module emits one clean runtime result and knows nothing
about React chrome.

**Reality check**

The state transitions and debug fields are derived from the recorded live
channel ordering. This stage is not allowed to invent a second provider parser
or choose a rollout file.

## Stage 6 — cross-boundary and UI verification

**Produces**

- A verification report tied to fixture ids, issue updates for #658/#685, and a
  single resolving PR that remains unmerged until explicit user confirmation.
- If shared parser semantics change historical output, one centralized derived
  index version bump; otherwise no ceremonial cache invalidation.

**Verified by**

- Fixture extraction/privacy/determinism, focused package/shared/main/renderer
  suites, typecheck, test contract, deterministic full tests, and package/build
  verification pass.
- A development build is exercised with one Claude and one Codex session using
  the recorded transition shapes. Badge text/title, Dispatch, tiled panes, and
  Worktrees projection agree.
- Review finds no provider grammar in UI components, no renderer-side rollout
  selection, no arbitrary semantic-tool-argument parsing, and no weakening of
  ownership negatives.

**Why separate**

Green unit tests do not prove that the Electron bridge, cache timing, runtime
projection, and visual consumer agree. Packaging and privacy are independent
release gates, and issue/PR state is part of the requested workflow.

**Reality check**

The report must name the Claude conflict fixture, Codex 0.151 exact-identity
fixture, no-JSONL live recording, and final end-to-end state. Test counts alone
are not evidence.

## What is isolated

The hard component is **authoritative provider activity plus asynchronous Git
identity -> one canonical live worktree result**.

It is split at two existing ownership boundaries rather than duplicated:

1. `packages/codex-headless/src/transcript/` owns exact rollout identity,
   process-wide leases, and physical tailing. A proxy-identity adapter may feed
   this boundary, but only `CodexHeadless` consumes the resulting ownership
   capability.
2. `src/shared/work-context/` owns pure provider-evidence/Git reconciliation.
   `src/renderer/src/workspace/work-context/` owns only live cache/order/replay
   and emits canonical runtime state to `useIpcSubscriptions`.

Forbidden dependencies:

- renderer and UI files may not inspect Codex/Claude raw discriminators or
  select rollout files;
- proxy/rollout ownership may not import renderer state, Git badge policy, or
  worktree scoring;
- `WorktreeBadge`, Dispatch, and Worktrees views may not arbitrate provider
  branch versus Git branch or active versus primary beyond consuming the
  canonical fields defined for that surface;
- provider adapters may not recursively mine arbitrary cwd/path fields; and
- historical consumers may not implement a second copy of live precedence.

## Unknowns

1. The current proxy corpus proves exact metadata for 253/253 Codex 0.151.0
   requests in one affected session. Availability across older/newer CLI
   versions, API-key mode, proxy-disabled sessions, and requests over the 2 MiB
   forensic-body cap is not yet enumerated.
2. All affected request bodies are zstd encoded and the current parser therefore
   emits no `request_shape`. Whether upstream can also send uncompressed or a
   different supported encoding must be cataloged before accepting more than
   the observed forms.
3. The exact timing between the first proxy request, rollout creation,
   coordinator candidate observation, and session stop is recorded but not yet
   reduced into a checked-in ordering fixture.
4. The observed Claude `gitBranch` behaves like launch metadata after cwd/tool
   movement. We do not yet know whether any current Claude version updates that
   field after a real checkout/branch switch within one process.
5. Git branch identity can change while a worktree path remains mounted, and
   detached worktrees legitimately have no branch. Cache refresh semantics for
   those transitions need recorded or Git-created evidence rather than a stale
   branch fallback.
6. The renderer worktree cache is effect-local and absent from current debug
   bundles. Existing recordings prove the affected Codex stream never reached
   it, but Stage 5 cache-race coverage may reveal a second independent failure
   after transcript delivery is restored.
7. The historical index may change when canonical branch precedence changes;
   whether that requires a version bump depends on Stage 2 replay output and is
   intentionally not assumed now.

An unknown that becomes relevant must be resolved by a recorded fixture or an
explicit semantic decision. It must not be handled by appending a speculative
conditional.

## Fixture plan

| Fixture family | Real source | Mechanical minimization/redaction | First consumer |
|---|---|---|---|
| Claude cwd/tool/branch conflict | Exact reported Claude JSONL | Preserve envelope order, cwd topology, branch disagreement, and tool discriminator/path class; tokenize ids/paths and remove all prose/tool payloads | Stage 2 shared reconciliation tests |
| Codex complaint-time activity | Exact 0.151.0 rollout | Preserve session meta plus ordered cwd-bearing completed items through fixed cutoff; tokenize paths/ids and remove commands/content | Stage 2 parser/live tests |
| Missing live rollout delivery | Matching Agent Code session recording, feed debug, and workspace snapshot | Preserve channel kinds/counts/order, unsupported reason, launch cwd class, and absence of JSONL; remove screen/semantic payloads | Stage 2 live boundary test |
| Exact proxy identity | Matching per-session proxy log | Decode recorded zstd body, retain content encoding and identity equality topology, tokenize ids, discard inputs/tools/prompts, then deterministically recompress the minimized object | Stage 2/3 proxy ownership tests |
| Git identities | `git worktree list --porcelain` at capture | Keep only tokenized main/grid/UI paths, branch topology, detached flag, and relative nesting | Stage 2/4/5 matching tests |
| Ownership negatives | Existing recorded concurrent 0.149.1 and exact subagent fixtures plus the new exact-id fixture | Reuse recorded structure; derive mismatches mechanically and label them mutations, not recordings | Stage 2/3 lease and sibling tests |

Tests are written in Stage 2 after Stage 1 artifacts are reviewed and before
production implementation. A fixture may be minimized only by the checked-in
extractor. Failing tests against recorded fixtures are not deleted, weakened,
or rewritten to match implementation.

## Approval gate

Approval authorizes Stage 1 only and confirms the four source-of-truth decisions
above. After Stage 1, its corpus and privacy report are presented before Stage 2
tests. If the census disproves the stage shape—especially proxy identity
availability or ownership timing—this document is revised and approval is
requested again. No implementation is patched forward around a failed premise.
