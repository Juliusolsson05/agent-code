# Cross-Provider Transcript Engine — Decomposition and Implementation Plan

**Status:** In progress. This file is the first artifact on the implementation
branch; the branch is intended to carry the complete implementation and Agent
Code cutover, not merely this plan.

**Date:** 2026-07-20

**Primary branch:** `feat/agent-transcript-parser-v2`

**Primary worktree:** `.worktrees/agent-transcript-parser-v2`

**Package branch:** `feat/agent-transcript-parser-v2` in the
`agent-transcript-parser` submodule

**Baseline:** Agent Code `origin/main` at `dd0005e3`; parser package
`origin/main` at `dd7ff475`

**Method:** [staged decomposition](https://github.com/Juliusolsson05/staged-decomposition).
Every stage below names an artifact, an independent verification, the reason it
cannot be collapsed into the next stage, and the real evidence it uses.

## What this plan commits us to

This is a ground-up replacement of the transcript parser, translator, clone,
and rewind substrate. It is not a campaign to keep adding conditionals to
`toClaude.ts` and `toCodex.ts`. The new implementation lives under `src/v2/`
while it is developed and proven. Once Agent Code has cut over, the old
converter, codec, permissive-type, neutral-wrapper, clone, rewind, and resume
repair structures are deleted rather than retained as a second architecture.

The provider-neutral conversation protocol is the hub of the architecture, not
merely a temporary Claude/Codex interchange type. Each provider implements one
inbound decoder and its own outbound archive and native-resume projectors. A
cross-provider operation is always `source -> conversation -> target`; provider
adapters never translate directly to one another. That changes growth from up
to `N * (N - 1)` pairwise translators to a linear adapter family per provider,
so adding a future provider does not require changing any existing adapter.

The exception is the ghost subsystem. Ghosts solve provisional-render ownership
and journal recovery, not provider transcript translation. Their behavior is a
production contract used across main, renderer, and remote-client processes.
The existing `agent-transcript-parser/ghost` export is frozen and characterized;
it is not semantically rewritten as part of v2.

The branch is complete only when:

1. the local real-transcript corpus has been structurally catalogued;
2. privacy-reviewed fixtures trace to real observations or pinned upstream
   source rules;
3. v2 parses, classifies, analyzes, archives, translates, clones, and rewinds;
4. native-resume projections are separate from archive translations;
5. Agent Code uses v2 for every transcript operation;
6. the confirmed Codex rewind-address mismatch is removed;
7. the displaced v1 implementation is deleted;
8. ghost behavior remains unchanged;
9. package and Agent Code gates pass from built artifacts, not only source
   aliases; and
10. the package PR and the primary Agent Code PR are open with evidence and
    rollback notes.

## A — what exists and is trusted

Trust is deliberately narrow. Existing behavior is evidence, not automatically
correct behavior.

- Agent Code's production consumer order and filesystem responsibilities:
  `src/main/providerSwitch/**` and the renderer provider-switch actions.
- The parser's existing behavior as a **compatibility oracle only**:
  `packages/agent-transcript-parser/src/**` at `dd7ff475`.
- The ghost API and journal behavior as a frozen production contract:
  `packages/agent-transcript-parser/src/ghost.ts`,
  `src/renderer/src/session-runtime/ghosts.ts`, and
  `src/main/ghostJournal.ts`.
- Codex persisted-record, discovery, and reconstruction behavior at vendored
  upstream commit `8035cb03`, when a claim is explicitly pinned to that commit.
- Real local transcript files as observations of what provider versions actually
  wrote. They are not automatically proof of what every version accepts on
  resume.
- Existing synthetic fixtures and v1 outputs as regression/compatibility inputs,
  never as independent proof of native correctness.

### Real corpus available at plan time

The earlier investigation intentionally did not inspect personal provider
stores. A subsequent metadata-only census, explicitly authorized for this
rewrite, established the actual scale:

| Corpus | Files | Raw JSONL records | Bytes |
|---|---:|---:|---:|
| Claude main conversations | 309 | 18,733 | 546.8 MB |
| Codex rollout conversations | 1,513 | 115,615 | 2.84 GB |
| **Primary conversation corpus** | **1,822** | **134,348** | **3.39 GB** |
| Claude subagent transcripts | 1,350 | 9,385 | 332.7 MB |
| Other nested Claude JSONLs, not yet deduplicated | 139 | 19,714 | 557.7 MB |
| **All locally available JSONL** | **3,311** | **163,447** | **4.28 GB** |

Agent Code's durable worktree-activity index independently references 1,773
currently existing main transcripts: 269 Claude and 1,504 Codex, containing
216,694 extracted activity events. The difference from the live-directory count
is expected because the index is filtered and updated asynchronously.

These files are the discovery population. They are **not** all destined for Git.
They can contain prompts, source code, tool outputs, filesystem paths, secrets,
and third-party material. Raw local transcripts never become committed fixtures.

## D — observable end state

The v2 package exposes a pure, browser-safe transcript engine with these
observable properties:

1. Raw JSONL decoding preserves ordering, unknown records, omitted-versus-null
   distinctions, and malformed/partial-tail diagnostics.
2. Claude and Codex classifiers emit honest discriminated record families with
   an opaque escape hatch and evidence provenance for every rule.
3. Provider graph analysis reports identity, topology, tool-pair, compaction,
   replay-mutation, and continuation hazards without silently repairing them.
4. Archive translation and native-resume projection are different APIs and
   result types. A caller cannot accidentally mistake one for the other.
5. Every drop, demotion, synthesis, identity rewrite, repair, and unknown record
   appears in a structured report.
6. Clone and rewind operate on stable provider-native addresses produced by the
   same enumeration layer that the UI consumes.
7. Provider adapters do not import one another. Shared code cannot name a
   provider wire type.
   Adding a provider requires one decoder and its own output projectors, not
   branches for every provider already installed.
8. Filesystem paths, home directories, registries, IPC, pane replacement, and
   drafts remain owned by Agent Code.
9. Native claims name a provider/version/source profile and are verified at the
   correct acceptance layer: discovery, load, reconstruction, rendering, and
   append-after-resume are not conflated.
10. The root package API is backed by v2. The old v1 implementation is absent.
11. `agent-transcript-parser/ghost` retains its existing public and behavioral
    contract.

## Non-negotiable rules

1. **Enumerate before implementing semantics.** Corpus profiling and shape
   cataloguing precede classifiers and translators.
2. **Fixtures are causally independent.** Expected values may not be generated
   from v1 or v2. V1 may produce a separately labeled differential report.
3. **Unknown is data.** Unknown records remain opaque and reported; they are not
   silently dropped or converted into plausible assistant speech.
4. **Archive is not resume.** The two profiles have separate names, types,
   reports, and tests.
5. **Analysis is not repair.** Invariant detection precedes and is independent
   from projection policy.
6. **Provider isolation is structural.** Claude code never imports Codex code;
   Codex code never imports Claude code.
7. **Core is pure.** `src/v2/**` may not read files, inspect home directories,
   spawn CLIs, import Electron, or know Agent Code storage paths.
8. **Agent Code remains the host.** It plans paths and atomically commits files,
   then manages pane/process lifecycle.
9. **Ghost is frozen.** No transcript-v2 stage changes ghost lifecycle,
   reconciliation, visibility, persistence, TTL, or UUID semantics.
10. **No false version claims.** An observation from one Codex/Claude version is
    not silently generalized to every supported version.
11. **No raw personal data in Git or logs.** Structural profiling is value-free
    by default; fixture extraction requires explicit redaction and review.
12. **A failing real fixture is not weakened to make the suite green.** If the
    fixture falsifies the design, revise this decomposition rather than patching
    forward.

## Isolation and target layout

The hard part is provider-specific interpretation and projection. It is confined
to `src/v2/` with a single public composition boundary. During migration, only
the v2 entrypoint and explicit compatibility tests may reach both provider
adapters.

```text
packages/agent-transcript-parser/
  src/
    v2/
      jsonl/                 raw line decoding/encoding and diagnostics
      evidence/              provenance, profiles, and evidence labels
      claude/
        classify/            Claude-only record recognition
        analyze/             Claude-only graph/invariant analysis
        project/             Claude archive and resume output profiles
      codex/
        classify/            Codex-only record recognition
        analyze/             Codex-only history/discovery analysis
        project/             Codex archive and resume output profiles
      conversation/          provider-neutral semantic protocol
      translation/           composition through the semantic protocol
      operations/            stable prompt addresses, clone, and rewind
      report/                losses, repairs, unknowns, evidence, diagnostics
      index.ts               the one public v2 composition surface
    ghost.ts                 frozen existing subsystem
    ghost-sidecar.ts         only the minimum sidecar shape ghosts require
    index.ts                 final root exports backed by v2
  fixtures/
    v2/
      synthetic/             old fixtures, honestly relabeled
      observed/              minimized/redacted real structural cases
      source-derived/        pinned upstream contract cases
  testing/
    corpus/                  manifests, catalog tests, and local profilers
    contracts/               package and provider-profile tests
    compatibility/           temporary v1 differential harness
```

### Forbidden imports

- `src/v2/claude/**` → `src/v2/codex/**`
- `src/v2/codex/**` → `src/v2/claude/**`
- provider-neutral directories → provider-specific wire types
- `src/v2/**` → Node filesystem/process APIs, Electron, Agent Code, or ghost
- Agent Code renderer → provider projectors or transcript internals
- ghost modules → v2 translation, analysis, or projection
- v2 production modules → v1 implementation

The compatibility test harness is the sole temporary exception to the last
rule. An import-boundary test makes these constraints executable.

## Evidence and oracle ladder

Every manifest names which rung it occupies. A weaker rung cannot prove a
stronger claim.

1. **Observed wire evidence:** a privacy-reviewed structural reduction of an
   actual local provider transcript.
2. **Pinned upstream source/schema:** a rule tied to a commit or schema version.
3. **Controlled native observation:** a hermetic temporary provider home with
   discovery/load/append results retained in a manifest.
4. **Agent Code consumer behavior:** the current application's orchestration and
   failure semantics.
5. **Human-reviewed semantic expectation:** a product decision about an
   inherently lossy cross-provider mapping.
6. **Synthetic regression case:** useful for local edge mechanics, unable to
   prove provider reality.
7. **V1 compatibility observation:** describes migration impact only.
8. **Self-round-trip:** useful for internal consistency only.

## Stage decomposition

### Stage 0 — implementation line and decomposition

**Produces:** this plan; clean parent and package branches/worktree; recorded
baseline commits and corpus census.

**Verified by:** `git status`, submodule status, branch tracking, and review of
this document against the investigation artifact.

**Why separate:** without an explicit baseline, later fixture and compatibility
results cannot say which implementation or provider source they describe.

**Reality check:** current Git repositories, the completed nine-agent
investigation, and the metadata-only local corpus census.

### Stage 1 — privacy-safe corpus index

**Produces:** a read-only corpus profiler, manifest schema, provenance taxonomy,
and an ignored local catalog of structural fingerprints/frequencies across all
available transcripts.

**Verified by:** deterministic reruns, aggregate counts matching the filesystem
census, no scalar transcript values in profiler output, and privacy leak tests.

**Why separate:** classifiers built first would determine which shapes the
profiler can see, reproducing the original blind spot.

**Reality check:** the 3,311 local JSONLs and Agent Code's 1,773-entry activity
index. No new recorder is needed.

### Stage 2 — reviewed fixture corpus

**Produces:** minimized/redacted observed fixtures, pinned source-derived cases,
reclassified synthetic fixtures, and one manifest per case.

**Verified by:** schema validation, provenance review, redaction scans,
source-hash traceability, and confirmation that expected assertions were not
generated by an implementation under test.

**Why separate:** tests written directly against private raw transcripts are not
portable; invented checked-in fixtures are not independent evidence.

**Reality check:** representatives selected from Stage 1 clusters and rules read
from pinned provider source/schema.

### Stage 3 — raw JSONL substrate

**Produces:** lossless raw-line model, decoder, encoder, partial-tail handling,
and diagnostics.

**Verified by:** byte/line identity on observed fixtures, malformed-tail cases,
unknown-record preservation, and property tests limited to syntax—not semantics.

**Why separate:** provider classification must not own line parsing or erase
data before a record has been identified.

**Reality check:** actual line endings, malformed lines, large records, and
partial tails found by Stages 1–2.

### Stage 4 — provider classifiers and catalog

**Produces:** Claude and Codex discriminated record unions, opaque records,
evidence-labeled classification results, and catalog coverage reports.

**Verified by:** every observed fixture classifies; every unknown stays opaque;
frequency totals reconcile with Stage 1; source-derived Codex records match the
pinned contract.

**Why separate:** translation policy cannot be allowed to influence what a
record *is*.

**Reality check:** Stage 2 observed fixtures plus vendored Codex source. Claude
claims remain observation-scoped where no authoritative source exists.

### Stage 5 — graph and invariant analysis

**Produces:** provider-specific identity/tool/compaction/mutation graphs,
continuation diagnostics, and stable prompt-address enumeration.

**Verified by:** independently reviewed expected graphs for real fixtures;
address round trips; invariant reports that do not mutate inputs.

**Why separate:** detecting an incomplete tool call is objective; deciding how
to repair it for a target provider is policy.

**Reality check:** real session topology, tool cycles, compactions, approvals,
rollbacks, and duplicate event/response planes from the catalog.

### Stage 6 — archive projections

**Produces:** provider-specific archive/fidelity projections with bounded
provenance and explicit loss/demotion reports.

**Verified by:** observed semantic expectations, opaque preservation, bounded
provenance tests, and same-provider identity where that is an archive contract.

**Why separate:** archive output may preserve records that native resume must
remove; combining them creates ambiguous correctness.

**Reality check:** actual records without native equivalents and repeated-switch
growth measured from observed fixtures.

### Stage 7 — native-resume projections

**Produces:** versioned Claude and Codex resume profiles, repair policies, fresh
identity retargeting, and structured projection reports.

**Verified by:** discovery, load/reconstruction, and append-after-resume at each
claimed profile; source-backed Codex checks; controlled Claude observations.

**Why separate:** a JSON file can parse, appear in Agent Code, or render while
still being unusable by the native provider.

**Reality check:** pinned provider source and hermetic provider homes populated
from reviewed fixtures—not personal live homes.

### Stage 8 — clone and rewind operations

**Produces:** pure same-provider clone and rewind operations using stable prompt
addresses, strict-prefix selection, draft recovery metadata, and repair reports.

**Verified by:** enumeration and operation resolving the identical raw boundary;
native resume gates; characterization of existing Agent Code behavior.

**Why separate:** UI selection, prefix truncation, provider repair, identity
retargeting, and filesystem commit are different failure planes.

**Reality check:** real multi-message/image/compaction/tool fixtures and the
confirmed Codex filtered-ordinal versus raw-user-ordinal mismatch.

### Stage 9 — semantic cross-provider translation

**Produces:** explicit Claude↔conversation and Codex↔conversation adapters,
translation reports, archive compositions, and resume compositions.

**Verified by:** human-reviewed semantic expectations from real fixtures,
direction-specific native gates, and a v1 differential classified as preserved,
corrected, intentionally dropped, or unresolved.

**Why separate:** provider classification and native projection must be stable
before inherently lossy mapping policy is introduced.

**Reality check:** actual observed features and explicit product decisions,
never plausible-looking invented records.

### Stage 10 — Agent Code host integration

**Produces:** one main-process transcript service wrapping v2; updated switch,
duplicate, rewind, history, and prompt-address consumers; host-owned atomic
writes and pane lifecycle.

**Verified by:** adapter contract tests, failure-before-replacement tests,
source-preservation tests, built-package tests, renderer integration tests, and
direction-by-direction shadow comparisons.

**Why separate:** package correctness must not absorb Electron/storage policy,
and application behavior must remain rollbackable while v2 stabilizes.

**Reality check:** current production consumer call sites and local sessions used
through Agent Code.

### Stage 11 — ghost freeze and compatibility proof

**Produces:** explicit ghost import boundary, characterization tests, and proof
that v2 projections neither translate nor persist ghost records.

**Verified by:** lifecycle, reduction, reconciliation, journal, visibility, and
package-export tests against the existing behavior.

**Why separate:** ghost correctness is a separate ownership problem. Folding it
into translation would multiply the cutover blast radius.

**Reality check:** current renderer/main usage and production journal semantics.

### Stage 12 — destructive cutover and v1 removal

**Produces:** root exports backed by v2, deleted v1 implementation, updated docs
and package metadata, no stale source aliases, and linked package/parent PRs.

**Verified by:** no production imports of v1, no forbidden files/modules,
package tarball tests, full package and Agent Code checks, clean clone/submodule
checkout, and PR CI.

**Why separate:** deletion before consumer and native gates would remove the
rollback/reference path; deletion after the gates prevents permanent dual
architecture.

**Reality check:** every real Agent Code consumer has moved, shadow differences
are classified, and the package works from its published artifact shape.

## Detailed implementation checklist

### Phase 1 — plan, manifests, and corpus discovery

- [ ] Add the fixture-manifest schema and evidence-strength taxonomy.
- [ ] Add a structural fingerprint that removes scalar values while retaining
      key paths, JSON value kinds, low-cardinality discriminators, ordering
      planes, and provider profile.
- [ ] Add a read-only local profiler that accepts explicit roots, never defaults
      to or writes provider homes, and writes only to an explicit ignored output.
- [ ] Profile Claude main, Claude subagent, nested Claude, and Codex separately.
- [ ] Deduplicate exact structural signatures and identify likely duplicate
      transcript files without exposing identifiers.
- [ ] Produce frequency-ranked catalogs and unknown-shape candidates.
- [ ] Select and manually review fixture candidates from every load-bearing and
      rare-but-real cluster.

### Phase 2 — real fixture corpus

- [ ] Relabel the eight existing fixtures as synthetic compatibility cases.
- [ ] Build the redaction/minimization tool as an explicit, review-required
      workflow rather than an automatic truth generator.
- [ ] Add observed Claude fixtures covering every catalogued record/block family.
- [ ] Add observed Codex fixtures covering every catalogued rollout/item family.
- [ ] Add source-derived Codex discovery/reconstruction positive and negative
      cases pinned to `8035cb03`.
- [ ] Add privacy tests that reject likely home paths, repository paths, secrets,
      high-entropy tokens, unreviewed prompts, and missing provenance.

### Phase 3 — v2 substrate and classification

- [ ] Implement raw line decode/encode and diagnostics test-first.
- [ ] Implement evidence/provenance primitives.
- [ ] Implement Claude classification from the catalog.
- [ ] Implement Codex classification from the catalog.
- [ ] Add opaque record handling and exhaustive reports.
- [ ] Add import-boundary and browser-safety tests.

### Phase 4 — analysis and stable addressing

- [ ] Implement Claude identity/parent/tool/compaction analysis.
- [ ] Implement Codex metadata/event/response/tool/mutation analysis.
- [ ] Define provider-native prompt addresses that identify a raw record rather
      than a UI-filtered ordinal.
- [ ] Make prompt enumeration return those addresses.
- [ ] Prove address resolution is stable across filtering and rendering.

### Phase 5 — projections and operations

- [ ] Implement bounded archive provenance without recursive sidecar growth.
- [ ] Implement archive projections with explicit loss reports.
- [ ] Implement versioned Codex native-resume projection.
- [ ] Implement observation-scoped Claude native-resume projection.
- [ ] Consolidate provider repair policy so clone, rewind, and translated resume
      use the same named invariants where they genuinely coincide.
- [ ] Implement clone for Codex, then Claude.
- [ ] Implement rewind for Codex, then Claude, using stable addresses.

### Phase 6 — semantic translation

- [ ] Define the provider-neutral conversation protocol from observed semantics.
- [ ] Implement Claude→conversation without importing Codex.
- [ ] Implement Codex→conversation without importing Claude.
- [ ] Implement conversation→provider archive projections.
- [ ] Implement conversation→provider resume projections.
- [ ] Require a report for every non-isomorphic mapping.
- [ ] Run and classify the v1 differential; never force blanket equality.

### Phase 7 — Agent Code cutover

- [ ] Add a single host adapter that owns parser invocation but no provider
      semantics.
- [ ] Move provider switch to the v2 resume API one direction at a time.
- [ ] Move duplicate to v2 clone.
- [ ] Move prompt picker and rewind to shared stable addresses.
- [ ] Keep filesystem resolution and atomic writes in main.
- [ ] Preserve typed failure behavior so a failed projection never replaces a
      live pane.
- [ ] Add shadow reports during development and remove unexplained differences.

### Phase 8 — ghost freeze, deletion, and documentation

- [ ] Characterize ghost public exports and behavior before moving any shared
      sidecar code.
- [ ] Split the minimum ghost sidecar dependency from translation provenance.
- [ ] Prove v2 ignores ghost records at its boundary.
- [ ] Delete v1 converters, codecs, neutral wrapper, clone, rewind, permissive
      types, tests that merely bless v1, and stale scripts/docs.
- [ ] Point root exports to v2 and retain the frozen `/ghost` subpath.
- [ ] Rewrite the package README around evidence profiles and honest guarantees.
- [ ] Add an evergreen Agent Code design doc only if the final host/package
      ownership differs from existing documented architecture.

### Phase 9 — verification and PR delivery

- [ ] Package: contract, typecheck, unit, corpus, system, coverage, build, and
      tarball/package tests.
- [ ] Agent Code: contract, typecheck, unit, system, renderer, package, and build
      tests relevant to the cutover.
- [ ] Controlled native Codex discovery/load/append checks in a temporary home.
- [ ] Controlled native Claude checks for the explicitly supported profile.
- [ ] Manual Agent Code switch, duplicate, rewind, failure, and rollback checks.
- [ ] Push the package branch and open the reviewable package PR.
- [ ] Commit the package pointer and integration on the parent branch.
- [ ] Push the parent branch and open the primary Agent Code PR linking the
      package PR, evidence catalog, supported profiles, and rollback plan.

## Go/no-go gates

- No classifier code until the corpus index exists and reconciles with the
  filesystem census.
- No semantic expected output generated by v1 or v2.
- No provider-native rule without a versioned source or observation label.
- No archive API accepted where a native-resume result is required.
- No Codex rewind cutover until picker and operation share one address.
- No Claude native-resume claim broader than the evidence profile.
- No production cutover with unexplained shadow differences.
- No v1 deletion until every Agent Code consumer is on v2 and rollback artifacts
  exist.
- No ghost semantic change in this branch.
- No raw personal transcript, prompt, path, secret, or tool output committed.

## Known unknowns and decisions that may stop a stage

- Which exact Claude CLI versions the local observations span and which profile
  Agent Code promises to support.
- The minimum Claude resume envelope and whether provider rewrites preserve
  unknown provenance fields.
- Whether archive provenance stores complete redacted source records, hashes
  plus external bundles, or only structured loss receipts.
- Which non-isomorphic provider-control records should become visible semantic
  content versus explicit omissions.
- Whether native continuation checks may make networked next-turn calls or must
  stop at local discovery/reconstruction.
- Supported Codex version range and its relationship to vendored `8035cb03`.
- Title behavior for clone/rewind and provider-native listing/index side effects.
- The classification of the 139 nested Claude JSONLs and whether they are
  independent evidence or duplicates/import artifacts.

When one of these changes observable product semantics, implementation stops
for a human decision. It is not inferred from v1 simply because v1 chose
something.

## PR topology

`packages/agent-transcript-parser` is a Git submodule. GitHub cannot show its
source diff inside the parent Agent Code PR; the parent diff contains only a
gitlink change. Therefore the complete review surface necessarily consists of:

1. a package PR in `Juliusolsson05/agent-transcript-parser` containing v2 and
   the removal of v1; and
2. the primary Agent Code PR in `Juliusolsson05/agent-code` containing this
   plan, consumer integration, tests, documentation, and the reviewed package
   commit pointer.

The branch/worktree names describe the implementation, not this plan file. The
plan is an execution artifact on that implementation line, exactly as requested.
