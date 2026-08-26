# Recorded rendering-shape reconciliation and semantic operation presentation

**Status:** proposed — awaiting explicit approval before implementation  
**Date:** 2026-08-26  
**Issues:** #530, #643, #644, #645, #646

This document is the required artifact of the staged-decomposition method. No
production or test implementation may begin until the decomposition is
approved. If recorded evidence later contradicts a stage, this document must be
revised and approved again; the implementation must not be patched forward with
another route-specific conditional.

## Applicability

The method applies. Agent Code is far beyond the size threshold, and this work
reconciles provider wire shapes, semantic/live state, committed transcript
state, correlated results, rendering receipts, and provider-owned catalogs into
one visible operation. The current retained corpus also contains cases whose
meaning is not yet established.

The instrumentation stage already exists and is trusted. In particular,
`SessionRecorder.renderShapes()` writes bounded `__render_shape` batches into
the existing session recording, and the renderer observer records structural
fingerprints plus routing outcomes. This plan does **not** add a second recorder
or a second shape journal. The first implementation stage consumes and curates
the reality that this recorder already captured.

## 1. A and D

### A — what exists and is trusted

| Artifact | Location | What is trusted |
|---|---|---|
| Recorded provider/session events | `~/.config/agent-code/session-recordings/*/events.jsonl` | The existing recorder captured the actual channels sent during the session. Its 128 MiB cap and truncation tombstone are part of the recording contract. |
| Recorded render-shape sightings | `SessionRecorder.renderShapes()` and `__render_shape` records | A sighting is bounded metadata showing the payload structure and route evaluated by the renderer. Counts are approximate because React may evaluate an uncommitted render. |
| Render-shape observer | `src/renderer/src/features/feed/evidence/observer.ts` | Capture is passive, structurally deduplicated, bounded, generation-aware, and does not feed observations back into the render tree. |
| Existing catalogs | `src/providers/{claude,codex,opencode}/renderer/shapes.ts` and `src/providers/registry.renderShapes.ts` | Checked-in definitions are the executable ownership contract for shapes already curated from evidence. |
| Exact reported operation | retained Codex recording from 2026-08-26, `events.jsonl` lines 3986–3987, plus the user-supplied render-debug export | The real invocation was a transparent unified `exec` wrapper around one `tools.exec_command`. The command consisted of `rg`, `rg --files`, `sort`, and `head`; the correlated output and current route are recorded. |
| Codex command normalization | `src/providers/codex/renderer/adapters/command.ts` | The adapter admits only a narrowly proven transparent wrapper, preserves the inner command and output, and correctly refuses to invent an exit code when `text(result.output)` drops it. |
| Shared command protocol | `src/providers/shared/renderer/protocols/command/{model,CommandView,shellLex}.ts*` | `CommandRenderModel` is a provider-neutral object and `shellLex` already enforces parse-fully-or-decline for the shell subset it understands. |
| Frozen rendering fixtures | `testing/fixtures/rendering-bundles/` and `testing/fixtures/rendering-shapes/` | These are trustworthy only for the specific captured cases and transformations declared by each fixture. They are not evidence that retained provider drift is exhausted. |

The 2026-08-26 audit is a useful baseline, not a complete census:

- 33 retained recordings, about 1.2 GB;
- 183 known-outcome-unobserved fingerprints / 3,686 frozen-corpus sightings;
- 38 known-claimed fingerprints / 52,347 retained-recording sightings;
- 21 unknown fingerprints / 512 retained-recording sightings;
- one known-misrouted fingerprint / 45 sightings;
- nine recordings larger than the audit reader's 64 MiB prefix.

The following are explicitly **not** trusted:

- the current audit totals as exhaustive while nine files are prefix-limited;
- `input.__rawJson` as a genuine provider wire shape merely because a ghost
  projection exposed it to the observer;
- `codex.rows.dispatch` as proof of useful presentation—it identifies a broad
  owner, not whether the user received a command, search, or another grammar;
- the current regex helpers in `features/feed/lib/helpers.ts` as durable
  read-only proof; they detect the presence of a command name and can match a
  mixed expression whose later segment mutates state;
- an exit code inferred from the wrapper phrase `Script completed`.

### D — observable end state

