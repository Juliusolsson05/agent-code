# Worktree Context and Dispatch Labels — Staged Decomposition

> Status: awaiting explicit user approval. No implementation stage has begun.
>
> Issues: #658 (Codex worktree evidence) and #659 (Dispatch pane coordinate).

## Why staged decomposition applies

Agent Code is a large codebase and this is not a surface-only correction. The
same worktree result is derived from live provider events, historical provider
JSONL, Git worktree identity, weighted tracker state, and renderer projection.
Two providers emit different record grammars. The Dispatch bug is a second
source-reconciliation failure: visible rows and pane chrome currently derive
one coordinate from two orderings.

The first prototype demonstrated the danger this methodology names: plausible
hand-authored fixtures were easy to write immediately, including an imagined
FileChange array variant that does not occur anywhere in the measured current
corpus. That uncommitted prototype and its tests were discarded. Work resumes
fixture-first from recorded inputs.

This decomposition does **not** add collection infrastructure. The repository
already owns provider JSONL, workspace persistence, session recordings,
checked-in fixture families, extraction scripts, structure-only redaction, and
hard sensitive-value gates. This work reuses those sources and conventions.

## A — concrete trusted starting point

### Recorded sources

- Codex rollout JSONL under `~/.codex/sessions/`. These files are the provider's
  durable record of session metadata, turn context, completed commands, file
  changes, and MCP calls.
- Claude transcript JSONL under `~/.claude/projects/`. The vendored Claude
  contract defines `worktree-state` as last-wins, with a populated
  `worktreeSession` on enter and `null` on exit. Real transcripts also carry
  top-level `cwd`/`gitBranch` on conversation records.
- `~/.config/agent-code/workspace.json`. This is the actual persisted tab,
  session, detached-session, and Dispatch state that reproduces the reported
  D23 header mismatch.
- Git worktree status returned by the existing main-process Git boundary. Git
  remains the authority for which candidate paths are actual worktree roots.

### Existing reconciliation and cache boundaries

- `src/shared/work-context/extractors.ts` converts raw provider records into
  provider-neutral `WorktreeActivityEvent` values.
- `src/shared/work-context/matching.ts` maps path evidence to the longest Git
  worktree root.
- `src/shared/work-context/tracker.ts` maintains separate `active` and weighted
  `primary` contexts.
- `src/main/worktreeActivity/transcriptParser.ts` and
  `WorktreeActivityIndex.ts` reuse the shared events to build a derived compact
  historical index.
- `src/renderer/src/features/worktrees/lib/loadWorktreeDump.ts` projects live
  sessions onto Worktrees rows.
- `buildVisibleDispatchRows` is the trusted visible Dispatch ordering and label
  source. `paneLabelForSession` is the trusted tab-local grid coordinate source;
  it is not a Dispatch-global label source.

### Existing fixture infrastructure

- `testing/fixtures/README.md` reserves committed fixtures for literal provider
  shapes and reduced real recordings.
- Existing `scripts/extract-*-fixtures.*` scripts cite source records and write
  deterministic fixture manifests.
- `src/renderer/src/rendering/replay/redact.ts` provides structure-only
  redaction and `findSensitiveSurvivors`; fixture extraction must reuse the
  hard-gate discipline rather than invent a softer privacy check.

## Reality census before design

The following census inspected metadata/shape only, never prompt or assistant
content.

### Codex snapshot

Snapshot: `2026-08-26T21:38:22Z`, 15 rollout files from 2026-08-26.

| Recorded shape | Count | Relevant observation |
|---|---:|---|
| `session_meta` | 17 | `payload.cwd`; Git branch present under `payload.git.branch` in worktree examples |
| `turn_context` | 68 | `payload.cwd`; five observed worktree turns in the earlier classification pass |
| `thread_settings_applied` | 39 | cwd nested under `payload.thread_settings.cwd` |
| completed `CommandExecution` | 1,396 | every recorded cwd was a `file://` URL |
| completed `FileChange` | 102 | every recorded `changes` value was an object; 208 total changed paths in the preceding 100-record snapshot, max 8 paths/record |
| completed `McpToolCall` | 108 | eight carried an argument named `cwd`, proving generic cwd mining would misattribute child/target work |

The live corpus grows while agents run, so absolute counts will drift. The
shape ratios and cited fixture records are the durable evidence; extraction
will identify selected records by file plus stable record identity/timestamp,
not by "the Nth current match".

### Claude snapshot

