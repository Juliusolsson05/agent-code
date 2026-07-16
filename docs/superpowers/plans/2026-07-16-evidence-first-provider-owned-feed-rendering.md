# Evidence-First, Provider-Owned Feed Rendering — Implementation Plan

**Status:** Draft architecture plan; no runtime implementation in this PR

**Date:** 2026-07-16

**Branch:** `plan/evidence-first-feed-rendering`

**Worktree:** `/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/evidence-first-feed-rendering-plan`

**Baseline:** `origin/main` at `f28d1b26`

**Related draft:** [PR #524](https://github.com/Juliusolsson05/agent-code/pull/524)

## Goal

Build the feed renderer from observed provider evidence instead of from a guessed
universal taxonomy.

Agent Code should be known for unusually good agent rendering. A command should
look like a command, an edit should make the changed lines obvious, test output
should surface the useful result, and an unfamiliar operation should remain
legible rather than disappearing. That quality bar requires specialization.
It does **not** require one React component per raw wire shape, one component per
possible shell command, or a framework that predicts every future provider.

The system must preserve four separate facts:

1. **Raw shape:** exactly which provider/version/model event structure was
   observed, including meaningful streaming prefixes.
2. **Provider interpretation:** how that provider maps the raw structure into a
   visual meaning such as command, code edit, read, search, or condition.
3. **Visual protocol:** the narrow provider-neutral model a genuinely shared
   view accepts, such as `CodeEditRenderModel`.
4. **React composition:** the component, optional formatter, primitives, and
   fallback that paint that meaning.

Keeping those facts distinct gives us institutional memory without coupling
Claude, Codex, OpenCode, and future providers to one shared parser.

## Why this plan replaces the current direction

Draft PR #524 is useful evidence, but it is not a safe merge candidate. At the
time this plan was written it contains 116 changed files, 17,122 additions,
3,981 deletions, and a conflicted merge state. Its history shows real visual
improvements followed by repeated regressions when newly discovered provider
shapes contradicted the shared assumptions:

- a live `Write` route disappeared during dispatch deduplication;
- modern Codex unified `exec` scripts were initially rendered as generic JSON;
- Codex patch results existed in more than one persisted wire shape;
- spawn-result suppression dropped subagent final reports;
- CRLF handling erased output;
- multi-command wrappers exposed a first-command-only assumption;
- two presentation stages independently decoded the same Codex wrapper.

Those are not reasons to abandon the work. They are evidence that the order of
operations was wrong. The branch built a broad classification and component
system before it had a durable inventory of the inputs that system must cover.
The replacement strategy is:

1. capture and fingerprint observed structures;
2. curate fixtures and provider-owned interpretations;
3. implement one vertical visual family at a time;
4. prove live, committed, restart, and prefix behavior for that family;
5. remove a legacy route only after the replacement owns all of its evidence.

PR #524 remains a draft salvage source. It is not the base branch for this
implementation and must not be rebased wholesale onto `main`.

## Decisions in one page

- Keep the existing `src/renderer/src/rendering/` ownership pipeline. It
  decides which observation owns a feed item and in what order; this plan does
  not make the painter re-litigate ownership.
- Keep `src/renderer/src/features/feed/ui/` as the feed assembly and painting
  surface. Do **not** rename it to `presentation/`.
- Keep raw decoding, classification, pairing exceptions, and lifecycle
  interpretation inside `src/providers/<provider>/renderer/`.
- Keep shared visual protocols and their views below
  `src/providers/shared/renderer/`. Shared code accepts normalized domain
  models and never imports a specific provider.
- Inventory every distinctive observed raw shape, but do not create a React
  component for every shape. Components represent meaningful visual grammars.
- Use composition, not a base-card inheritance hierarchy.
- Extend the existing recorder, replay, redaction, unknown registry, and fixture
  corpus. Do not build a second evidence framework.
- Treat live conditions as a parallel provider-owned system. Do not route
  compaction, approvals, trust prompts, or pickers through ordinary tool cards.
- Make no broad file moves or naming changes in the first implementation PRs.
  A new directory is created only when the first real responsibility needs it.

## Vocabulary

The words below are contracts. Using one word for several altitudes is how the
previous design accumulated duplicated decoders.

### Raw shape

A provider wire structure at a specific observation plane and lifecycle point.
Examples include a Claude `tool_use` block, a Codex unified-exec JavaScript
wrapper, a `patch_apply_end` event, a partial JSON input prefix, and a live
condition snapshot.

Two payloads with different user content can have the same raw shape. `Bash`
with `ls` and `Bash` with `git status` are instances of one structural shape,
not two new components.

### Structural fingerprint

A content-independent identity derived from stable key/type paths plus a small
allowlist of structural discriminator values such as `type`, `kind`,
`subtype`, and tool name. It answers: “Have we seen this structure before?”

A payload hash remains separate. It can deduplicate individual sightings, but
must not be the catalog key: content-sensitive hashes would turn every command
or prompt into a supposed new shape.

### Shape catalog entry

A human-reviewed record with a stable, readable id, structural fingerprint,
provider provenance, lifecycle/plane, fixture references, classification
status, and intended visual destination.

The catalog records what exists. It does not itself render anything.

### Provider adapter

Provider-owned code that recognizes and parses that provider's raw shapes. It
may produce a provider-specific row directly or map into a narrow shared visual
protocol. Claude and Codex do not import or reuse each other's adapters.

### Visual protocol

A small domain model accepted by a shared view. For example, a code-edit model
can contain files, hunks, additions, deletions, status, and bounded diagnostics.
It must not contain Claude tool blocks, Codex rollout events, provider names, or
provider-private decoder types.

### Component

A React unit for a meaningful visual grammar or interaction: command, code
edit, file write, read/search, todo list, approval, compact summary, and so on.
Several raw shapes can map to one component after provider-owned interpretation.

### Formatter

A conservative enhancement inside a visual family. Git summaries, test result
summaries, diagnostic grouping, and JSON formatting are formatters, not new
top-level operation components. A formatter may decline and return `null`.

### Primitive

A visual building block such as bounded output, ANSI spans, a diff hunk, status
badge, disclosure control, path label, or streaming code surface. Primitives do
not interpret provider wire data.

### Fallback

A visible, bounded, expandable representation used when no specialized
interpretation claims the shape. Unknown content must not silently disappear.

## Naming and directory decision

### Do not introduce `presentation/`

`presentation/` is not an existing product vocabulary and does not identify a
new ownership boundary. Beside `features/feed/ui/`, it would leave future work
asking whether a visual change belongs in “presentation” or “UI.” PR #524 also
used `presentation/` for a pure `OperationVM` projector while `ui/resolve/`
performed a second projection. The duplicate altitude enabled the same Codex
wire wrapper to be decoded twice.

We therefore do not rename `ui/`, `model/`, `ledger/`, or the existing
`rendering/` directories. Cosmetic alignment is not part of this project.

### Existing directories keep their current meaning

```text
src/renderer/src/rendering/
  DECIDE: observation ownership, identity, order, replay, invariants

src/renderer/src/features/feed/ui/
  PAINT/ASSEMBLE: ordinary provider-neutral feed rows and feed behavior

src/providers/<provider>/renderer/
  INTERPRET: provider wire shapes, provider-specific rows, transcript mapping,
             live-condition views and policies

src/providers/shared/renderer/
  SHARE AFTER INTERPRETATION: provider-neutral visual protocols and primitives
```

### `projection/` is deferred, not pre-created

One orchestration reviewer recommended `projection/` rather than
`presentation/` if we later need a pure, audited
`FeedRenderItem[] -> { nodes, receipts }` assembly stage. That name would be
more precise, but the responsibility has not yet earned a directory on `main`.

The code-edit vertical slice must first prove whether such a neutral stage is
needed. If it is created later, it may assemble already interpreted visual
nodes and omission receipts. It may **not** parse provider wire shapes, import
provider-private modules, or become another global operation classifier.

### Minimal additive target shape

Directories below are illustrative destinations, not empty scaffolding to land
up front:

```text
src/providers/claude/renderer/
  shapes.ts                         # starts as one file; directory only if it grows
  adapters/codeEdit.ts             # Claude wire -> CodeEditRenderModel
  rows/ClaudeCodeEditRow.tsx        # optional provider wrapper/composition

src/providers/codex/renderer/
  shapes.ts
  adapters/codeEdit.ts             # Codex wire -> CodeEditRenderModel
  rows/CodexCodeEditRow.tsx

src/providers/shared/renderer/
  protocols/code-edit/
    model.ts                        # no provider imports
    CodeEditView.tsx                # no provider branches
    CodeEditView.test.tsx
```

`protocols/` is justified only when the first two independent providers map to
the same domain model. It names a real safety boundary: code below it consumes
domain data, never provider wire data. If only one provider has a feature, keep
the component provider-owned until a second implementation proves the shared
contract.

## Dependency and ownership contract

The allowed direction is:

```text
owned FeedRenderItem
        |
        v
existing provider capability registry
        |
        v
provider-owned recognizer / decoder / lifecycle interpretation
        |
        +----> provider-specific component
        |
        `----> narrow shared visual protocol ---> shared protocol view
```

The following import rules are non-negotiable:

1. `src/providers/claude/**` never imports Codex or OpenCode renderer code.
2. `src/providers/codex/**` never imports Claude or OpenCode renderer code.
3. `src/providers/opencode/**` never imports Claude or Codex renderer code.
4. `src/providers/shared/renderer/**` never imports a specific provider.
5. `src/renderer/src/features/feed/**` may select capabilities through the
   existing registry, but never imports a provider's decoder/extractor.
6. Shared protocol types never mention provider wire types.
7. A component accepting a shared protocol never branches on `provider`.

The checkpoint on PR #524 violates this boundary in at least nine places. The
shared classifier/projector, committed/live resolvers, and shared artifacts
reach into Claude, Codex, or OpenCode extractors. `fileEdit.tsx` imports both
Claude and Codex. These edges are evidence to remove during vertical migration,
not a pattern to preserve.

Use the existing renderer capability registry rather than creating another
dynamic plugin registry. Add only the smallest capability needed by the first
vertical slice. Do not design a wide universal adapter interface before two
providers prove each method and call shape.

The boundary should eventually be protected by a narrow import test or the
repository's existing lint mechanism. A bespoke dependency framework is not
required; one clear failure message is enough.

## Evidence system

### Reuse what already exists

The repository already has most of the hard infrastructure:

- `SessionRecorder` with bounded local capture and retention;
- replay through the real reducers;
- structure-only and capped-text redaction;
- a sensitive-survivor hard gate before fixture check-in;
- `UnknownRegistry` with shape paths, payload hashes, counts, and dispositions;
- recording and bundle corpus tests;
- tick-by-tick replay that can exercise streaming prefixes;
- 48 existing rendering bundles/fixtures that can seed the inventory.

The implementation should extend these paths. A parallel recorder or fixture
framework would duplicate privacy, cap, replay, and incident hardening.

### Canonical shape identity

Introduce one pure, shared structural fingerprint helper near the existing
unknown-shape code. Its inputs are:

- provider and observation plane;
- event/tool discriminator;
- sorted key/type paths with secret subtrees removed;
- an explicit allowlist of low-cardinality structural values.

Its output is a stable short fingerprint. It never includes prompt text,
command text, assistant text, tool payload values, paths, or result prose.

Keep the existing payload hash as a separate sample/dedup identity. The shape
catalog groups by structural fingerprint; sightings may count distinct payload
hashes within that group.

### Per-provider typed catalogs

Start with one `shapes.ts` file per provider, using a checked literal rather
than a code generator:

```ts
export const CODEX_RENDER_SHAPES = {
  'codex.unified-exec.command.v1': {
    fingerprint: '…',
    plane: ['live', 'committed'],
    status: 'rendered',
    destination: 'command',
    fixtures: ['…'],
  },
  'codex.unified-exec.apply-patch.v1': {
    fingerprint: '…',
    plane: ['live', 'committed'],
    status: 'planned',
    destination: 'code-edit',
    fixtures: ['…'],
  },
} as const satisfies RenderShapeCatalog

export type CodexRenderShapeId = keyof typeof CODEX_RENDER_SHAPES
```

This gives the user-requested typed institutional memory without maintaining a
separate generated union. Split `shapes.ts` into `shapes/` only when its real
size warrants multiple files.

Every entry records:

- stable human-readable id and structural fingerprint;
- provider;
- raw event/tool discriminator;
- live, committed, replay, condition, or transcript plane;
- observed CLI/wire/app version and model when those facts are available;
- first/last observed dates;
- fixture ids, including meaningful prefixes;
- classification status: rendered, planned, intentional-generic,
  intentional-hidden, or unknown;
- visual destination/protocol;
- a short WHY note when two similar shapes intentionally differ.

Model and provider-version provenance are valuable precisely because upstream
tools can regress or default unexpectedly. The implementation must first audit
where those values are trustworthy. Missing provenance is represented as
unknown, never guessed from content.

### Runtime sightings versus checked-in truth

Runtime capture and repository truth have different safety budgets:

**Runtime, explicit developer-capture mode:**

- emit metadata-only structural sightings;
- deduplicate by fingerprint and increment counts;
- keep all buffers bounded;
- never record raw prompts, commands, assistant text, or tool payloads in the
  shape sidecar;
- ensure observer failure cannot affect rendering or session execution;
- reuse the existing recording/debug gate rather than enabling continuous
  production capture by accident.

**Offline extraction and review:**

- aggregate sightings from redacted recordings;
- suggest new catalog entries and representative fixture windows;
- run the existing sensitive-data hard gate;
- derive useful streaming-prefix fixtures from recorded ticks;
- require a human-readable diff before catalog/fixture updates are accepted.

A local sighting does not automatically become a checked-in catalog entry. The
catalog is reviewed evidence, not telemetry-generated source code.

### Known and unknown coverage

`UnknownRegistry` currently records only unclaimed shapes and keys too much of
its identity on content-sensitive payload hashes. Evolve it toward a bounded
sighting sink without discarding its existing diagnostics:

- group unknown reports by structural fingerprint;
- preserve sample payload hashes only for counts/dedup;
- optionally record known-shape sightings while explicit capture is active so
  corpus coverage can be proven;
- keep capped redacted previews for local diagnosis, never for shape identity;
- attach a disposition and destination so intentional generic/hidden cases do
  not look like unfinished work.

The coverage test must fail when:

- a captured structural fingerprint is absent from the provider catalog;
- a catalogued `rendered` shape has no representative fixture;
- a provider adapter claims a shape id absent from that provider's catalog;
- a catalog entry points to a missing fixture;
- a shape is silently hidden without an explicit intentional-hidden reason.

It must not fail because two commands have different content.

## Rendering quality and component granularity

The catalog can be fine-grained while the component tree remains coherent.
Use this decision ladder for every new shape:

### 1. Dedicated component

Create a dedicated component when the **whole operation** has a distinct visual
grammar or interaction and it is important enough to test across live and
committed states. Examples: code edit, command, file write, read/search, todo,
approval, compact summary.

Dedicated does not mean monolithic. The component composes shared primitives
and may delegate parts of its body to formatters.

### 2. Specialized formatter inside a family

Use a formatter when the specialness is mostly in output interpretation rather
than the operation shell. Examples: git status/diff summaries, test totals,
compiler diagnostics, JSON, or duration/exit information inside a command row.

Formatters are conservative:

- pure where possible;
- return `null` when uncertain;
- enrich rather than erase the bounded raw result;
- show terminal conclusions only when the operation is terminal;
- never become provider wire parsers.

This is how “a certain command can use a distinctive color or layout” scales:
the command component has one stable grammar, while a trusted command-family
formatter adds an accessible accent, icon, summary, or structured output. Color
must never be the only carrier of meaning.

### 3. Generic structured protocol view

Use the generic structured tool view for the long tail where the payload has a
useful label/parameters/result but no proven custom grammar.

### 4. Visible unknown fallback

Use a bounded fallback for an unrecognized shape. It should expose enough
metadata to diagnose the miss and let the user expand a safely bounded view.
Unknown is a rendering state, not permission to return `null`.

### No component inheritance framework

Do not create a base React class, card subclass hierarchy, detector DSL, or
dynamic component plugin system. Composition already expresses the reusable
parts while allowing a command and an edit to look genuinely different.

## Conditions are a parallel semantic system

Conditions answer “what live interaction or transient state currently requires
a surface?” Ordinary feed rendering answers “how should durable owned work be
painted?” They share primitives and provider ownership rules, but they must not
share a catch-all operation classifier.

The current conditions architecture is the positive reference:

```text
provider headless/session
  detects provider-specific condition state + actions
        |
        v
ProviderConditionSnapshot (namespaced kind)
        |
        v
provider condition view registry + provider condition policy
        |
        v
shared ConditionOutlet routes by kind without reading provider state
```

`src/shared/conditions-core/` owns only the generic record/action/view
contracts and routing. `src/providers/<provider>/renderer/conditions/` owns the
state-to-view adapter and policy. This is the exact import direction the feed
renderer should emulate.

### Compaction proves why the distinction matters

Compaction appears in two separate forms:

1. **Live condition:** `claude.compaction` is a transient read-only strip with
   running/error/done state. It is deliberately not an actionable attention
   kind unless it errors.
2. **Durable transcript semantics:** provider transcript mappers normalize a
   completed compaction into `compact_boundary` and `compact_summary` entries.
   The feed renders those as `CompactBoundaryRow` and `CompactSummaryRow`.

The live strip must not be converted into a feed tool card, and the durable
summary must not depend on a still-live condition snapshot. Restart/replay must
recover the durable entries even though the transient condition is gone.

### Condition catalog treatment

Condition wire structures belong in the evidence catalog, but their
`destination` is one of:

- `condition-outlet` — modal or strip;
- `feed-inline` — for example AskUserQuestion's durable/in-feed presentation;
- `composer` — for example the Claude slash picker;
- `attention-only`;
- `intentional-hidden`.

This prevents a known condition with no outlet view from being mistaken for a
missing component. Claude AskUserQuestion is attention-worthy and feed-inline
but has no outlet view; the slash picker belongs to the composer; compaction
has an outlet view but is not normally attention-worthy. The existing explicit
condition policy is therefore retained and must not be inferred from the view
registry.

Unknown condition kinds remain forward-compatible at runtime, but explicit
developer capture must record the unknown sighting. A condition coverage test
should require every catalogued kind to declare its destination and every
outlet destination to have a correctly typed provider view.

### Conditions migration rule

Do not move `conditions-core`, provider condition views, or policies as part of
the feed rewrite. Provider-specific detection and action resolution remain in
the provider/headless boundary. Shared condition components may reuse visual
primitives, but shared code never narrows provider state or parses a terminal
screen.

## Testing contract

Every visual family lands through fixtures before broad integration.

### Shape and catalog tests

- structural fingerprint stability and secret-key redaction;
- same structure/different content produces the same fingerprint;
- discriminator changes that alter rendering produce different fingerprints;
- catalog ids and adapter claims agree in both directions;
- every rendered catalog entry has fixtures;
- explicit hidden/generic dispositions remain explicit;
- provider/model/version provenance is preserved when present and unknown when
  absent.

### Provider adapter tests

- Claude fixtures exercise only Claude adapters;
- Codex fixtures exercise only Codex adapters;
- OpenCode fixtures exercise only OpenCode adapters;
- meaningful incomplete prefixes either produce a safe partial model or decline
  to the fallback without throwing;
- completed payloads resolve to the intended protocol;
- malformed and future payloads fail closed to the visible fallback;
- no shared module imports a provider-private module.

### Shared protocol component tests

- model-only tests with no provider fixtures or provider names;
- live/running, success, failure, cancelled, and partial states where relevant;
- bounded collapsed output and paged/lazy expansion;
- accessibility: labels/icons accompany color, keyboard disclosure works, and
  status is available as text;
- large input does not eagerly create unbounded DOM or syntax-highlight work.

### Replay and ownership tests

- all existing rendering invariant/corpus tests stay green;
- live and committed evidence for one logical operation do not double-render;
- restart/replay produces the same terminal visual model;
- legacy routes are deleted only after shadow comparison shows no unowned or
  omitted content;
- an unknown shape remains visible and creates a bounded sighting.

### Conditions tests

- provider condition kind/state/view binding remains compile-time checked;
- every known condition declares its intended surface;
- attention/action policy remains explicit rather than inferred from views;
- unknown condition kinds are skipped safely and recorded in developer capture;
- live compaction strip and durable compact boundary/summary are independently
  tested across restart/replay;
- condition actions continue through provider-owned resolution, not feed rows.

## Incremental delivery plan

Each implementation PR is independently reviewable and keeps the app usable.

### Phase 0 — this plan-only draft PR

- document the evidence-first architecture;
- record the no-churn naming decision;
- record provider boundaries and conditions translation;
- keep PR #524 as a separate draft evidence source;
- make no runtime or file-structure changes.

### Phase 1 — structural fingerprint and catalog skeleton

- add the pure structural fingerprint beside the existing unknown registry;
- change unknown grouping from content identity to structural identity while
  retaining payload hashes as samples;
- add the small catalog contract and one `shapes.ts` per provider only when
  seeded entries are ready;
- add the coverage test and import-boundary guard;
- no visual behavior changes.

### Phase 2 — seed evidence from existing corpora

- run the offline extractor over the existing redacted recording and bundle
  corpus;
- curate human-readable provider shape ids;
- attach model/version provenance only where verified;
- add representative full and prefix fixtures;
- classify each shape as rendered, planned, generic, hidden, or unknown;
- publish a reviewable coverage report.

### Phase 3 — code-edit vertical slice

- independently map Claude Edit/MultiEdit shapes to a code-edit protocol;
- independently map Codex apply-patch/unified-exec/patch-result shapes to the
  same protocol where their semantics genuinely fit;
- add the shared code-edit protocol and view only after both mappings exist;
- keep small provider wrapper rows if they need provider-specific labels or
  lifecycle chrome;
- shadow compare with legacy output, then switch only the covered shapes;
- do not delete unrelated PR #524 routes.

This phase is the architectural proof. It tells us whether a neutral
`projection/` assembly stage is needed. We do not decide that from diagrams.

### Phase 4 — command family and formatters

- add independent Claude Bash and Codex command/unified-exec adapters;
- land the command visual protocol/component;
- add conservative formatters for proven command families such as git, tests,
  and diagnostics;
- keep bounded raw output available;
- verify background command, wait/poll, multi-command, CRLF, ANSI, empty-success,
  and failure fixtures.

### Phase 5 — remaining families, one at a time

Migrate file write, read/search, todo, web, image, subagent, MCP/generic, and
other families only as their fixture inventory is ready. Each family follows
the same adapter/protocol/component decision ladder.

### Phase 6 — cleanup after proven cutover

- remove a legacy route only when no catalogued shape depends on it;
- remove duplicate decoders after provider-owned adapters are canonical;
- consider a neutral `projection/` stage only if omission receipts still need a
  home after the vertical slices;
- update durable design docs from proven implementation, not aspirations;
- close or supersede PR #524 once all valuable pieces are either ported or
  explicitly rejected.

## PR #524 salvage matrix

Review and port selectively, with tests, rather than copying directories.

### Strong candidates to retain

- ANSI parsing/painting, including span caps and control-sequence hardening;
- bounded output with useful head/tail previews;
- diff primitives and per-file summaries;
- stable streaming-code ideas such as sealed-line caching;
- segmented streaming markdown where the performance claim is reproduced;
- safe partial JSON/string extraction techniques inside provider adapters;
- lazy expansion and large-content caps;
- status vocabulary, path labels, and disclosure primitives;
- fixture discoveries, real wire examples, and regression tests;
- omission/projection receipt concepts if a neutral assembly stage proves
  necessary.

### Do not port wholesale

- the global 17-family taxonomy as an assumed source of truth;
- shared classifiers that call provider extractors;
- shared artifacts importing Claude, Codex, or OpenCode;
- the two-stage `OperationVM` then `ArtifactVM` double projection;
- provider switches inside shared components;
- result suppression before the replacement proves it consumes the result;
- large simultaneous deletions of legacy render paths;
- directory naming introduced only to mirror the draft branch.

## Anti-overengineering guardrails

- No new state-machine or plugin dependency.
- No universal detector DSL.
- No base-card inheritance tree.
- No component per tool name, command string, or structural fingerprint.
- No generated type artifact when `keyof typeof catalog` is sufficient.
- No empty directories or placeholder interfaces.
- No cross-provider imports, even when two raw payloads look similar.
- No shared protocol until two real providers prove the same semantic model.
- No interpretation that replaces or hides the bounded raw evidence when
  confidence is low.
- No visual cutover before fixtures cover live, committed, and relevant prefix
  shapes.
- No broad rename mixed into behavior work.

## Open decisions to resolve with evidence

1. **Does a provider-neutral `projection/` stage earn a home?** Decide after
   the code-edit slice. Default: no.
2. **Where is model/CLI version provenance trustworthy for every provider?**
   Audit real start/semantic/recording metadata before defining required fields.
3. **How much known-shape runtime sighting is affordable?** Benchmark explicit
   developer capture. Production rendering must not pay unbounded per-delta
   shape work.
4. **Which PR #524 primitives already match current `main` contracts?** Port
   through small PRs with their regression fixtures; do not assume code that
   built on the draft branch remains correct.
5. **Which command formatters deserve product support first?** Choose from
   observed frequency and user value, not an exhaustive command taxonomy.

## Definition of done

This program is complete when:

- every observed distinctive provider shape in the checked-in corpus has a
  typed catalog entry and representative fixture;
- unknown shapes are structurally deduplicated, bounded, safe, and visible;
- Claude, Codex, and OpenCode interpretations are isolated behind provider
  renderer capabilities;
- shared visual protocols contain no provider types or provider branches;
- code edits and commands have high-quality, accessible, provider-consistent
  rendering without sharing raw decoders;
- live, committed, prefix, restart, and replay behavior is covered;
- compaction and all other conditions retain their separate transient and
  durable semantics;
- the ownership/order pipeline remains the source of truth for which content
  may paint;
- PR #524 has been reduced to a closed historical/salvage reference rather than
  a giant conflicted merge candidate;
- future agents can answer “what shapes exist, where was each observed, how is
  it rendered, and which fixture proves it?” by reading code and fixtures rather
  than reconstructing history from conversations.

## Consultation record

Four Claude orchestration reviews informed this plan:

1. **Naming and structure:** rejected ambiguous `presentation/`; recommended
   preserving existing folders and reserving `projection/` for a proven pure
   assembly responsibility.
2. **Provider boundary:** confirmed the target boundary and found at least nine
   shared-to-specific-provider imports plus duplicate Codex wrapper decoding in
   PR #524.
3. **Shape evidence:** found that roughly 85% of capture/replay/redaction
   infrastructure already exists; recommended a structural catalog, sighting
   extension, and coverage test rather than a new framework.
4. **Component granularity:** separated raw-shape inventory from visual grammar
   and recommended dedicated components, family formatters, generic structured
   views, and visible fallbacks in that order.

The recommendations were reconciled rather than copied blindly. In particular,
this plan defers `projection/`, derives ids from typed catalogs instead of
adding a generated union, and keeps classification provider-owned rather than
creating a universal shared classifier.