1. The existing recording writer remains the sole source of render-shape
   evidence. Offline tooling can stream every committed shape sighting in a
   retained recording up to authoritative EOF/cap, while interactive readers
   report exactly why their bounded result is incomplete.
2. Every genuine retained provider shape has a curated real fixture, catalog
   definition, explicit disposition, and route outcome. Synthetic lifecycle or
   observer defects are fixed rather than catalogued as provider behavior.
3. Provider adapters compose one clean provider-neutral operation object before
   painting. Views do not inspect provider payloads, JavaScript wrappers, or
   shell syntax.
4. The reported `rg` operation renders as **Search**, not `exec`. Its exact
   command and complete bounded output remain available, and the terminal copy
   says `exit code unavailable` rather than implying success or presenting the
   ambiguous `exit unknown` phrase.
5. Search/read/list admission is parse-full-or-decline. A compound pipeline is
   specialized only when every command and operator is proven non-mutating;
   ambiguous or mixed commands retain the generic command presentation.
6. Semantic/live and committed/durable planes use the same operation kind and
   presentation vocabulary for the same recorded operation.
7. Shape receipts identify the semantic protocol (`command.search`,
   `command.read`, `command.list`, or generic command) so known-claimed but
   poorly presented operations can be measured independently of unknown-shape
   coverage.
8. The complete retained audit has no unexplained unknown, unsupported, or
   misrouted outcomes. Any deliberately generic family says why generic is the
   correct terminal disposition.

## 2. Intermediate stages

### Stage 0 — freeze the recorded corpus and expected semantics

- **Produces:** a privacy-reviewed fixture manifest and the smallest exact
  recorded slices needed for: the reported Codex transparent search and paired
  result; commands observed as pure search/read/list; observed commands that
  must decline specialization; `fp2-5b0abcb6` misrouting; representative
  `fp2-dbcadd9f` ghost windows; and each currently visible unknown-shape family.
  Every fixture records its source recording identifier, source hash,
  transformation version, structural signature, and observed frequency. It
  also produces failing contract tests for semantics already approved in this
  document, before production behavior changes.
- **Verified by:** run the production parser/fingerprinter over the private
  source and curated fixture, then compare structure, discriminators,
  invocation/result correlation, relevant ordering, and route receipt. The
  reported search fixture must reproduce `fp2-bb2ab36f` and the exact
  `exec → tools.exec_command → rg` carrier. Expected UI semantics are reviewed
  by the human; they are not inferred from the implementation proposal.
- **Why separate:** fixtures written from a proposed classifier would encode
  the classifier's assumptions and manufacture a green suite. Freezing the
  real carriers and expected ownership first lets later code be wrong in a
  useful, observable way.
- **Reality check:** the exact user-reported operation exists in a retained
  recording below the current per-file read ceiling, and the current audit has
  already enumerated the fingerprints and frequency groups that need source
  windows. No hypothetical provider payload is required.

### Stage 1 — make existing evidence consumers complete and explicit

- **Produces:** one shared bounded JSONL scanning primitive used by the Unknown
  Shape Inbox reader, `audit-rendering-shapes.mts`, and
  `extract-rendering-shape.mts`; an offline complete-scan mode that reaches the
  recorder's authoritative EOF/cap without materializing entire recordings;
  and structured completeness reasons for interactive scans (recording count,
  sighting count, aggregate bytes, per-file bytes, malformed line, or recorder
  tombstone). The existing `__render_shape` writer is unchanged.
- **Verified by:** Stage 0 includes an actual retained recording shape on each
  side of the old 64 MiB boundary. The complete audit must find both with
  bounded heap, while an intentionally restricted interactive sweep returns
  the early shape plus the precise limit that excluded the late one. Inbox,
  audit, and extractor must agree on CRLF, torn-tail, oversized-line, and
  schema-validation behavior.
- **Why separate:** cataloguing from a silently clipped census would prioritize
  and close work against partial reality. Combining reader changes with shape
  classification would also make a changing census indistinguishable from a
  routing fix.
- **Reality check:** nine retained recordings already exceed the consumer's
  64 MiB prefix, while `SessionRecorder` authoritatively permits a bounded
  128 MiB `events.jsonl`. The missing evidence is downstream of recording.

### Stage 2 — establish a complete shape inventory and disposition table