- 11 real `worktree-state` enter records were found; all 11 include a branch.
- No real `worktree-state` exit record was found in the local corpus. Null exit
  remains a trusted upstream contract and existing production behavior, but no
  new test may pretend an invented null record is a recording.
- 26,208 real agent-code conversation records carry top-level `cwd`, confirming
  that the existing generic Claude cwd path is a common live shape.

### Dispatch snapshot

Running the existing selectors against the current persisted workspace gives:

- four project tabs;
- 25 visible Global Dispatch rows;
- 21 rows whose visible Dispatch label differs from their tab-local label; and
- the reported visible `D23` detached row currently recomputes as `D13` in pane
  chrome. Earlier in the same investigation, before another session joined the
  tab-local sequence, it recomputed as `D12`.

That movement is itself evidence: tab-local numbering is not a stable substitute
for the visible Dispatch coordinate.

## D — concrete observable end state

1. A live Codex agent executing or changing files in a Git worktree is shown on
   that worktree using evidence from the current recorded Codex grammar.
2. Historical Worktrees activity contains those same recorded commands and
   writes after the derived index reparses unchanged transcripts.
3. Raw provider shapes are reconciled once into provider-neutral events; neither
   renderer nor main-process index code understands Codex/Claude record syntax.
4. Claude's recorded worktree-enter and conversation-cwd behavior remains
   unchanged.
5. Generic MCP argument paths never become current-agent worktree evidence.
6. In Classic and Tiled Dispatch, pane chrome exactly repeats the selected
   visible row label. The real D23 fixture renders D23 even though tab-local
   ordering derives D13. Normal grid chrome keeps its tab-local label.
7. Every new provider/Dispatch regression test consumes a checked-in fixture
   extracted from the recorded sources above. No imagined provider record or
   synthetic D23 workspace is accepted as proof.

## Stage 1 — Reuse existing collection and publish the recorded fixtures

**Produces**

- `docs/decomposition/evidence/worktree-context/shape-census.md`, generated from
  the existing provider JSONL and persisted workspace, with counts, field
  presence, carrier type, and source citations.
- `testing/fixtures/worktree-context/` containing a small checked-in corpus:
  - an ordered current Codex worktree rollout window containing real
    `session_meta`, `turn_context`, `thread_settings_applied`, completed
    `CommandExecution`, completed multi-path `FileChange`, and the real negative
    `McpToolCall`-with-cwd shape;
  - a real Claude `worktree-state` enter and a real conversation-cwd record;
  - a reduced snapshot of the real persisted Global Dispatch state that keeps
    the D23/D13 divergence and the ordering inputs that produce it; and
  - `MANIFEST.md` mapping every fixture to its source record, observed count,
    transformation, and the claim it is allowed to prove.
- A narrow fixture exporter following the existing
  `scripts/extract-*-fixtures.*` pattern. It is an offline projection of data
  already collected by providers/Agent Code, not another recorder or runtime
  collection path.

**Verified by**

- Re-running the exporter against the cited source records is byte-identical.
- An independent `jq`/selector census agrees with the generated manifest.
- The existing sensitive-key gate is reused, plus hard failure if a home path,
  UUID/session id, unbounded free text, prompt content, or un-tokenized command
  argument survives.
- Each fixture retains the exact discriminator, nesting, sibling-field
  presence, ordering, path representation, and multi-path cardinality observed
  in source. Path prefixes and identities may be deterministically tokenized;
  their topology and `file://` representation may not be normalized during
  extraction because that is behavior under test.

**Why separate**

If fixture construction is merged into parser implementation, the implementer
will select or reshape inputs to fit the chosen code. This stage must be
reviewable and reproducible before any expectation or condition is written.

**Reality check**

It consumes only the existing Codex/Claude/workspace sources enumerated in A
and must reproduce the census above. It adds no instrumentation. An observed
shape missing from the fixture manifest blocks Stage 2 or receives an explicit
written reason it is irrelevant.

## Stage 2 — Write failing contracts against the recorded fixtures

**Produces**

- Fixture-driven shared tests that feed the real provider windows through
  `extractWorktreeActivityEvents` and the tracker in original order.
- A fixture-driven historical parser test proving the same Codex window
  produces compact indexed activity.
- A live Worktrees projection test whose tracker state comes from replaying the
  fixture, not from hand-constructing an `active`/`primary` object.
