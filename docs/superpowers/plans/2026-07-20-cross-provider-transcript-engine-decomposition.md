# Cross-Provider Transcript Engine — Decomposition and Implementation Plan

**Status:** Implementation complete. Hands-on Agent Code smoke testing and final
remote CI review remain.

**Date:** 2026-07-20

**Implementation line:** linked feature branches in Agent Code and the
`agent-transcript-parser` submodule. Branch and worktree names are development
coordinates, not package architecture or public API.

**Baseline:** Agent Code `origin/main` at `dd0005e3`; parser package
`origin/main` at `dd7ff475`.

**Method:** [staged decomposition](https://github.com/Juliusolsson05/staged-decomposition).
Each stage has its own artifact, evidence source, and acceptance gate so a green
downstream test cannot silently excuse a weak upstream assumption.

## Goal

Replace the original pairwise transcript converter with one evidence-driven
engine built around a provider-neutral conversation document:

```text
Claude ─┐
Codex  ─┼─> ConversationDocument ─> Claude / Codex / future provider
Future ─┘
```

Every provider owns one inbound decoder and its archive/native-resume
projectors. Provider adapters never translate directly to one another. Adding a
provider therefore adds one adapter family rather than a new translator for
every existing provider.

The replacement covers parsing, classification, graph analysis, archive
projection, native-resume projection, translation, clone, rewind, and the Agent
Code host integration. The displaced pairwise implementation is deleted rather
than retained as a parallel architecture.

Ghosts are the deliberate exception. They are a provisional-render ownership
ledger used across main, renderer, and remote-client processes—not durable
conversation semantics. Their existing behavior is frozen behind the explicit
`agent-transcript-parser/ghost` export.

## Evidence population

A metadata-only census established the discovery population without printing
private transcript values:

| Corpus | Files | Raw JSONL records | Bytes |
|---|---:|---:|---:|
| Claude main conversations | 309 | 18,733 | 546.8 MB |
| Codex rollout conversations | 1,513 | 115,615 | 2.84 GB |
| Claude subagent transcripts | 1,350 | 9,385 | 332.7 MB |
| Other nested Claude JSONLs | 139 | 19,714 | 557.7 MB |
| **Total local JSONL** | **3,311** | **163,447** | **4.28 GB** |

Raw local transcripts can contain prompts, code, paths, secrets, and third-party
material. They never enter Git. Checked-in fixtures are minimized,
value-redacted structural observations with manifests that state exactly what
each case proves.

## Observable end state

1. JSONL decoding preserves order, unknown records, null-versus-omitted fields,
   and malformed/partial-tail diagnostics.
2. Claude and Codex classify into honest discriminated families with opaque
   fallbacks and evidence provenance.
3. Provider analysis reports topology, identity, tool pairing, compaction,
   mutation, and continuation hazards without mutating input.
4. `ConversationDocument` is the only semantic interchange shape.
5. Archive and native-resume projection are separate APIs and result types.
6. Every drop, demotion, synthesis, repair, identity rewrite, and unknown record
   appears in a structured report.
7. Clone and rewind use stable provider-native prompt addresses shared by the
   UI enumerator and the operation resolver.
8. Provider adapters do not import one another; neutral modules do not name
   provider wire types.
9. The package core is browser-safe and does not read homes, spawn CLIs, import
   Electron, or own storage paths.
10. Agent Code owns filesystem resolution, atomic writes, drafts, IPC, and pane
    lifecycle.
11. Native claims are tied to an upstream source coordinate or a controlled CLI
    observation and are tested at the correct acceptance layer.
12. The root package export is the canonical engine; `/ghost` is the only
    specialized public subpath.

## Canonical package layout

```text
src/
  claude/                 Claude classification, analysis, decoding, projection
  codex/                  Codex classification, analysis, decoding, projection
  conversation/           provider-neutral semantic protocol
  evidence/               provenance and structural fingerprints
  jsonl/                  exact transport and diagnostics
  operations/             stable addresses, clone, rewind
  projection/             shared projection contracts and bounded provenance
  report/                 explicit change reports
  translation/            neutral composition
  index.ts                one public engine surface
  ghost.ts                frozen provisional-render ledger
  ghost-sidecar.ts        minimum ghost-only wire vocabulary
fixtures/evidence/        reviewed evidence fixtures and manifests
testing/engine/           engine contracts and native compatibility probes
testing/corpus/           privacy-safe extraction and profiling tools
```

Forbidden dependencies are executable test contracts:

- `src/claude/**` must not import `src/codex/**` and vice versa.
- Neutral directories must not import provider-specific wire types.
- Engine modules must not import Node host APIs, Electron, Agent Code, or ghost.
- Agent Code renderer code must not import provider projectors.
- Ghost modules must not import translation, analysis, or projection.
- Production code must not import the displaced pairwise implementation.

## Evidence ladder

A weaker rung cannot prove a stronger claim:

1. privacy-reviewed observed wire evidence;
2. pinned upstream source or schema;
3. controlled native-provider observation;
4. Agent Code consumer behavior;
5. human-reviewed semantic expectation;
6. synthetic regression case;
7. displaced-implementation compatibility observation; and
8. self-round-trip consistency.

## Staged decomposition

### 1. Corpus and fixtures

Produce a read-only structural profiler, evidence manifests, redaction tooling,
and reviewed fixtures. Verify deterministic counts and privacy rules before any
classifier becomes the lens through which the corpus is seen.

### 2. JSONL transport

Build exact raw-line decoding/encoding and diagnostics. Syntax handling stays
independent from provider meaning so unknown data cannot be erased early.

### 3. Provider classification

Classify Claude and Codex records from observed families and pinned source
contracts. Unknown records remain opaque; projection policy cannot influence
what a record is.

### 4. Analysis and stable addressing

Build provider-specific graphs and prompt enumeration without repair. The
prompt picker and rewind operation must resolve the same raw record address.

### 5. Archive projection

Preserve provider-native data and bounded provenance with explicit reports.
Archive output is not accepted as proof of native resumability.

### 6. Native-resume projection

Emit only the subset accepted by a named provider profile. Validate discovery,
load/reconstruction, rendering, and local append independently.

### 7. Neutral translation, clone, and rewind

Compose provider decoders and projectors through `ConversationDocument`. Apply
shared stable-address and native-repair contracts without pairwise adapters.

### 8. Agent Code integration

Move switch, duplicate, prompt enumeration, and rewind into one main-process
adapter. Preserve host-owned writes and failure-before-pane-replacement
semantics.

### 9. Ghost freeze

Characterize the existing ghost lifecycle, isolate its minimum sidecar types,
and prove conversation decoding/projection excludes valid ghost records.

### 10. Destructive cutover

Point the root export at the canonical engine, remove the displaced pairwise
source/tests/scripts, flatten development-only directory conventions, update
the package pointer, and verify both repositories from built artifacts.

## Completed implementation checklist

- [x] Profile and structurally catalog the authorized local transcript corpus.
- [x] Add redacted observed fixtures, manifests, and privacy gates.
- [x] Implement exact JSONL transport and diagnostics.
- [x] Implement evidence-backed Claude and Codex classification.
- [x] Implement provider graph analysis and stable prompt addresses.
- [x] Define the provider-neutral conversation protocol.
- [x] Implement provider decoders without cross-provider imports.
- [x] Implement bounded archive projectors and structured loss reports.
- [x] Implement source-pinned Codex native-resume projection.
- [x] Implement observation-scoped Claude native-resume projection.
- [x] Implement same-provider clone and rewind using stable addresses.
- [x] Implement cross-provider composition through the neutral protocol.
- [x] Move Agent Code switch, duplicate, picker, and rewind to the engine.
- [x] Characterize and isolate the frozen ghost subsystem.
- [x] Delete the displaced pairwise implementation and stale artifacts.
- [x] Make the replacement the canonical source/test/fixture/public layout.
- [x] Run package and Agent Code contract, type, test, build, and package gates.
- [x] Run installed Codex and Claude native-compatibility gates.
- [x] Push linked package and Agent Code PR branches.
- [ ] Complete hands-on Agent Code switch, duplicate, rewind, failure, and
      rollback smoke testing.
- [ ] Confirm final package and parent CI after the canonical-layout commit.

## Verification snapshot

Verified locally on 2026-07-20:

- package `npm run check`: 21 test files, 66 tests, typecheck, build, and packed
  artifact validation;
- installed Codex CLI 0.144.6: discovery, reconstruction, and local append
  through app-server;
- installed Claude Code 2.1.215: discovery, load, and interactive rendering of
  projected history without submitting a model turn; and
- Agent Code `npm run check`: contract, typecheck, 212 test files, 1,195 tests,
  production main/preload/renderer/remote builds, hotkey helper, and packaged
  entry-point validation.

The planned output differential and runtime shadow-write mechanism were retired
rather than shipped. The displaced converter mixed archive and native-resume
semantics, so its output could not be the correctness oracle for the split APIs.
Shadow-writing private live sessions would broaden the data surface without
proving provider acceptance. Git history remains the rollback/reference
artifact; redacted evidence, projection reports, host tests, and installed CLI
gates are the accepted cutover proof.

## Go/no-go rules

- No provider-native claim without a versioned source or observation profile.
- No archive result where a native-resume result is required.
- No Codex rewind cutover unless picker and operation share one address.
- No Claude claim broader than the controlled observation.
- No unexplained silent loss; every non-isomorphic mapping is reported.
- No ghost semantic change in this branch.
- No raw personal transcript, path, secret, prompt, or tool output in Git.
- No merge until package and parent CI pass the canonical-layout commit.

## Rollback and PR topology

`agent-transcript-parser` is a Git submodule, so the complete review surface is
necessarily two linked PRs: the package source PR and the Agent Code integration
PR. Agent Code pins the reviewed package commit exactly.

Rollback is the parent integration commit plus its submodule pointer. Reverting
that pair restores the previous host/package combination. The removed pairwise
implementation remains recoverable from package Git history; it is not kept in
the shipped tree as a second architecture.