- **Produces:** a generated, reviewable inventory grouped by provider,
  fingerprint, source plane, lifecycle, route outcome, recording frequency,
  and proposed semantic family. The table separates genuine provider
  candidates from suspected synthetic/observer artifacts and records one of:
  extend an existing definition, create a new definition, fix routing, fix
  lifecycle/provenance, or deliberately retain generic presentation.
- **Verified by:** regenerate the inventory twice from the same retained corpus
  and obtain byte-identical grouping/order; reconcile its totals with Stage 1's
  completeness report; and manually trace at least one source window per family
  before accepting a disposition.
- **Why separate:** a fingerprint proves structural difference, not semantic
  difference. Directly seeding every fingerprint into a provider catalog would
  turn additive caller fields, ghost fallbacks, and genuinely new operations
  into equally permanent product contracts.
- **Reality check:** the current 21 fingerprints consolidate to roughly 14
  families. About 94% of visible unknown volume belongs to two very different
  investigations: 252 suspicious Codex `__rawJson` sightings and about 228
  Claude browser/MCP sightings.

### Stage 3 — resolve routing and provenance defects before specialization

- **Produces:** a fixture-proven resolution for the 45-sighting
  `fp2-5b0abcb6` command-continuation mismatch, plus a proven origin/lifecycle
  outcome for `fp2-dbcadd9f`. If `__rawJson` is synthetic ghost state, the
  observer receives explicit synthetic provenance or stops observing it as a
  durable committed provider operation. If real committed evidence exists,
  its source cursor and carrier are restored before cataloguing.
- **Verified by:** the Stage 0 route and ghost fixtures fail against the old
  behavior and pass after the correction; the same visible result bytes are
  still owned exactly once; and the full audit returns zero known-misrouted
  outcomes without adding a catalog entry whose only purpose is to silence a
  lifecycle bug.
- **Why separate:** presentation work assumes that the object being presented
  really belongs to the claimed provider plane. Specializing a ghost or
  duplicate result first would give incorrect ownership a more polished UI and
  make the underlying defect harder to see.
- **Reality check:** the misroute is an exact catalog/receipt disagreement, and
  the `__rawJson` sightings currently claim committed/durable origin while
  carrying no source recording cursor.

### Stage 4 — isolate and prove discovery-operation composition

- **Produces:** a private pure shell-discovery classifier inside
  `src/providers/shared/renderer/protocols/discovery/`, with exactly one public
  composition consumer. It maps an already-normalized command operation into
  a provider-neutral `DiscoveryRenderModel` or declines. The model records
  operation kind, truthful lifecycle/status, exact-command disclosure,
  bounded summary fields, output ownership, and stable protocol id. No React
  component and no provider payload is admitted into the classifier.
- **Verified by:** fixture-first tests from Stage 0. The complete reported
  `rg ; rg | sort | head` command becomes `search`; every observed mixed,
  redirecting, backgrounded, mutating, or unparsed command declines as a whole;
  and removing or changing any unsafe segment changes only admission, never raw
  command/result preservation. Tests must also prove that direct-output Codex
  wrappers retain `exitCode=null` while serialized-result carriers recover the
  recorded exit code.
- **Why separate:** shell intent is the genuinely hard reconciliation. If it is
  spread between provider adapters, semantic activity helpers, and JSX, each
  plane will develop a different read-only definition. Isolating the decision
  also makes a false specialization fail at one contract boundary.
- **Reality check:** `shellLex.ts` already supplies the conservative lexical
  substrate, and the current semantic helper's command-name regexes demonstrate
  both the desired categories and why name presence alone is insufficient.

### Stage 5 — render the composed discovery object on every applicable plane

- **Produces:** one provider-neutral discovery view and one shared command
  presentation entry point. Codex transparent/native commands and Claude Bash
  operations pass their normalized command object through that entry point;
  semantic/live activity uses the same composed kind instead of the existing
  regex helpers. The view presents Search/Read/List first, keeps exact command
  and output disclosures, and emits stable protocol receipts. Generic commands
  continue through `CommandView` unchanged except for the clearer
  `exit code unavailable` copy.
- **Verified by:** renderer tests replay the Stage 0 invocation/result fixtures
  through actual provider dispatch, observer, and debug inspector. The reported
  capture must end at the discovery component with `command.search`, absorb its
  correlated result once, show the output/truncation evidence, and retain the
  full exact command in disclosure/debug data. A live-prefix replay and durable
  replay must agree on operation kind.