- A Dispatch regression that loads the reduced persisted workspace, proves
  `buildVisibleDispatchRows` yields D23 while `paneLabelForSession` yields D13,
  and then asserts the desired pane-chrome contract.

These tests are written and run on the unmodified implementation. The expected
Stage 2 artifact is a focused red suite whose failures correspond to #658 and
#659, while existing unrelated tests remain green.

**Verified by**

- Each failing assertion names its fixture and the observable contract, not an
  internal helper branch.
- Temporarily removing a fixture record changes or removes the corresponding
  failure, proving the test is driven by recorded input rather than duplicated
  setup.
- The negative real MCP record remains non-attributing.
- No production file changes in the Stage 2 commit.

**Why separate**

This is the causal boundary between evidence and implementation. Tests written
after Stage 3 would merely confirm choices already encoded in the adapter.

**Reality check**

All provider records and workspace ordering come from Stage 1. Builders remain
appropriate only for generic Git worktree identities around the recorded
events; they may not replace the literal provider or workspace fixture.

## Stage 3 — Isolate and normalize provider worktree evidence

**Produces**

- Provider-specific raw-record adapters under the existing
  `src/shared/work-context/` boundary (split below `provider-evidence/` only if
  the recorded catalog makes the current extractor too mixed to review).
- One normalized `WorktreeActivityEvent[]` output consumed by the existing
  tracker and historical parser.
- Local-file-URL handling at one shared path boundary, based on the recorded
  `file://` forms.

The adapter will implement recorded current shapes only. In particular, it
will not add a speculative FileChange array branch unless Stage 1 finds that
shape in a broader corpus.

**Verified by**

- Stage 2 provider and parser tests turn green one recorded carrier at a time.
- The MCP-with-cwd negative remains green throughout.
- A shape-coverage assertion proves every Stage 1 catalog row has either an
  emitted normalized event or an explicit non-evidence classification.

**Why separate**

Raw provider grammar is the hard reconciliation problem. Letting the renderer,
tracker, and historical index each recognize record shapes would recreate the
same drift that broke current Codex detection.

**Reality check**

The accepted discriminators, field paths, URL form, and FileChange collection
shape come directly from Stage 1 fixtures and frequencies. No recursive
"find anything named cwd" heuristic is allowed.

## Stage 4 — Apply normalized evidence to live and historical projections

**Produces**

- Historical cache invalidation tied to parser semantics, so version-2 entries
  cannot preserve a previously empty parse after the adapter changes.
- A Worktrees live-agent projection that answers "where active now" from the
  tracker state produced by fixture replay, while preserving weighted primary
  affinity for consumers that intentionally ask a historical question.
- No provider-specific conditions outside the shared work-context boundary.

**Verified by**

- Stage 2 historical and live projection tests turn green without editing their
  fixtures or expectations.
- A version-mismatch test proves the index drops only derived cache and leaves
  provider transcripts untouched.
- Replay of the ordered Codex fixture demonstrates the chosen active/primary
  result; a hand-authored state object is not accepted as the primary proof.

**Why separate**

Recognizing evidence and deciding how a product surface uses tracker state are
different semantics. Combining them would make provider adapters encode UI
policy and make future consumers inherit the wrong meaning of "primary."

**Reality check**

The current live bug exists because current records yield no normalized events
and the Worktrees projection reads weighted `workContext`. This stage is bound
to the exact ordered tracker output from the real fixture, not a guessed event
sequence.

## Stage 5 — Carry the canonical Dispatch row label into pane chrome

**Produces**

- A surface-label input on the shared leaf-render boundary.
- Classic Dispatch passes `activeRow.label`; Tiled Dispatch keeps and passes the
  selected row's exact label during lane resolution.
- Normal `TileTree` rendering supplies no surface label and retains
  `paneLabelForSession` behavior.

**Verified by**

- The Stage 2 real-workspace regression turns green: visible D23, pane D23,
  unchanged tab-local D13 derivation.
- The fixture's other mismatched rows are checked as a property: every rendered
  Dispatch pane label equals its selected visible row label.
- Existing grid pane-label tests remain green.

**Why separate**

Dispatch numbering is already correct. Recomputing it inside leaf chrome would
create a third ordering implementation. The parent surface must pass the row
identity it already selected.

**Reality check**

The input is the reduced real workspace with 25 rows and 21 mismatches, not a
manually constructed `DispatchAgentRow` labelled D23.

## Stage 6 — Cross-boundary verification and review

**Produces**