- **Why separate:** Stage 4 proves semantics without UI pressure. This stage can
  change layout, disclosures, and receipts without weakening the classifier to
  make a screenshot pass.
- **Reality check:** the current route already normalizes and owns the exact
  command/result correctly; only the provider-neutral object vocabulary and
  presentation are missing. The user-supplied render-debug export records the
  before state end to end.

### Stage 6 — integrate genuine recorded provider families one at a time

- **Produces:** evidence-backed catalog and renderer updates in descending
  retained frequency: Claude JavaScript/navigate/tabs/computer MCP families;
  additive Claude Bash/Skill caller metadata; image-bearing results; trust
  condition; and Codex wait-agent evidence. Each family lands with a real final
  fixture, any observed prefix fixture, provenance, explicit disposition, and
  provider-neutral protocol where the evidence proves one. OpenCode receives a
  deliberate recorded soak before its empty catalog is declared current.
- **Verified by:** before each family changes, its recorded fixture is red
  against catalog coverage or expected presentation; after the change, its
  provider renderer test, catalog coverage, complete retained audit, and
  no-duplicate-result invariant pass. Family frequencies are regenerated after
  every merge because earlier routing fixes can change later classifications.
- **Why separate:** browser navigation, JavaScript execution, images,
  conditions, and collaboration waits do not share one semantic grammar. A
  bulk “zero unknowns” patch would encourage broad fingerprints and generic
  dispositions that erase the very distinctions the recorder captured.
- **Reality check:** these families and counts came from the retained sightings,
  not a provider API enumeration. The source windows, not names alone, decide
  whether two fingerprints represent one operation.

### Stage 7 — measure presentation debt among known shapes

- **Produces:** a deterministic presentation-quality report over known-claimed
  sightings, grouped by shape id, semantic protocol, renderer, provider,
  lifecycle, volume, result ownership, and generic-versus-purpose-built
  disposition. The Unknown Shape Inbox can link to this report but remains the
  structural/routing inbox rather than silently changing its definition.
- **Verified by:** the Stage 0 reported operation appears as generic command
  presentation before Stage 5 and as `command.search` afterward without any
  structural fingerprint change. Known generic dispositions are either marked
  deliberate in their catalog rationale or remain visible as review debt.
- **Why separate:** unknown-shape coverage and UI quality answer different
  questions. Combining them would either label every generic fallback a routing
  failure or continue hiding correctly claimed but unhelpful rows such as the
  reported `exec` card.
- **Reality check:** `fp2-bb2ab36f` is already catalogued and correctly claimed,
  yet its user-facing presentation triggered this work. Structural coverage
  alone demonstrably cannot close the product loop.

## 3. Isolation boundary

The hard component is **semantic discovery admission**, not the React card.
It will live under:

```text
src/providers/shared/renderer/protocols/discovery/
  model.ts
  classifyShellDiscovery.ts   # private: pure parse-full-or-decline decision
  composeDiscoveryOperation.ts # sole consumer of the classifier
  DiscoveryOperationView.tsx
  index.ts                    # narrow public surface
```

Only `composeDiscoveryOperation.ts` may import the private classifier. Provider
adapters and lifecycle code may import the public composition surface and model;
they may not import the classifier or reproduce its command allow/deny tables.
The view may import only the provider-neutral model and shared visual primitives.

The discovery directory is forbidden from importing:

- Claude, Codex, or OpenCode payload types;
- session-runtime stores, ledger slices, or transcript records;
- render-shape catalogs or the observer;
- Electron/main/preload modules;
- raw JavaScript-wrapper parsers.

Provider transport parsing remains in provider adapters. Recording evidence and
catalog classification remain in the evidence subsystem. Dispatch may consume
the composed operation and publish its receipt, but it may not arbitrate shell
semantics itself.

The JSONL scanner from Stage 1 is a separate hard boundary under main/shared
evidence tooling. It parses framed bytes and reports completeness; it does not
classify provider shapes. Inbox, audit, and extractor consume it instead of
maintaining three subtly different scanners.

## 4. Unknowns that must remain explicit

1. Which later fingerprints and counts appear when the nine clipped recordings
   are scanned completely?