- Focused fixture/corpus results, full typecheck/test/package verification, a
  reviewed final diff, synchronized issues #658/#659, and one resolving PR.
- The implementation plan status updated to reflect the actual staged design
  and any decisions changed by the corpus.

**Verified by**

- Fixture extraction is deterministic and the privacy gates pass.
- Focused tests, repository test contract, typecheck, deterministic full suite,
  and package verification pass.
- PR review finds no provider-shape recognition in renderer/main consumers and
  no Dispatch label recomputation added outside existing selectors.
- CI is green. The PR remains unmerged pending explicit user confirmation.

**Why separate**

Local green tests do not prove fixture provenance, privacy, architectural
isolation, or packaging. Those are independent release gates.

**Reality check**

The verification report names fixture ids and census coverage, not only test
counts.

## What is isolated

The genuinely hard component is **raw provider record → normalized worktree
evidence**. It remains inside `src/shared/work-context/`; if Stage 1 confirms
the provider catalog warrants submodules, provider adapters live under
`src/shared/work-context/provider-evidence/` and are imported only by the
provider-neutral extractor facade.

Forbidden dependencies:

- renderer files may not import provider-evidence adapters or inspect rollout /
  Claude transcript discriminators;
- `src/main/worktreeActivity/` may not inspect provider-specific records beyond
  calling the shared extractor;
- provider adapters may not import workspace state, React, the activity index,
  or Worktrees UI policy; and
- pane leaf components may not rebuild Dispatch rows. They may receive the
  already-selected visible label from the Dispatch parent.

## Unknowns that Stage 1 must resolve

1. Whether older/current Codex versions elsewhere in the full local corpus
   contain additional completed-item spellings or FileChange collection shapes.
2. Whether multi-path FileChange records ever span more than one Git worktree;
   if so, object-key order is not automatically a valid "active now" authority.
3. Whether `session_meta`, `turn_context`, and `thread_settings_applied` ever
   disagree within one real ordered turn, and which later command/write record
   resolves that disagreement.
4. Whether a current (non-backup) Claude corpus contains explicit
   `worktree-state` enter/exit records. The local evidence currently contains
   enters only in the retained backup corpus.
5. Whether a real Claude worktree-state enter is followed by conversation cwd
   pointing at `originalCwd`; replay must reveal whether the existing tracker
   preserves explicit worktree intent or is overwritten.
6. Whether any relevant `file://` cwd uses a host, percent-encoded path, or
   non-macOS drive form. Only local macOS URLs are currently observed.
7. Whether the persisted workspace snapshot needs rehydration defaults beyond
   `pinnedSessionIds` to reproduce the exact app-visible row stream. The fixture
   exporter must apply the same production rehydration path where possible.
8. Which surface should use weighted primary context outside the Worktrees
   live-agent list. This fix must not globally swap `primary`/`active` semantics
   without recorded evidence for each consumer.

An unknown becoming relevant requires a recorded fixture or an explicit user
semantic decision. It must not be handled by appending a speculative branch.

## Fixture plan

| Fixture family | Existing source | Extraction/redaction | Consumed by |
|---|---|---|---|
| Current Codex worktree window | `~/.codex/sessions/...jsonl` | Existing fixture-script pattern; structure preserved; paths/ids deterministically tokenized; prompts/tool free text removed; hard sensitive/home-path gate | extractor, tracker, transcript parser, live projection tests |
| Codex MCP negative | Same rollout corpus | Same pass; retain only recorded structural call envelope and tokenized cwd-bearing argument | non-attribution test |
| Claude worktree evidence | `~/.claude/projects/...jsonl` | Existing structure-only redaction discipline; preserve `worktree-state`, cwd/branch topology, message envelope | shared provider regression |
| Global Dispatch D23 mismatch | `~/.config/agent-code/workspace.json` | Reduce through production ownership/order fields; tokenize ids/paths/titles; preserve tab/session/detached ordering | selector + pane chrome regression |

Tests are authored in Stage 2, after Stage 1 artifacts are reviewed and before
any production implementation. A fixture may be mechanically minimized only by
the checked-in exporter; hand-cleaning it in a test is forbidden because it
would erase the distinction between recorded data and an imagined literal.

## Approval gate

Approval authorizes Stage 1 only. After Stage 1, its artifacts are independently
verified before Stage 2 begins; after Stage 2, the focused failures are reported
before Stage 3 implementation begins. If the census invalidates this stage
shape, this document is revised and approval is requested again rather than
patching forward.