2. Are all 252 `fp2-dbcadd9f` sightings stale ghost projections, or does the
   fingerprint combine synthetic and genuine committed carriers?
3. Is `fp2-5b0abcb6` wrong because dispatch should absorb the result or because
   the catalog omitted an intentional specialized continuation route?
4. Which shell utilities and option combinations are actually present in
   recorded pure discovery pipelines? The allowlist must be derived from that
   census, not filled from general shell knowledge.
5. Do recorded commands use safe constructs that `shellLex.ts` currently
   declines, such as multiline commands or a specific input-redirection form?
   If so, extending the lexer is a separately proven parser change.
6. How should multiple search queries/scopes be summarized without parsing
   tool-specific English or hiding the exact command?
7. Which Claude MCP fingerprints are additive schema drift versus distinct user
   operations, and which already have a provider-neutral protocol elsewhere?
8. Does Codex wait-agent evidence represent a stable collaboration operation or
   a transient transport envelope that should remain deliberately generic?
9. What OpenCode shapes appear during a representative soak?
10. Which known generic routes are intentionally generic, and which are merely
    waiting for product presentation work?

An empty answer to any of these must not be manufactured to make a stage green.

## 5. Fixture plan

### Sources

- The exact 2026-08-26 retained Codex invocation/result and its render-debug
  export supply the discovery regression.
- Existing retained `__render_shape` sightings supply family frequency and
  source-plane/lifecycle/receipt evidence.
- `extract-rendering-shape.mts` supplies bounded event windows after Stage 1
  makes its scan complete.
- Existing checked-in observed provider corpora supply comparison cases but do
  not replace current retained recordings.
- Missing safety-boundary cases are recorded deliberately through the real
  Agent Code provider/session pipeline in a disposable workspace; they are not
  hand-authored payload literals.

### Curation contract

1. Private drafts preserve exact local evidence and are never committed.
2. A deterministic sanitizer removes private text and machine paths while
   preserving carrier type, ordering, equality relationships, shell operators,
   command names/options required for classification, result correlation,
   lifecycle, and route receipt.
3. Every committed fixture has a manifest containing source hash,
   transformation version, redaction level, provider version when available,
   observation frequency, and the structural signature compared during
   verification.
4. Expected semantic ownership is written and approved before implementation.
   The extractor or classifier never writes its own expected result.
5. A failing real fixture is not weakened or deleted to accommodate code. If
   its expected semantics were wrong, this decomposition and manifest are
   revised with the newly observed evidence and reviewed before proceeding.

### Minimum first fixture set

| Fixture | Real source | Contract protected |
|---|---|---|
| Codex transparent `rg` search | reported retained invocation/result | Search specialization, exact output ownership, unavailable exit code |
| Pure read/search/list variants | retained command sightings | Vocabulary and positive admission from actual use |
| Mixed/ambiguous shell variants | retained or deliberately recorded provider sessions | Whole-expression decline and no false read-only claim |
| Codex command continuation | `fp2-5b0abcb6` source window | Catalog/receipt agreement and single result owner |
| Codex raw-json ghost | `fp2-dbcadd9f` source windows from more than one recording | Durable provenance and no synthetic catalog blessing |
| Late recording sighting | real sighting after byte 64 MiB | Complete offline scan and explicit interactive truncation |
| Each unknown provider family | one or more extracted source windows | Catalog identity, lifecycle, and disposition |

## 6. Delivery and stage gates

The stages should be reviewable PRs rather than one long-lived mega-branch:

1. Stage 0–1: recorded corpus and existing-evidence reader completeness — fixes
   #643 and references #646.
2. Stage 2–3: inventory, known misroute, and ghost provenance — fixes #644/#645
   where the evidence supports closure.
3. Stage 4–5: provider-neutral discovery composition and presentation — advances
   #530.
4. Stage 6: one PR per genuinely distinct provider family, all linked to #646.
5. Stage 7: presentation-quality audit, linked to #530/#646.

After every stage:

- the produced artifact exists and is independently verified;
- the relevant issue and PR describe any scope or evidence changes;
- the complete retained audit and checked-in catalog coverage are rerun;
- result bytes are still owned exactly once;
- no implementation begins for the next stage if current evidence changed the
  decomposition.

No PR is merged without explicit user confirmation.
