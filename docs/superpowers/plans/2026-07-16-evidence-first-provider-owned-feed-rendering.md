# Evidence-First, Provider-Owned Feed Rendering — Implementation Plan

**Status:** Phases 1–7 implemented on PR #555 and under whole-branch hardening; Phases 8–10 remain. Do not merge until all ten phases and final gates pass.

**Date:** 2026-07-16

**Branch:** `feat/render-shapes-phase1-fingerprint-catalog`

**Worktree:** `/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/render-shapes-phase1`

**Baseline:** `origin/main` at `8f357260`

**Related draft:** [PR #524](https://github.com/Juliusolsson05/agent-code/pull/524)

**Lean implementation plan:**
[`2026-07-16-evidence-first-provider-owned-feed-rendering-lean.md`](./2026-07-16-evidence-first-provider-owned-feed-rendering-lean.md)

Implementers start with the lean companion. This document is the exhaustive
reference for contracts, visual-family behavior, the before/after tree, and the
new/modified/deletion ledger.

## Goal

Build two things, in this order:

1. a development instrument that discovers and preserves every distinctive
   provider rendering shape we encounter while using Agent Code; and
2. an exceptional modular renderer built against that evidence rather than a
   guessed universal taxonomy.

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

## The product contract, stated bluntly

The first deliverable is **not another batch of cards**. It is the system that
stops us forgetting what the providers actually emit.

While we use Agent Code in development, the app must observe every distinctive
renderer-facing structure. If the structural fingerprint is already catalogued,
the system records that the known shape was seen again, under which provider,
provider version, model, plane, and lifecycle state. If the fingerprint is not
catalogued, it goes into a bounded local **Unknown Shape Inbox** immediately.
The system preserves enough linkage to the existing session recording to turn
that sighting into a complete local fixture draft without asking a future agent to rediscover
the payload from prose or a transcript archaeology session.

A developer then classifies the unknown shape. Classification answers:

- what provider owns its interpretation;
- whether it is a complete shape or a meaningful streaming prefix;
- whether it deserves a dedicated visual grammar, belongs to an existing
  grammar, needs only a formatter, belongs to conditions/composer/system UI,
  should use the generic structured fallback, or is intentionally absorbed;
- which fixture proves that decision;
- which provider component and optional shared visual protocol render it;
- which model/provider versions have actually emitted it.

That classification becomes checked-in typed data plus fixtures. The system
must make it possible to answer:

> What distinct shapes have Claude, Codex, and OpenCode emitted; which ones are
> still unknown; which component owns each one; which fixture proves it; and
> what did it look like while it was still streaming?

Only after that loop exists do we systematically replace the UI. We still build
specialized components and formatters because Agent Code should be known for
excellent rendering. The difference is that specialization is now driven by a
finite reviewed inventory instead of whichever examples happen to be in the
current agent's context window.

The component rule is equally blunt:

> Every distinctive raw shape gets a catalog entry and fixture. Every meaningful
> visual grammar gets a component. Those are not the same cardinality.

`Bash`/command execution is a component family; `git status`, `npm test`, and
millions of possible commands are not millions of components. Proven command
grammars can add conservative formatters, colors, icons, summaries, and links
inside the command component while the bounded raw output remains available.

Provider isolation is also non-negotiable:

> Claude and Codex do not share a raw interpretation layer. Claude's code-edit
> component maps Claude shapes into a shared code-edit visual protocol. Codex's
> code-edit component independently maps Codex shapes into that same protocol.
> The shared code-edit view receives only the protocol. A future provider may
> reuse it by writing its own adapter, or decline it if its semantics do not fit.

This plan therefore keeps the ownership ledger that already works, builds the
shape-memory system first, and then rebuilds the painter family by family with
provider-owned interpretation and narrowly shared visual protocols.

## What the previous draft of this plan got wrong

The first version correctly rejected `presentation/`, protected provider
boundaries, and separated shapes from components. It still read like a set of
guardrails because it omitted the operational center of the idea:

- no exact Unknown Shape Inbox workflow;
- no sighting, catalog, render-decision, or fixture contracts;
- no precise storage and privacy design;
- no developer commands/reporting loop;
- no full visual contract for the operation families;
- no concrete live/committed handoff architecture;
- no task-level implementation sequence with file targets and cutover gates.

The remainder of this document supplies those missing contracts. The earlier
guardrails remain, but they are constraints around a complete system rather
than the substance of the plan.

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
- Extend the existing recorder, replay, unknown registry, and fixture corpus.
  Do not build a second evidence framework or filter explicit developer
  evidence through the replay redactor.
- Treat live conditions as a parallel provider-owned system. Do not route
  compaction, approvals, trust prompts, or pickers through ordinary tool cards.
- Make no broad file moves or naming changes in the first implementation PRs.
  A new directory is created only when the first real responsibility needs it.

## The complete development loop

This is the feature at the center of the plan. It is an explicit loop, not a
collection of diagnostics that a developer has to remember how to combine.

### Step 1 — start a rendering evidence capture

The Dev Debug command palette exposes:

- `Start Rendering Evidence Capture` for the focused session;
- `Stop Rendering Evidence Capture`;
- `Open Unknown Shape Inbox`;
- `Attach Rendering Evidence Note`;
- `Export Unknown Shape Report`.

Starting a rendering evidence capture reuses the existing session recorder. It
does not create another raw event log. The recorder continues to own the nine
`SessionFeed` channels, caps, retention, append ordering, note markers, and
exact developer-evidence extraction path.

The command additionally enables the renderer-side **shape observer** for that
session. The observer is off in normal production use. An explicit environment
flag may enable it for an unattended development soak, but there is no hidden
always-on telemetry and no external upload.

### Step 2 — observe renderer-facing shapes and outcomes

The observer sees the values at the point where the painter is about to ask a
provider to interpret them. It records four categories:

1. committed tool use/result pairs;
2. live semantic tool blocks and meaningful input/output prefixes;
3. provider-normalized transcript/system entry kinds;
4. live condition records and their intended UI surface.

It does **not** replace the full session recording. The recording preserves the
source event window; the sighting preserves the structural identity and what the
renderer did with it.

Every observation produces a metadata-only `RenderShapeSighting`:

```ts
type RenderShapePlane =
  | "committed-tool-use"
  | "committed-tool-result"
  | "semantic-tool"
  | "transcript-entry"
  | "condition";

type RenderShapeLifecycle =
  "prefix" | "input-complete" | "running" | "result-complete" | "durable";

type RenderOutcome =
  | {
      kind: "specialized";
      shapeId: string;
      rendererId: string;
      protocolId?: string;
    }
  | {
      kind: "generic";
      shapeId?: string;
      rendererId: "shared.generic-tool";
    }
  | {
      kind: "absorbed";
      shapeId?: string;
      ownerRenderId: string;
      reason: string;
    }
  | {
      kind: "condition-surface";
      shapeId: string;
      surface: "outlet" | "feed-inline" | "composer" | "attention-only";
    }
  | {
      kind: "unknown";
      fallbackRenderId: string;
    };

type RenderShapeSighting = {
  schemaVersion: 1;
  sessionId: string;
  provider: AgentProviderKind | "unknown";
  providerVersion: string | null;
  model: string | null;
  sourcePlane: RenderShapePlane;
  lifecycle: RenderShapeLifecycle;
  eventType: string;
  structuralFingerprint: string;
  shapePaths: readonly string[];
  discriminatorValues: Readonly<Record<string, string>>;
  payloadHash: string;
  sourceRecordingCursor: number | null;
  observedAt: number;
  outcome: RenderOutcome;
};
```

The structural sidecar does not duplicate prompt, command, assistant text, tool
arguments, tool output, or condition scalar content because the linked explicit
developer recording already preserves those values exactly. `payloadHash` is a
content-sensitive local sample identity and is never treated as the shape id.
`shapePaths` retains the complete bounded literal key tree, including path-like
and auth-shaped keys, while catalog identity separately normalizes dynamic maps
so one grammar does not mint a fingerprint per filename.

### Step 3 — deduplicate before crossing IPC

The observer keeps a bounded per-session map keyed by:

```text
provider + plane + lifecycle + eventType + structuralFingerprint + outcome kind
```

Repeated deltas for the same shape increment counters locally. Only a newly
observed fingerprint, an outcome transition, a lifecycle milestone, or the final
count flush enters the outbound queue. The queue is coalesced and hard-capped.

This matters because the renderer-freeze incident showed that a diagnostic can
become the performance bug. We do not send one IPC message per token. A long
stream of one known partial JSON structure should normally create a handful of
milestone sightings, not thousands of messages.

The main process appends the coalesced metadata as a synthetic
`__render_shape` recording line. Like existing `__note` lines, replay ignores it
as an input event while extraction and auditing consume it. A diagnostics
failure is swallowed, counted, and surfaced in the debug panel; it never blocks
the provider, ownership ledger, or painter.

### Step 4 — compare against the checked-in catalog

At sighting time the observer loads a compiled read-only fingerprint index from
the provider catalogs. The result is one of:

- **known and correctly claimed** — fingerprint is catalogued and the outcome
  points at the declared renderer/destination;
- **known but misrouted** — catalog says code edit, but the generic fallback or
  another renderer handled it;
- **known but unsupported in this lifecycle** — final shape exists but this
  meaningful prefix has no declared behavior;
- **unknown structural shape** — no catalog entry owns the fingerprint;
- **unknown outcome** — a catalogued shape silently vanished or was absorbed by
  an undeclared owner.

The last four enter the local Unknown Shape Inbox. Known sightings still update
counts/provenance in the local report so provider/model drift is observable.

### Step 5 — inspect the Unknown Shape Inbox

The first implementation can be a simple Dev Debug module rather than a polished
product screen, but it must show enough to work without reading JSONL by hand:

- provider, provider version, and model;
- structural fingerprint and event discriminator;
- source plane and lifecycle milestone;
- first/last seen and count;
- current rendering outcome;
- complete bounded literal shape key tree;
- links to the source recording and nearest note/event cursor;
- whether a complete local fixture draft can be extracted;
- classification state and catalog match if one exists under another version.

The inbox groups by structural fingerprint, not payload hash. It is local,
bounded, and survives app restart through the recording sidecars. It is not a
second database: the report is derived from the recordings plus checked-in
catalogs.

### Step 6 — classify an unknown shape

Classification is a reviewed code change, not a button that edits source code
at runtime. The developer chooses exactly one disposition:

```ts
type RenderShapeDisposition =
  | {
      kind: "specialized";
      rendererId: string;
      protocolId?: string;
    }
  | {
      kind: "generic";
      rendererId: "shared.generic-tool";
      reason: string;
    }
  | {
      kind: "absorbed";
      ownerRendererId: string;
      reason: string;
    }
  | {
      kind: "condition-surface";
      surface: "outlet" | "feed-inline" | "composer" | "attention-only";
    }
  | {
      kind: "planned";
      targetGrammar: string;
    }
  | {
      kind: "unsupported";
      reason: string;
    };
```

`absorbed` is deliberately explicit because hiding is the most dangerous
operation in the renderer. A tool-result envelope can be absorbed into its
operation row only when it names the owning render id and a fixture proves that
the useful result remains visible. `unsupported` still renders a visible
fallback; it means no specialization is promised, not that the row disappears.

### Step 7 — extract a shape fixture

The audit script takes a fingerprint or inbox entry, follows its recording
cursor, and emits the smallest useful local evidence package containing:

- the final renderer-facing input;
- meaningful streaming prefix milestones;
- paired result/condition state when applicable;
- provider/model/version provenance;
- expected ownership key and stable render id inputs;
- the current outcome receipt;
- exact bounded raw context needed to reproduce parsing;
- a human description from the attached note or classification command.

The extractor deliberately does not redact this local developer draft. Unknown
rendering behavior can depend on scalar content, and transforming that evidence
before diagnosis makes the capture less trustworthy than its source recording.
Classification and curation remain reviewed code changes before a draft becomes
a checked-in fixture.

Shape fixtures live separately from whole-session recordings because they serve
a different test altitude:

```text
testing/fixtures/rendering-shapes/<provider>/<shape-id>/
  manifest.json          # provenance, fingerprints, planes, expected owner
  final.json             # minimal complete input/result
  prefixes.json          # selected meaningful prefix milestones
  expected.json          # render decision + protocol/view snapshot
```

This new directory is justified by behavior, not aesthetics: recording fixtures
replay multi-event ownership over time; shape fixtures pin one provider parser
and component grammar. Neither can replace the other.

### Step 8 — bind the fixture to a typed provider shape definition

Every catalogued shape uses one common declaration schema. This is the useful
version of the requested base definition: shared compile-time metadata and
coverage requirements, without React class inheritance or shared parsing.

```ts
type RenderShapeDefinition<
  P extends AgentProviderKind,
  Id extends `${P}.${string}`,
> = {
  id: Id;
  provider: P;
  fingerprints: readonly string[];
  eventTypes: readonly string[];
  planes: readonly RenderShapePlane[];
  lifecycles: readonly RenderShapeLifecycle[];
  observed: {
    providerVersions: readonly string[];
    models: readonly string[];
    firstSeen: string;
    lastSeen: string;
  };
  fixtures: {
    final: readonly string[];
    prefixes: readonly string[];
  };
  disposition: RenderShapeDisposition;
  why: string;
};

export function defineRenderShape<
  P extends AgentProviderKind,
  Id extends `${P}.${string}`,
>(definition: RenderShapeDefinition<P, Id>): RenderShapeDefinition<P, Id> {
  return definition;
}
```

Claude definitions live under Claude, Codex definitions under Codex, and so on.
The common type makes missing fixtures, provider-prefix mistakes, and invalid
dispositions compile/test failures. It does not contain a `match()` or
`render()` function; runtime provider interpretation remains ordinary explicit
provider code and can be reviewed independently from catalog metadata.

### Step 9 — implement or reuse the renderer

A specialized catalog entry must point to a stable `rendererId`. The provider's
dispatch claims the shape id and produces a render decision. The coverage suite
checks both directions:

- every specialized catalog shape is claimed by the declared provider renderer;
- every provider renderer claim names a catalogued shape;
- every shared protocol use is produced by a provider-owned adapter;
- no shared protocol component accepts provider wire types;
- generic/absorbed/condition dispositions match their actual outcome.

### Step 10 — make the inbox go empty for the right reason

After the catalog, fixture, adapter, component, and tests land, replay the
source recording. The inbox item closes only if the same fingerprint now
produces the declared outcome at every required lifecycle milestone. Renaming
the fingerprint, deleting the sighting, or marking an unknown as hidden without
a fixture does not close it.

This loop is the institutional memory. Future agentic development can add a
provider or tool by following evidence instead of rebuilding a mental model of
the entire renderer.

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

### One directory per distinguished component (2026-07-16 amendment)

Product-owner correction issued during Phase 6 implementation, superseding the
single-file `rows/<Provider>Rows.tsx` grab-bag the examples above sketched:
**every distinguished component a provider renders gets its own directory,
even while it is one file.**

```text
src/providers/<provider>/renderer/
  adapters/*.ts                      # wire -> protocol model mapping (not components)
  components/
    <component>/index.tsx            # ONE distinguished component per directory
  rows/dispatch.tsx                  # the provider dispatch table
```

Realized during the implementation PR (#555): Claude ships
`components/{edit,multi-edit,write,bash}/`; Codex ships
`components/{apply-patch,exec-command,write-stdin,tool,tool-result}/`;
OpenCode ships `components/read-result/`; the provider-neutral todo checklist
lives at `providers/shared/renderer/components/todo/`. When OpenCode grows a
write component, it becomes `providers/opencode/renderer/components/write/` —
never a case in a shared file, never a sibling function in another
component's file.

Why a directory rather than a flat `components/<component>.tsx` file:

- The directory is the **unit of ownership**. A component's fixtures,
  sub-parsers, helper views, and tests land beside it instead of accreting
  into a shared file — `ClaudeRows.tsx` grew past 300 lines of four unrelated
  components exactly that way before the split.
- `ls components/` **is the coverage list**: the tree itself documents which
  operations each provider renders specially, which is the question the shape
  catalog audit asks. A missing directory is a visible gap, not a missing
  branch inside a monolith.
- Growth is **additive**: upgrading a component from one file to several
  (model + view + fixtures) changes nothing outside its directory.

The same rule applies **inside shared protocol families**: command formatters
are `protocols/command/formatters/<family>/index.ts` (e.g. `tests/`, `json/`,
`file-mutation/`), registered in priority order by
`protocols/command/formatters/index.ts`. A new family is one new directory
plus one registry line.

A formatter that earns richer UI may own a typed model, conservative detector
and parser over normalized command evidence, a model-only body component, and
tests inside that directory. Git is the motivating case because its existing
feed UI already has six evidence-backed card grammars. This does not relax the
boundary: provider adapters must pair and normalize the operation first, the
formatter must decline on uncertainty, and bounded raw output remains
available. Formatter directories must never become a second shared wire-shape
classifier.

Two deliberate survivors of the split, both temporary: `rows/ClaudeRows.tsx`
and `rows/CodexRows.tsx` remain as **re-export barrels with zero logic**,
because the feed's live painter (`BlockRow.tsx`) imports provider rows through
exactly those specifiers and the import-boundary test grandfathers them by
exact string match. Keeping the specifiers stable means the restructure adds
zero new feed→provider edges. Provider-internal code imports the component
directories directly, never the barrels; the barrels are deleted together
with their `GRANDFATHERED` entries when BlockRow migrates to
`renderOperation`.

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

## Concrete paint architecture

### Freeze the boundary that already works

The existing pipeline remains:

```text
provider channels
  -> SessionRuntime ingest
  -> ownership/order ledger
  -> FeedRenderItem[]
  -> feed painter
```

`FeedRenderItem[]` remains the clean boundary. This project does not change
ghost reconciliation, ownership, ordering, suppression evidence, or the stable
identity rules that fixed the historic duplicate/vanish/buried-row bugs.

The painter may derive visual information, but it does not decide whether an
item is visible. If a proposed renderer needs to hide or merge an independently
owned item, that absorption must be represented by a receipt and proven against
the ownership fixture corpus.

### One provider operation boundary, not one shared interpreter

The feed bridge constructs a neutral envelope containing the data the provider
renderer may inspect. It does not classify it:

```ts
type ProviderOperationInput =
  | {
      plane: "committed";
      provider: AgentProviderKind;
      renderId: string;
      toolUse: ToolUseBlock;
      toolResult: ToolResultBlock | null;
      workspaceRoot: string | null;
    }
  | {
      plane: "live";
      provider: AgentProviderKind;
      renderId: string;
      block: SemanticLiveBlock;
      workspaceRoot: string | null;
    };

type ProviderRenderDecision =
  | {
      kind: "rendered";
      shapeId: string;
      rendererId: string;
      node: ReactNode;
      protocolId?: string;
    }
  | {
      kind: "generic";
      shapeId?: string;
      reason: string;
    }
  | {
      kind: "absorbed";
      shapeId: string;
      ownerRenderId: string;
      reason: string;
    }
  | {
      kind: "unclaimed";
      structuralFingerprint: string;
    };
```

The capability registry gains one narrow optional operation method only when
the first vertical slice needs it:

```ts
renderOperation?: (input: ProviderOperationInput) => ProviderRenderDecision
```

The shared bridge does only three things:

1. selects the provider capability;
2. records the returned decision as the paint/sighting receipt;
3. uses the bounded generic fallback for `generic` or `unclaimed`.

It never switches on tool name, reads wrapper JavaScript, parses provider JSON,
or maps provider values into an operation family.

### Provider-specific components remain real components

Each provider owns an explicit dispatch and meaningful components:

```text
src/providers/claude/renderer/
  shapes.ts
  operations/
    renderClaudeOperation.tsx
    ClaudeCodeEditOperation.tsx
    ClaudeCommandOperation.tsx
    ClaudeReadOperation.tsx
  adapters/
    codeEdit.ts
    command.ts

src/providers/codex/renderer/
  shapes.ts
  operations/
    renderCodexOperation.tsx
    CodexCodeEditOperation.tsx
    CodexCommandOperation.tsx
    CodexReadOperation.tsx
  adapters/
    codeEdit.ts
    unifiedExec.ts
    command.ts
```

This tree appears incrementally. The first Claude edit lands the Claude files;
the first Codex edit lands the Codex files. We do not create every filename in
advance.

The provider component owns:

- recognition of its tool/event vocabulary;
- parsing complete and partial inputs;
- live-versus-committed evidence precedence;
- provider-specific lifecycle facts and labels;
- mapping to a shared protocol when that protocol is semantically honest;
- choosing a provider-specific view when no shared protocol fits;
- declaring its shape id and renderer id in the returned receipt.

Claude's component never imports Codex. Codex's component never imports Claude.
A provider can change its wrapper format without creating a shared blast radius.

### Shared visual protocols are narrow leaf contracts

The shared directory contains protocols such as:

```text
src/providers/shared/renderer/protocols/
  code-edit/
    model.ts
    CodeEditView.tsx
    CodeEditView.test.tsx
  command/
    model.ts
    CommandView.tsx
    formatters/
      git/
        model.ts
        detect.ts
        parse.ts
        GitCommandBody.tsx
        index.ts
        git.test.tsx
  compaction/
    model.ts
    CompactionView.tsx
    CompactionView.test.tsx
  structured-tool/
    model.ts
    StructuredToolView.tsx
```

An example mapping is deliberately one-way:

```ts
// Claude-owned
function toClaudeCodeEditModel(input: ClaudeEditEvidence): CodeEditRenderModel;

// Codex-owned
function toCodexCodeEditModel(input: CodexPatchEvidence): CodeEditRenderModel;

// Shared leaf view — it cannot name Claude or Codex
function CodeEditView(props: { model: CodeEditRenderModel }): ReactNode;
```

The shared protocol contains visual truth only: files, hunks, line kinds,
counts, paths, status, diagnostics, source availability, and stable ids. It does
not contain a `provider` switch or raw escape hatch that lets the shared view
start parsing again.

If the providers need visibly different chrome, their components wrap or
compose the shared view. Sharing code-edit line rendering does not require
sharing the entire provider operation component.

### The common base is a contract and primitives, not inheritance

The user explicitly proposed a base definition that components could inherit so
future agents would not forget the obligations shared by every shape. We keep
that intent, but implement it as a typed contract plus composition because React
inheritance would couple unrelated visual grammars to one base card. The
requested common definition therefore exists at two useful altitudes:

1. every raw shape satisfies `RenderShapeDefinition` and therefore has the
   same evidence, fixture, disposition, and provenance obligations;
2. visual components compose primitives such as `OperationFrame`,
   `StatusLabel`, `PathLabel`, `BoundedOutput`, `Disclosure`, `DiffHunk`, and
   `AnsiText` where those primitives fit.

We do not force every component into the same card rectangle. A one-line wait,
a streaming patch, a question picker, and a generated image should have
different grammars. The common contract makes them accountable; composition
makes them visually consistent without flattening their identity.

### Stable row identity through streaming and commit

The user-facing rule from PR #524 remains correct:

> The row that appears when an operation begins remains the same row while its
> input streams, while it runs, when output arrives, and when committed evidence
> replaces semantic evidence. Completion is a props update, not another
> renderer suddenly winning.

The ownership layer already decides the logical source. The painter derives a
stable `renderId` using the provider call/tool id first, then upstream item id,
then committed block id, then the existing source-item/block-index fallback.
Both live and committed provider operation envelopes route through the same
`ProviderOperationBoundary` component type and the same provider renderer.

Provider adapters must prove monotonic interpretation:

- unknown/preparing may become a specific grammar;
- partial fields may become complete;
- running may become success/failure/denied/cancelled;
- a structurally proven grammar never falls back to generic merely because a
  later provider event is sparse;
- committed evidence may correct details, but must not remount a different
  provider component for the same logical operation.

Prefix fixtures assert React key and outer DOM-node stability for the highest
value streaming shapes.

### Total paint accountability

Every `FeedRenderItem` and every provider operation decision has one outcome:

- rendered by a declared provider component;
- rendered through a declared shared protocol;
- rendered by the bounded generic fallback;
- absorbed into a named owning render id with a reason;
- routed to a named non-feed condition/composer surface.

There is no silent `return null`. Known transport-only ticks may be absorbed,
but the receipt must say which visible operation owns their useful information.
The receipt is both the debug fact and the Unknown Shape Inbox outcome; there is
no parallel explainer that can disagree with the paint.

## Evidence system

### Reuse what already exists

The repository already has most of the hard infrastructure:

- `SessionRecorder` with bounded local capture and retention;
- replay through the real reducers;
- explicit developer recordings that preserve exact provider events;
- `UnknownRegistry` with shape paths, payload hashes, counts, and dispositions;
- recording and bundle corpus tests;
- tick-by-tick replay that can exercise streaming prefixes;
- 48 existing rendering bundles/fixtures that can seed the inventory.

The implementation should extend these paths. A parallel recorder or fixture
framework would duplicate cap, replay, and incident hardening.

### Canonical shape identity

Introduce one pure, shared structural fingerprint helper near the existing
unknown-shape code. Its inputs are:

- provider and observation plane;
- event/tool discriminator;
- normalized key/type identity paths, alongside complete literal key evidence;
- an explicit allowlist of low-cardinality structural values.

Its output is a stable short fingerprint. It never includes scalar prompt text,
command text, assistant text, tool payload values, or result prose. Literal
path-like object keys remain in sightings while the identity projection
normalizes them for catalog stability.

Keep the existing payload hash as a separate sample/dedup identity. The shape
catalog groups by structural fingerprint; sightings may count distinct payload
hashes within that group.

### Per-provider typed catalogs

Start with one `shapes.ts` file per provider, using a checked literal rather
than a code generator:

```ts
export const CODEX_RENDER_SHAPES = {
  "codex.unified-exec.command.v1": {
    fingerprint: "…",
    plane: ["live", "committed"],
    status: "rendered",
    destination: "command",
    fixtures: ["…"],
  },
  "codex.unified-exec.apply-patch.v1": {
    fingerprint: "…",
    plane: ["live", "committed"],
    status: "planned",
    destination: "code-edit",
    fixtures: ["…"],
  },
} as const satisfies RenderShapeCatalog;

export type CodexRenderShapeId = keyof typeof CODEX_RENDER_SHAPES;
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

- emit structural sightings with complete bounded literal keys;
- deduplicate by fingerprint and increment counts;
- keep all buffers bounded;
- do not duplicate bulky scalar values into the shape sidecar because the
  linked developer recording is already their exact source of truth;
- ensure observer failure cannot affect rendering or session execution;
- reuse the existing recording/debug gate rather than enabling continuous
  production capture by accident.

**Offline extraction and review:**

- aggregate sightings from exact developer recordings;
- suggest new catalog entries and representative fixture windows;
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
- keep exact bounded local windows for diagnosis, never for shape identity;
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

When a conclusion line cannot preserve the proven interaction grammar, a
formatter may return a typed rich body over its protocol model. It still obeys
the same decline and raw-evidence rules. The Git formatter is the first planned
example: status, diff, add, commit, log, and push may keep their specialized
cards after they consume one paired, provider-normalized command operation.

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

## Exceptional rendering contract

The evidence system is not an excuse to settle for generic JSON. The following
is the intended product behavior. Each provider reaches it through its own
adapter/components and the fixtures it actually emits.

### Global interaction rules

**Truncate by default is a global product rule, not a workflow-only detail.** A
tool or operation first paints one useful line and an affordance to expand. It
must not dump a complete command, argument object, MCP payload, assistant body,
or result into the activity surface merely because the value is available. A
family may show a small live preview when that preview is the useful result, but
the bounded full detail remains behind disclosure.

Every operation presents three levels of information:

1. **Always visible:** verb, subject, status, and the most useful result/count.
2. **Inline when useful:** a small live preview such as diff lines, terminal
   output, found paths, selected option, or active plan step.
3. **Expandable:** complete bounded/paged output, parameters, source wrapper,
   verbose metadata, and debug evidence.

Raw wrapper JavaScript, escaped JSON, provider XML/tag soup, response-item kind
names, and MCP envelopes are debug source. They are never the default UI.

Specialized interpretation enriches rather than destroys the evidence. A test
summary appears above the command output; it does not replace the output. A
parsed patch view keeps a debug/source expansion. When confidence is weak, the
renderer visibly degrades to structured generic output instead of inventing a
meaning.

All large values are bounded before expensive work. Closed disclosures unmount
heavy children. Old transcript rows stay lazy. Streaming paths avoid whole-body
Markdown, JSON, ANSI, syntax-highlighting, or Monaco work on every token.

### Code edits and file writes

Covered evidence includes:

- Claude Edit, MultiEdit, Write, NotebookEdit, and future observed variants;
- Codex classic apply-patch, unified-exec patch wrappers, standalone patch
  completion events, and future observed variants;
- OpenCode edit/write/patch parts after fixtures prove their exact structures;
- shell edits only when a conservative provider-owned command formatter proves
  the mutation grammar.

Always-visible header:

- Creating, Editing, Moving, or Deleting;
- workspace-relative path as soon as it is knowable;
- file count for multi-file operations;
- added/removed totals;
- running/success/failure/denied/cancelled status;
- error summary without requiring expansion.

Inline body:

- line-by-line red/green/context diff;
- stable line/gutter identity as the patch streams;
- unfinished tail updates in place;
- per-file headers for a multi-file patch;
- first/last windowing and an explicit hidden-line count for huge diffs;
- open-file/copy actions where the path is safe and resolvable.

Write is presented honestly:

- new file: content as additions;
- overwrite with known before state: before/after diff;
- overwrite without known before state: labeled new-content view rather than a
  fabricated semantic diff.

Token presentation has independent layers:

1. plain text immediately;
2. cached lexical tokens on sealed lines;
3. optional semantic-token replacement when an existing LSP can provide
   trustworthy context cheaply.

Diff background communicates addition/removal; syntax token colors communicate
language semantics. Color is accompanied by `+`/`-`, labels, counts, and status
text. The renderer never mounts/recreates a Monaco model for every delta.

The provider-specific difference remains visible where useful. A Claude Edit
component and Codex Patch component may use different verbs or evidence labels
while both map their hunks into `CodeEditRenderModel` and compose the same
`CodeEditView`.

### Commands and terminal interaction

Covered evidence includes Claude Bash/PowerShell, Codex classic and unified
exec-command/local-shell calls, OpenCode bash, write-stdin, background-session
continuation, wait/poll calls, and future catalogued variants.

Always-visible header:

- Running/Ran/Failed/Timed out/Waiting/Sent input;
- syntax-highlighted command;
- cwd when it differs from the workspace root;
- provider description when present;
- elapsed/final duration;
- exit code, timeout, background session id, or failure state.

Inline output:

- live ANSI with control-sequence stripping and span caps;
- useful recent output while running;
- head and tail on completion so the command and final test/error summary both
  survive truncation;
- explicit byte/line truncation counts;
- failure lines and exit status visible without opening the full output;
- paged/lazy expansion rather than mounting megabytes at once.

Reliably correlated `write_stdin` and wait/poll operations fold into the
originating command. Uncorrelated cases receive compact explicit rows. Empty
poll ticks can be absorbed only with a receipt naming the command that owns the
progress.

Command-specific presentation is a formatter decision:

- git may show branch/status/diff intent with a git accent and, where fixtures
  prove it, a rich formatter-owned status/diff/add/commit/log/push body;
- test runners may show passed/failed/skipped totals;
- compiler/linter output may group diagnostics and link `path:line:column`;
- JSON may render as bounded key/value/table data;
- URLs and safe paths may become links;
- build/deploy commands may expose a proven final status.

Each formatter has a stable grammar and fixtures. It returns `null` on
uncertainty, never runs arbitrary command output, and never removes the raw
bounded output. This is how Agent Code can make different command families
distinctive without pretending every command is a new component.

This migration applies only to feed rendering. The persistent workspace Git
bar remains an independent product surface under `features/git/`; sharing its
domain helpers is allowed only where their inputs are already provider-neutral.

### Reads, searches, and discovery

Covered evidence includes Read/FileRead/OpenCode read, Grep/Glob/LS and their
provider variants, Codex exec wrappers that the Codex adapter proves are reads,
tool search, transcript search/read, and catalogued workspace discovery calls.

The component distinguishes:

- reading a file or range;
- listing paths;
- searching text;
- searching tools/resources;
- inspecting another agent transcript.

The header exposes target, query/pattern, include filter, offset/range, and
result count. Results use safe file links, match highlighting, and bounded
expandable code/text. A burst of completed low-signal reads may use the existing
collapsed activity grammar, but the active or failed lookup stays individually
visible and every absorbed read retains a receipt.

### Web, citations, and fetched content

Claude WebSearch/WebFetch, Codex web search/open/find, OpenCode equivalents, and
assistant citation records remain provider-owned interpretations.

The visual grammar shows:

- Searching/Searched/Opening/Opened/Found/Failed;
- actual query or action;
- target domain/URL;
- progress and result count when known;
- linked source titles/domains;
- fetched content collapsed by default;
- assistant citations as a useful compact source list, not merely a count.

### Collaboration and subagents

Covered evidence includes Claude Agent/Task, Codex spawn/send/follow-up/wait/
list/read/interrupt/close, Agent Code orchestration MCP variants, task
notifications, tracked subagent state, and future provider equivalents.

The grammar distinguishes:

- **spawn:** role, nickname, prompt summary, model, status;
- **message:** target and concise sent text;
- **wait:** target set, current states, elapsed time;
- **list:** structured agent table;
- **read output:** linked child plus recent/final response;
- **interrupt/close:** target and outcome.

Reuse the existing child drill-in and mini-feed behavior. A spawn result envelope
may be absorbed into the spawn row only when the final child report remains
available through its own owned source. The regression where spawn suppression
destroyed final reports gets an explicit fixture.

### Tasks, todos, plans, schedules, skills, and workflows

TodoWrite/todowrite, task create/update/list/get/output/stop, Codex update-plan,
plan-mode records, schedules/sleeps/wakeups, skills, and Workflow MCP calls use
checklist and lifecycle language rather than JSON archaeology.

- plan steps show pending/in-progress/completed;
- task mutations say what changed and to which task;
- schedules show when and why;
- skills show the selected skill and meaningful arguments;
- workflows show name, run/resume relationship, phase, agent progress,
  completion status, and final result/coverage gaps;
- a workflow tool call remains a concise one-line row until expanded, matching
  the user's prior requirement that full tool payloads not flood activity UI.

Workflow rendering consumes bounded Workflow MCP event models. It does not
reintroduce high-frequency raw workflow payloads into the normal feed.

### Questions and blocking interaction

AskUserQuestion/request-user-input presents question text, options,
single/multi-select state, free-text affordance, and the durable answer after
completion.

Clickability comes from the authoritative live condition that owns input, not
from the mere presence of a transcript row. A historical question renders as a
record and cannot send stale keystrokes. This is a prime example of a provider
component consuming both durable feed evidence and a separate live condition
for interaction gating without merging their ownership systems.

### MCP and generic structured tools

Generic MCP is a visual protocol, not one component per server.

Always-visible header:

- Calling/Called/Failed;
- humanized tool name;
- server badge;
- a concise headline selected from safe path, URL, query, title, description,
  target, or other declared scalar fields.

Input presentation:

- small scalar objects as bounded key/value rows;
- paths and URLs linkified conservatively;
- nested/large values behind lazy expansion;
- explicit truncation;
- raw JSON/source available for copy/debug.

Output dispatch is based on declared MCP content blocks:

- text/ANSI text;
- JSON/table-like data;
- image or safe data URL;
- audio/file attachment metadata;
- embedded resource;
- resource link;
- explicit empty result;
- error.

Known Agent Code orchestration/workspace/workflow tools route through richer
provider-owned components before generic MCP. A server-specific component is
created only when repeated fixtures prove the generic typed grammar is not good
enough.

### Images, notebook, LSP, workspace, and system records

- Base64 and URL images render inline with source/alt metadata and a safe open
  action.
- Image generation shows live status, revised prompt when safe, generated
  preview, and saved path.
- View-image shows the target path and actual image when available.
- Notebook edit shows notebook path, cell id/type/mode, and a highlighted cell
  diff.
- LSP operations show operation, symbol/file/range, result count, and linked
  locations.
- Workspace/worktree/config operations show the concrete state transition.
- Hooks, provider notices, file snapshots, errors, and compaction use intentional
  system grammars.
- An unknown committed block kind paints a bounded fallback with its catalog/
  fingerprint status; it never becomes an empty text branch.

### Fallback quality is part of the product

The fallback is not a punishment card. It should still provide:

- humanized operation name and provider/server;
- one safe headline;
- bounded parameter summary;
- bounded/lazy result;
- status and error;
- developer-only shape fingerprint and inbox link;
- debug source behind explicit expansion.

This keeps the app usable the first time an upstream provider ships a new shape
and gives the development system the evidence needed to specialize it later.

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
   The feed currently renders those through the central
   `CompactBoundaryRow` / `CompactSummaryRow` exception. Phase 10 replaces that
   exception with provider-owned compaction adapters/components backed by a
   model-only shared compaction protocol.

The live strip must not be converted into a feed tool card, and the durable
summary must not depend on a still-live condition snapshot. Restart/replay must
recover the durable entries even though the transient condition is gone.

The condition transport must not become the semantic owner of compaction.
Phase 10 inventories Claude's proxy/semantic compaction-synthesis signals plus
committed `compact_boundary` / `compact_summary` evidence, Codex's semantic
`compaction` event plus durable `compacted` evidence, and OpenCode only when
recordings prove a signal. Structured semantic/proxy events are preferred for
live state. Screen parsing remains only as an explicit compatibility fallback
for provider versions with no usable structured live signal.

When structured and screen signals both fire, provider-owned precedence,
deduplication, and provenance rules must yield one monotonic running → error or
done lifecycle. The observer records structure and source, never raw summary or
screen text. Tests must cover structured-only operation with screen detection
disabled, screen-only fallback, both-source agreement, disagreement, terminal
error/done, and restart/replay of the independent durable entries.

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

The initial catalog matrix is explicit:

| Condition kind             | Owner    | Surface         | Attention/action behavior         |
| -------------------------- | -------- | --------------- | --------------------------------- |
| `claude.trust-dialog`      | Claude   | modal outlet    | trust + blocking action           |
| `claude.permission-prompt` | Claude   | modal outlet    | action + blocking action          |
| `claude.resume-prompt`     | Claude   | strip outlet    | resume + blocking action          |
| `claude.compaction`        | Claude   | read-only strip | attention only on error           |
| `claude.ask-user-question` | Claude   | feed-inline     | question + blocking custom action |
| `claude.slash-picker`      | Claude   | composer        | no dispatch attention badge       |
| `codex.trust-dialog`       | Codex    | modal outlet    | trust + blocking action           |
| `codex.approval`           | Codex    | strip outlet    | action + blocking action          |
| `opencode.permission`      | OpenCode | provider outlet | custom HTTP resolution            |
| `opencode.question`        | OpenCode | provider outlet | custom HTTP resolution            |

This table is seeded from current code, then made executable through provider
catalog definitions and coverage tests. New kinds are added from captured
evidence. A condition may have multiple structural fingerprints across provider
versions while keeping one semantic kind/view.

Condition fixtures cover the full detector lifecycle, not only the final state:

- absent screen/event -> no condition;
- recognizable prefix -> live condition with bounded state;
- option/cursor changes -> same condition kind and view;
- resolution -> condition disappears while durable feed evidence survives;
- malformed/unknown state -> no unsafe action, plus an inbox sighting.

The observer records condition state structure and destination in its compact
sidecar. The full explicit developer recording retains the complete question,
command, workspace, and option text, and the extractor preserves an exact
bounded window in its local draft.

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

Phase 10 may colocate each provider's compaction condition adapter/view under
`renderer/conditions/compaction/` and its durable feed component under
`renderer/components/compaction/`. That is an ownership-preserving directory
move, not a merger of live and durable semantics. It may also replace
screen-primary detection after structured-event fixtures prove parity; it must
retain a documented screen fallback wherever the evidence says one is still
required.

## Testing contract

Every visual family lands through fixtures before broad integration.

### Shape and catalog tests

- structural fingerprint stability with complete literal-key sightings and
  low-cardinality identity normalization;
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

## Repository change map

The following is the intended ownership map. Files/directories land only when
their phase has real content; this is not permission to scaffold the entire tree
in one PR.

```text
src/shared/types/
  renderShapes.ts                    common metadata-only contracts

src/renderer/src/rendering/evidence/
  shapeFingerprint.ts               literal key capture + normalized structural identity
  defineRenderShape.ts              catalog definition helper
  catalogCoverage.ts                fixture/catalog/claim audit

src/renderer/src/rendering/model/
  unknowns.ts                       structurally keyed unknown registry

src/renderer/src/features/feed/evidence/
  observer.ts                        bounded per-session sighting accumulator
  outcome.ts                         paint decision -> metadata-only receipt
  RenderShapeCaptureContext.tsx      capture gate/session binding

src/renderer/src/features/debug/devModules/RenderingShapes/
  UnknownShapeInbox.tsx              local grouped report
  unknownShapeReport.ts              derive report from sidecars + catalogs

src/main/recording/
  SessionRecorder.ts                 existing writer; accepts __render_shape
  SessionRecorderManager.ts          existing lifecycle; batched sighting append

src/main/ipc/devDebug.ts              dev-gated batch/report handlers
src/preload/api/devDebug.ts           metadata-only renderer API

src/providers/claude/renderer/
  shapes.ts                          typed Claude catalog
  operations/*                       Claude-only parsing/mapping + composition

src/providers/codex/renderer/
  shapes.ts                          typed Codex catalog
  operations/*                       Codex-only parsing/mapping + composition

src/providers/opencode/renderer/
  shapes.ts                          typed OpenCode catalog
  operations/*                       OpenCode-only parsing/mapping + composition

src/providers/shared/renderer/protocols/
  code-edit/*                        first proven shared visual protocol
  command/*                          later, after independent adapters exist
  structured-tool/*                  bounded long-tail protocol

scripts/
  audit-rendering-shapes.mjs         known/unknown/misrouted coverage report
  extract-rendering-shape.mts        fingerprint -> complete local draft

testing/fixtures/rendering-shapes/
  <provider>/<shape-id>/*             final/prefix/expected evidence
```

No current folder is renamed to make this map look cleaner. `presentation/` is
not introduced. `projection/` remains deferred. Existing provider `rows/` and
shared `rows/` coexist until each shape family has migrated and its old route is
provably unused.

### Concrete before-and-after tree

This is the filesystem contract for the complete program. The lean companion
shows only the responsibility-level tree; this long reference records the
expected additions and modifications so each implementation PR does not invent
a different home.

The map is incremental, not a request to scaffold empty directories. An added
path lands only when its phase has evidence and tests. A deletion candidate is
not deleted until catalog and replay gates prove that no shape still uses it.

Legend:

- `[=]` existing path whose responsibility remains unchanged;
- `[M]` existing file intentionally modified;
- `[A]` new file or directory;
- `[D?]` existing file eligible for later deletion only with proof;
- `[F]` repeated fixture files produced from reviewed evidence.

#### Before: the anchors we preserve

```text
src/renderer/src/rendering/
├── adapter/collectLedgerInput.ts                   [=] observation collection
├── model/
│   ├── ledger.ts                                   [=] ownership source of truth
│   ├── order.ts                                    [=] row ordering source of truth
│   ├── ownership.ts                                [=] ownership vocabulary
│   ├── types.ts                                    [=] ledger contracts
│   └── unknowns.ts                                 [M] unknown grouping evolves
├── observations/                                   [=] committed/live/local evidence
├── replay/                                         [M] shape-aware assertions
└── shadow/                                         [M] legacy/new outcome comparison

src/renderer/src/features/feed/
├── ledger/                                         [=] ledger -> FeedRenderItem
├── model/renderModel.ts                            [M] stable receipt references
└── ui/
    ├── Feed.tsx                                    [M] capture/operation boundary
    ├── rows/
    │   ├── EntryRow.tsx                            [M] provider delegation
    │   ├── ToolUseRow.tsx                          [M/D?] migration fallback
    │   ├── ToolResultRow.tsx                       [M/D?] migration fallback
    │   └── LazyEntry.tsx                           [=] lazy mounting
    └── semantic/                                   [M] family-by-family only

src/providers/
├── registry.renderer.capabilities.ts               [M] operation capability
├── claude/renderer/rows/                           [M/D?] current Claude rows
├── codex/renderer/rows/                            [M/D?] current Codex rows
├── opencode/renderer/rows/                         [M/D?] current OpenCode rows
└── shared/renderer/
    ├── conditions/                                 [=] parallel condition system
    └── rows/                                       [M/D?] current visual rows

src/renderer/src/features/debug/
├── devModules/registry.ts                          [M] register shape inbox
├── devModules/types.ts                             [=] debug module contract
└── ui/DevDebugPanel.tsx                            [=] module host

src/main/recording/
├── SessionRecorder.ts                              [M] shape sidecar records
└── SessionRecorderManager.ts                       [M] bounded batch routing

src/main/ipc/devDebug.ts                            [M] capture/report IPC
src/preload/api/devDebug.ts                         [M] renderer API
src/preload/api/types.ts                            [M] exposed typings
src/preload/api/index.ts                            [M] export wiring if needed
```

#### After: target tree when every phase is complete

```text
src/
├── shared/types/
│   └── renderShapes.ts                             [A]
│
├── renderer/src/
│   ├── rendering/
│   │   ├── adapter/collectLedgerInput.ts           [=]
│   │   ├── evidence/                               [A]
│   │   │   ├── shapeFingerprint.ts                 [A]
│   │   │   ├── shapeFingerprint.test.ts            [A]
│   │   │   ├── defineRenderShape.ts                [A]
│   │   │   ├── defineRenderShape.test.ts           [A]
│   │   │   ├── catalogCoverage.ts                  [A]
│   │   │   └── catalogCoverage.test.ts             [A]
│   │   ├── model/
│   │   │   ├── ledger.ts                           [=]
│   │   │   ├── order.ts                            [=]
│   │   │   ├── ownership.ts                        [=]
│   │   │   ├── types.ts                            [M]
│   │   │   ├── unknowns.ts                         [M]
│   │   │   └── unknowns.test.ts                    [M]
│   │   ├── observations/                           [=]
│   │   ├── replay/
│   │   │   ├── invariants.ts                       [M]
│   │   │   ├── invariants.test.ts                  [M]
│   │   │   ├── recordedSession.ts                  [M]
│   │   │   └── recordedSession.test.ts             [M]
│   │   └── shadow/
│   │       ├── shadowDiff.ts                        [M]
│   │       └── shadowDiff.test.ts                   [M]
│   │
│   └── features/
│       ├── feed/
│       │   ├── evidence/                           [A]
│       │   │   ├── RenderShapeCaptureContext.tsx   [A]
│       │   │   ├── observer.ts                     [A]
│       │   │   ├── observer.test.ts                [A]
│       │   │   ├── outcome.ts                      [A]
│       │   │   └── outcome.test.ts                 [A]
│       │   ├── model/renderModel.ts                [M]
│       │   └── ui/
│       │       ├── Feed.tsx                        [M]
│       │       ├── ProviderOperationBoundary.tsx   [A]
│       │       ├── ProviderOperationBoundary.test.tsx [A]
│       │       └── rows/
│       │           ├── EntryRow.tsx                [M]
│       │           ├── ToolUseRow.tsx              [M/D?]
│       │           ├── ToolResultRow.tsx           [M/D?]
│       │           └── UnknownOperationRow.tsx     [A]
│       │
│       └── debug/devModules/
│           ├── registry.ts                         [M]
│           └── RenderingShapes/                    [A]
│               ├── module.tsx                      [A]
│               ├── UnknownShapeInbox.tsx           [A]
│               ├── unknownShapeReport.ts           [A]
│               └── unknownShapeReport.test.ts      [A]
│
├── providers/
│   ├── registry.renderer.capabilities.ts           [M]
│   ├── registry.renderer.capabilities.operation.test.ts [A]
│   ├── claude/renderer/
│   │   ├── shapes.ts                               [A]
│   │   ├── shapes.test.ts                          [A]
│   │   ├── operations/                             [A]
│   │   │   ├── renderClaudeOperation.tsx           [A]
│   │   │   ├── renderClaudeOperation.test.tsx      [A]
│   │   │   ├── ClaudeCodeEditOperation.tsx         [A]
│   │   │   ├── ClaudeCommandOperation.tsx          [A]
│   │   │   ├── ClaudeReadSearchOperation.tsx       [A]
│   │   │   ├── ClaudeWebOperation.tsx              [A]
│   │   │   ├── ClaudeCollaborationOperation.tsx    [A]
│   │   │   ├── ClaudeWorkflowMcpOperation.tsx      [A]
│   │   │   └── ClaudeStructuredOperation.tsx       [A]
│   │   └── rows/{dispatch.tsx,ClaudeRows.tsx}      [M/D?]
│   ├── codex/renderer/
│   │   ├── shapes.ts                               [A]
│   │   ├── shapes.test.ts                          [A]
│   │   ├── operations/                             [A]
│   │   │   ├── renderCodexOperation.tsx            [A]
│   │   │   ├── renderCodexOperation.test.tsx       [A]
│   │   │   ├── CodexCodeEditOperation.tsx          [A]
│   │   │   ├── CodexCommandOperation.tsx           [A]
│   │   │   ├── CodexReadSearchOperation.tsx        [A]
│   │   │   ├── CodexWebOperation.tsx               [A]
│   │   │   ├── CodexCollaborationOperation.tsx     [A]
│   │   │   ├── CodexWorkflowMcpOperation.tsx       [A]
│   │   │   └── CodexStructuredOperation.tsx        [A]
│   │   └── rows/{dispatch.tsx,CodexRows.tsx}       [M/D?]
│   ├── opencode/renderer/
│   │   ├── shapes.ts                               [A]
│   │   ├── shapes.test.ts                          [A]
│   │   ├── operations/                             [A when evidenced]
│   │   │   ├── renderOpencodeOperation.tsx         [A]
│   │   │   └── OpencodeStructuredOperation.tsx     [A]
│   │   └── rows/dispatch.tsx                       [M/D?]
│   └── shared/renderer/
│       ├── conditions/                             [=]
│       ├── protocols/                              [A]
│       │   ├── code-edit/
│       │   │   ├── model.ts                        [A]
│       │   │   ├── CodeEditView.tsx                [A]
│       │   │   └── CodeEditView.test.tsx           [A]
│       │   ├── command/
│       │   │   ├── model.ts                        [A]
│       │   │   ├── CommandView.tsx                 [A]
│       │   │   ├── CommandView.test.tsx            [A]
│       │   │   └── formatters/                     [A, evidence-backed]
│       │   │       ├── types.ts                    [A]
│       │   │       ├── git/                        [A, rich formatter]
│       │   │       │   ├── model.ts                [A]
│       │   │       │   ├── detect.ts               [M/A]
│       │   │       │   ├── parse.ts                [M/A]
│       │   │       │   ├── GitCommandBody.tsx      [M/A]
│       │   │       │   ├── index.ts                [A]
│       │   │       │   └── git.test.tsx            [A]
│       │   │       ├── tests/index.ts              [A]
│       │   │       ├── diagnostics/index.ts        [A]
│       │   │       └── json/index.ts               [A]
│       │   ├── compaction/                         [A]
│       │   │   ├── model.ts                        [A]
│       │   │   ├── CompactionView.tsx              [A]
│       │   │   └── CompactionView.test.tsx         [A]
│       │   ├── read-search/                        [A when proven shared]
│       │   ├── web/                                [A when proven shared]
│       │   ├── collaboration/                      [A when proven shared]
│       │   └── structured-tool/
│       │       ├── model.ts                        [A]
│       │       ├── StructuredToolView.tsx          [A]
│       │       └── StructuredToolView.test.tsx     [A]
│       └── rows/{DiffSlab,JsonToolRow,JsonResultSlab}.tsx [M/D?]
│
├── main/
│   ├── ipc/devDebug.ts                             [M]
│   └── recording/
│       ├── SessionRecorder.ts                      [M]
│       ├── SessionRecorderManager.ts               [M]
│       └── SessionRecorderManager.test.ts          [M]
│
└── preload/api/
    ├── devDebug.ts                                 [M]
    ├── types.ts                                    [M]
    └── index.ts                                    [M if wiring changes]

scripts/
├── audit-rendering-shapes.mjs                      [A]
├── audit-rendering-shapes.test.mjs                 [A]
├── extract-rendering-shape.mjs                     [A]
├── extract-rendering-shape.test.mjs                [A]
├── extract-rendering-fixtures.mjs                  [M]
└── audit-rendering-fixture.mjs                     [M]

testing/fixtures/
├── rendering-bundles/                              [=] seed evidence
├── rendering-recordings/                           [=] replay evidence
└── rendering-shapes/                               [A]
    ├── README.md                                   [A]
    ├── claude/<shape-id>/
    │   ├── manifest.json                           [F]
    │   ├── final.json                              [F]
    │   ├── prefix-*.json                           [F]
    │   └── expected.json                           [F]
    ├── codex/<shape-id>/                           [F, same contract]
    └── opencode/<shape-id>/                        [F, same contract]
```

### Existing-file modification ledger

This table explains why each existing file changes. If an implementation PR
cannot point to one of these reasons, that file is probably outside the current
slice and should not be touched.

| Existing file                                              | Intended modification                                                                                                 | First phase |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------- |
| `src/renderer/src/rendering/model/unknowns.ts`             | Replace content-hash identity with structural fingerprint identity while retaining bounded sample/count diagnostics.  | 1           |
| `src/renderer/src/rendering/model/types.ts`                | Carry only the evidence and receipt references required by invariant/replay tooling.                                  | 1–2         |
| `src/renderer/src/rendering/replay/invariants.ts`          | Assert catalog coverage and explicit outcomes in addition to ownership invariants.                                    | 2–5         |
| `src/renderer/src/rendering/replay/recordedSession.ts`     | Reproduce provider paint decisions across bootstrap and restart.                                                      | 2–5         |
| `src/renderer/src/rendering/shadow/shadowDiff.ts`          | Compare legacy/new claimed, generic, absorbed, and visible-fallback outcomes during cutover.                          | 5           |
| `src/renderer/src/features/feed/model/renderModel.ts`      | Preserve stable operation identity and receipt metadata without redoing ownership.                                    | 5           |
| `src/renderer/src/features/feed/ui/Feed.tsx`               | Install the capture context and pass stable session/provider/workspace metadata to the operation boundary.            | 2, 5        |
| `src/renderer/src/features/feed/ui/rows/EntryRow.tsx`      | Give provider capabilities first refusal for catalogued operations, then retain the legacy fallback during migration. | 5           |
| `src/renderer/src/features/feed/ui/rows/ToolUseRow.tsx`    | Remain the visible legacy/generic tool-use route until each claimed shape family is cut over.                         | 5–9         |
| `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx` | Remain the visible legacy/generic result route until paired outcomes have migrated.                                   | 5–9         |
| `src/providers/registry.renderer.capabilities.ts`          | Add the narrow optional `renderOperation` contract and register provider-owned implementations.                       | 5           |
| `src/providers/claude/renderer/rows/*`                     | Delegate migrated Claude families to canonical Claude operation modules while retaining unmigrated shapes.            | 5–9         |
| `src/providers/codex/renderer/rows/*`                      | Delegate migrated Codex families to canonical Codex operation modules while retaining unmigrated shapes.              | 5–9         |
| `src/providers/opencode/renderer/rows/*`                   | Delegate only evidence-backed OpenCode families; preserve generic behavior otherwise.                                 | 5–9         |
| `src/providers/shared/renderer/rows/*`                     | Port bounded primitives into proven protocols, then remove duplicate rows only after every caller migrates.           | 5–9         |
| `src/renderer/src/features/debug/devModules/registry.ts`   | Register Rendering Shapes through the existing debug-module convention.                                               | 3           |
| `src/main/recording/SessionRecorder.ts`                    | Persist metadata-only `__render_shape` records through the current capped writer.                                     | 2           |
| `src/main/recording/SessionRecorderManager.ts`             | Route coalesced renderer sighting batches to the correct active recorder and report drops.                            | 2           |
| `src/main/recording/SessionRecorderManager.test.ts`        | Prove cap, missing-recorder, flush, and failure-isolation behavior.                                                   | 2           |
| `src/main/ipc/devDebug.ts`                                 | Add dev-gated batch append/report endpoints instead of a general production telemetry channel.                        | 2–3         |
| `src/preload/api/devDebug.ts`                              | Expose the safe rendering-shape capture/report calls.                                                                 | 2–3         |
| `src/preload/api/types.ts`                                 | Type the metadata-only API crossing context isolation.                                                                | 2–3         |
| `src/preload/api/index.ts`                                 | Export the API only if the existing spread does not already cover the added methods.                                  | 2–3         |
| `scripts/extract-rendering-fixtures.mjs`                   | Keep for its existing replay-fixture role; rendering-shape drafts preserve exact developer events.                    | 3           |
| `scripts/audit-rendering-fixture.mjs`                      | Validate the existing fixture corpus independently of local rendering-shape drafts.                                   | 3–4         |

Adjacent test files are modified with their production file whenever existing
coverage already has the right home. New tests are added only when no current
test expresses the responsibility; the tree above names those additions.

### New-file responsibility ledger

| New path                                                          | Sole responsibility                                                                                           | First phase |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------- |
| `src/shared/types/renderShapes.ts`                                | Serializable metadata contracts shared across renderer, preload, and main; never provider payload values.     | 1           |
| `src/renderer/src/rendering/evidence/*`                           | Pure structural identity, typed catalog definition, and coverage audit logic.                                 | 1           |
| `src/renderer/src/features/feed/evidence/*`                       | Runtime observation, coalescing, and paint-outcome receipts.                                                  | 2           |
| `src/renderer/src/features/debug/devModules/RenderingShapes/*`    | Developer-only Unknown Shape Inbox and disk-backed report derivation.                                         | 3           |
| `scripts/audit-rendering-shapes.mjs`                              | Report known, unknown, misrouted, generic, specialized, and missing-prefix coverage.                          | 3           |
| `scripts/extract-rendering-shape.mts`                             | Convert one reviewed recording sighting into a complete local fixture draft.                                 | 3           |
| `testing/fixtures/rendering-shapes/**`                            | Checked-in provider shape memory: final, meaningful prefixes, manifest, and expected decision.                | 3–4         |
| `src/providers/{provider}/renderer/shapes.ts`                     | Provider-local source of truth for observed raw shapes and declared outcomes.                                 | 4           |
| `src/renderer/src/features/feed/ui/ProviderOperationBoundary.tsx` | Select the provider capability, require an explicit decision, emit a receipt, and own the visible fallback.   | 5           |
| `src/renderer/src/features/feed/ui/rows/UnknownOperationRow.tsx`  | High-quality bounded rendering for unclaimed structures; unknown never means invisible.                       | 5           |
| `src/providers/{provider}/renderer/operations/*`                  | Provider-private raw recognition/mapping and provider-specific composition.                                   | 5–9         |
| `src/providers/shared/renderer/protocols/*`                       | Narrow provider-neutral visual models and views introduced only after independent mappings prove equivalence. | 5–9         |

### Deletion and rename policy

There are no planned broad renames. `presentation/` is not introduced, and
`projection/` remains deferred unless the code-edit vertical slice proves a
pure provider-neutral assembly responsibility that has no current home.

The only deletion candidates are superseded provider/shared row branches and
duplicate primitives. A candidate becomes an actual deletion only when:

1. every shape it previously painted has a typed provider catalog entry;
2. final and meaningful prefix fixtures replay through the replacement;
3. shadow comparison records no missing visible content or owner;
4. restart/replay produces the same terminal visual model;
5. repository search finds no remaining consumer; and
6. the deleting PR names the catalog query and fixtures that prove safety.

Until those gates pass, old and new routes coexist behind explicit provider
claims. No file is moved or renamed merely to make the target tree look clean
in advance.

## Incremental delivery plan

All ten phases land on PR #555. The phase boundaries remain independently
reviewable, fixture-gated gates that keep the app usable, but they are not
merge boundaries: the rewrite PR merges only after Phase 10 and the final
whole-branch review.

### Phase 0 — this plan-only draft PR

Deliverables:

- the full shape-discovery and rendering product contract;
- no-churn directory decision;
- provider import contract;
- component/formatter rubric;
- conditions and compaction translation;
- PR #524 salvage/rejection map;
- no runtime changes.

Exit gate:

- reviewers can trace an unknown shape from live observation to catalog,
  fixture, provider component, shared protocol, and test;
- every proposed new directory names a responsibility absent from current
  folders rather than merely renaming them.

### Phase 1 — structural fingerprint and typed catalog contract

Files:

- `src/shared/types/renderShapes.ts`;
- `src/renderer/src/rendering/model/shapeFingerprint.ts`;
- `src/renderer/src/rendering/model/unknowns.ts` and tests.

Red-green tasks:

1. Add tests proving same structure/different command or prompt text yields the
   same fingerprint.
2. Add tests proving render-relevant discriminator changes yield different
   fingerprints.
3. Add dynamic/sensitive-key, cycle, depth, array, large-object, and
   unserializable-input tests; retain every literal key in dev sightings while
   keeping catalog identity low-cardinality.
4. Implement canonical typed key paths including value types, not keys alone.
5. Re-key unknown grouping by structural fingerprint while retaining bounded
   payload-hash samples/counts.
6. Add `defineRenderShape` and catalog coverage helpers.
7. Add a boundary test forbidding specific-provider imports from shared/feed
   interpretation modules.

No IPC, UI, provider dispatch, or visual behavior changes in this phase.

Exit gate:

- fingerprint output is deterministic in renderer/unit environments;
- existing unknown diagnostics remain bounded and reference-stable;
- no scalar content value enters the structural fingerprint; literal key paths
  remain available in developer evidence;
- all current rendering tests/corpora remain unchanged.

### Phase 2 — shape observer and recording sidecar

Files:

- `features/feed/evidence/*`;
- dev-gated preload/main batch IPC;
- narrow additions to `SessionRecorder`/manager;
- observer tests and recording writer tests.

Red-green tasks:

1. Test that the observer is inert when capture is disabled.
2. Test one unknown live prefix, repeated thousands of times, produces one
   bounded fingerprint record plus counts rather than thousands of IPC sends.
3. Test outcome changes and lifecycle milestones produce explicit records.
4. Test queue caps, coalescing, final flush, renderer unmount, app shutdown,
   missing recorder, and serialization failure.
5. Test sightings retain bounded complete structural key paths while scalar
   prompt/command/result values remain outside shape identity.
6. Append `__render_shape` lines through the existing recording lifecycle.
7. Include dropped/capped sighting counts in recorder metadata/debug output.

Exit gate:

- a capture of normal agent use creates recording-linked shape sightings;
- no per-token IPC flood is possible by construction;
- turning capture on does not alter the render tree or ownership output;
- diagnostic failure cannot throw into the provider/feed path.

### Phase 3 — Unknown Shape Inbox and audit/extraction tools

Files:

- Dev Debug inbox module;
- `scripts/audit-rendering-shapes.mjs`;
- `scripts/extract-rendering-shape.mjs`;
- extraction core tests;
- `testing/fixtures/rendering-shapes/README.md` when the first fixture lands.

Red-green tasks:

1. Build a pure report derivation over sidecars and provider catalogs.
2. Group by structural fingerprint and show known/misrouted/unknown status.
3. Link each item to source recording cursor/note and provenance.
4. Extract final and meaningful prefix windows from the existing recording.
5. Preserve exact admitted events in the local draft; do not erase evidence
   before the unknown shape has been understood and deliberately curated.
6. Add commands for opening/exporting the inbox and attaching evidence notes.
7. Keep classification as reviewed source changes; no runtime source mutation.

Exit gate:

- a developer can use the app, see a new unknown in the inbox, run one command,
  and obtain a complete local fixture draft without manually grepping JSONL;
- the inbox survives restart because it is derived from disk-backed recordings;
- known shapes and intentional generic/absorbed cases do not remain falsely
  unknown.

### Phase 4 — seed the inventory before rewriting cards

Inputs:

- 48 checked-in rendering bundles;
- existing recording fixtures;
- local Claude/Codex/OpenCode recordings referenced by PR #524 research;
- provider source references under `vendor/` only as corroboration.

Tasks:

1. Run the audit over every available fixture.
2. Create human-readable provider-prefixed ids for every distinct
   renderer-facing shape.
3. Record multiple fingerprints under one shape id when versions differ but
   semantics do not.
4. Split entries only when the visual interpretation/lifecycle truly differs.
5. Attach model/provider-version provenance when verified; use unknown rather
   than inference when absent.
6. Mark current outcomes: specialized, generic, absorbed, condition-surface,
   planned, or unsupported.
7. Add catalog-to-fixture and provider-import-boundary CI checks.
8. Publish the first coverage report in the PR description: total shapes,
   unknown, misrouted, generic, specialized, missing-prefix coverage.

Exit gate:

- the checked-in evidence corpus has zero unclassified fingerprints;
- high-frequency code-edit and command shapes have complete plus meaningful
  prefix fixtures;
- no new product renderer has been invented from an unobserved tool list.

### Phase 5 — provider operation boundary and code-edit vertical slice

This is the architecture proof and the first user-visible rendering PR.

Files land only for this slice:

- narrow `renderOperation` provider capability;
- `ProviderOperationBoundary` and outcome receipts;
- Claude code-edit adapter/component;
- Codex code-edit/unified-exec adapter/component;
- shared `protocols/code-edit` model/view;
- shape fixtures and DOM/performance tests;
- selected PR #524 diff/streaming primitives ported with their tests.

Red-green tasks:

1. Make Claude Edit/MultiEdit/Write fixtures fail against the new contract.
2. Make Codex classic patch, unified-exec prefix, standalone patch completion,
   success, and failure fixtures fail.
3. Independently implement provider recognizers/parsers.
4. Map each provider to `CodeEditRenderModel`; prove shared view contains no
   provider imports or branches.
5. Render path, counts, hunks, status, and errors line by line.
6. Assert the same outer DOM node/key across meaningful prefixes and
   live-to-committed handoff.
7. Emit shape/render receipts and verify inbox items close.
8. Shadow compare each migrated shape against legacy output.
9. Cut over only the catalogued edit shapes; keep all other routes unchanged.
10. Delete an old edit route only when the provider catalog proves no shape
    still claims it.

Exit gate:

- modern Codex edit shows an edit as soon as the patch intent/path is proven,
  never wrapper JavaScript;
- Claude and Codex share only the visual protocol/view, not parsing or dispatch;
- huge/streaming diffs stay bounded and responsive;
- success and failure never disappear;
- ownership corpus output is unchanged.

At this gate, decide whether any provider-neutral `projection/` responsibility
actually remains. Default remains no.

### Phase 6 — command grammar and trusted formatters

Files:

- independent Claude/Codex/OpenCode command adapters/components;
- shared command visual protocol/view if all mappings fit honestly;
- formatter directory populated one proven grammar at a time;
- selected PR #524 ANSI/output/streaming primitives ported with caps.

Fixture matrix includes:

- live and committed commands;
- unified-exec, classic exec, local shell, Bash, OpenCode bash;
- multi-command wrappers;
- CRLF output;
- ANSI/control-sequence edge cases and span bombs;
- empty successful output;
- nonzero exit, timeout, cancellation, denial;
- background session, stdin, wait, and uncorrelated interaction;
- large output head/tail/paging;
- git/test/diagnostic/JSON formatter success and decline cases.

Exit gate:

- command UI is distinctive and useful without losing raw evidence;
- formatters cannot claim malformed/ambiguous output;
- no provider parses another provider's command wrapper;
- no per-delta whole-output work or unbounded DOM path remains.

### Phase 7 — reads/search/web and collaboration

Migrate in separate family PRs, each inventory-first:

- reads, path listing, text search, tool/transcript discovery;
- web search/fetch/open/find and citations;
- spawn/message/wait/list/read/interrupt/close orchestration;
- task notifications/final reports and child drill-in.

Each PR adds provider adapters, shared protocols only when proven, shape
fixtures, accessibility/DOM tests, and receipts. Completed low-signal grouping
must name every absorbed owner and retain failures/active work individually.

Completion boundary (2026-07-17):

- Claude Read, ToolSearch, WebFetch, WebSearch, and Agent now converge from
  complete semantic input onto their committed provider adapters/components;
- Codex search/open/find and the two observed native spawn input generations
  have provider-owned rows, while acknowledgements remain separately visible
  unless a result contract proves safe absorption;
- Agent Code's eight source-controlled orchestration operations have one shared
  owned-protocol view behind exact provider name adapters. Claude requires the
  `mcp__agent_code__` namespace; Codex admits only the historical direct bare
  names observed in its rollout corpus;
- current Codex MCP-inside-unified-exec calls remain command operations because
  executable source is not a trustworthy orchestration join key. Their nested
  CallToolResult/JSON evidence is still unwrapped and pretty-formatted;
- arbitrary MCP and native collaboration operations without stable paired
  schemas intentionally use the bounded structured fallback. This is a Phase 7
  disposition, not an implied promise to custom-render every enabled server;
- no Glob/Grep/LS catalog evidence exists, native wait/list/message generations
  conflict or lack paired results, and semantic/committed Codex web ids do not
  share a proven absorption key. The catalog/TODO comments preserve each gap
  for a future evidence-backed graduation;
- Codex `wait` is classified as unified-command continuation rather than agent
  collaboration, LSP remains Phase 8, and the remaining local unknown-shape
  sightings are compaction/system-summary records owned by Phase 10.

Exit gate: the frozen corpus has no unknown structural shape, specialized paths
have semantic/committed DOM tests, and every unsupported observed Phase 7 shape
has an explicit generic or later-grammar disposition instead of a guessed row.

### Phase 8 — tasks/questions/workflows/MCP and rich media

Migrate:

- todo/task/plan/schedule/skill/workflow;
- questions with authoritative condition-gated interaction;
- generic MCP typed content;
- images/image generation;
- notebook/LSP/workspace/config/system records.

Workflow UI and large MCP output must reuse the already-landed IPC/rendering
backpressure protections. No family earns an exception to bounded, lazy output.

Completion boundary (2026-07-17):

- captured Claude TaskCreate/TaskUpdate, Skill, and ScheduleWakeup plus Codex
  update_plan have provider-owned lifecycle/checklist rows; uncaptured Claude TodoWrite,
  plan-mode, and task query/output/stop generations do not inherit speculative
  legacy semantics;
- AskUserQuestion uses the durable provider row for history and the live Claude
  condition as the only interaction authority. Every provider condition kind
  now has an explicit destination (`condition-outlet`, `feed-inline`,
  `composer`, or `attention-only`) instead of shared inference;
- Agent Code AI Workspace and Workflow tools sit above open-world MCP through
  exact provider adapters and source-controlled schemas. Workflow has no frozen
  invocation/result fixture yet, so thick TODOs prohibit richer phase/coverage
  interpretation until a real paired capture lands;
- arbitrary MCP results recognize typed text, image, audio, embedded-resource,
  and resource-link blocks; serialized SDK envelopes and direct provider arrays
  share the same bounded view, while exact transport bytes stay lazy;
- JSON/JSONL/path-line/timestamped/provenance command output has one conservative
  structured fallback after command/read/search/diff specializations decline;
- image blocks and Codex image generation use media-safe, lazy previews and
  preserve rejected active formats as visible diagnostics;
- NotebookEdit, LSP, Monitor, TaskGet, TaskOutput, TaskStop, EnterWorktree, and
  one-off third-party MCP calls are explicitly generic because the available
  evidence is invocation-only. Each catalog entry names the missing paired
  success/failure/replay fixture required for graduation;
- hook attachments, PR links, queue operations, and turn-duration records are
  explicitly classified as non-conversational system metadata. The ownership
  ledger keeps them out of chat (queue reconstruction remains the queue owner),
  while the muted bounded system fallback remains total if another transcript
  surface admits them. Durable compact entries remain the Phase 10 exception.

Exit gate met at the evidence boundary: every captured Phase 8 structure is
specialized or deliberately generic, all large/raw disclosures are bounded and
lazy, and no component was invented from the provider tool list alone.

### Phase 9 — long-tail coverage and proven deletion

Tasks:

- run capture soaks across all supported providers/models;
- classify every new fingerprint;
- keep the generic fallback total;
- remove duplicate decoders only after provider adapters are canonical;
- remove legacy row branches only when catalog coverage proves no remaining
  shape uses them;
- update evergreen rendering docs from the as-built system;
- close/supersede PR #524 after every valuable primitive/fixture has a recorded
  port-or-reject decision.
- keep the central Git and compact-entry exceptions intact until Phase 10 has
  paired evidence, replacement fixtures, and shadow/replay proof; Phase 9 must
  not delete them early.

Exit gate:

- the checked-in corpus has no unknown or misrouted shape;
- the development inbox remains capable of catching future upstream drift;
- there is one provider-owned path per catalogued shape and no split legacy/new
  renderer for the same shape;
- every deletion is backed by a catalog query and replay result.

### Phase 10 — final Git and compaction ownership convergence

This final phase closes two architectural exceptions discovered while Phases
1–6 were running. It does not invent new semantics: it migrates the already
proven Git and compaction experiences into the provider-owned, directory-based
renderer after the operation boundary can carry the evidence they need.

Git tasks:

- land the actual paired `renderOperation(ProviderOperationInput)` capability
  promised by Phases 5–6, so one provider renderer receives correlated tool-use
  and result evidence rather than reconstructing a pair inside `Block.tsx`;
- move feed Git intent detection, parsing, and the six specialized
  status/diff/add/commit/log/push bodies from `features/git/ui/GitRows.tsx` into
  `providers/shared/renderer/protocols/command/formatters/git/`;
- require provider command adapters to normalize the pair before that formatter
  runs; preserve conservative decline, bounded raw output, and an explicit
  absorption receipt naming the owning command row;
- keep the persistent Git bar in `features/git/` as a separate workspace product
  surface; do not force its IPC/store lifecycle into the feed protocol;
- remove or generalize the Git-only `customRendering` gate after auditing whether
  it has any remaining product meaning outside this legacy interception path.

Compaction tasks:

- move durable compact boundary/summary selection out of the central `EntryRow`
  exception into `providers/<provider>/renderer/components/compaction/`, using
  provider adapters plus
  `providers/shared/renderer/protocols/compaction/{model,CompactionView}` only
  when the providers map honestly to the same visual model;
- colocate each provider's transient condition view/adapter under
  `providers/<provider>/renderer/conditions/compaction/`, while retaining the
  hard semantic boundary: the condition owns live state and the feed component
  owns durable replayable transcript evidence;
- inventory Claude proxy/semantic synthesis signals and committed compact
  entries, Codex semantic `compaction` and durable `compacted` evidence, and any
  OpenCode evidence actually captured; prefer structured signals for live state
  and use screen detection only as a versioned compatibility fallback;
- define provider-owned source precedence, provenance, and deduplication so
  structured and screen detection cannot create duplicate or regressing live
  conditions;
- add fixtures for structured-only with screen detection disabled, screen-only
  fallback, both sources, disagreement, error/done, and restart/replay; add an
  explicit Codex regression proving semantic compaction cannot fall through to
  an empty generic marker.

Exit gate:

- no shared feed dispatcher recognizes Git command intent or durable compact
  entry kinds;
- named provider receipts own every migrated Git/compaction outcome, including
  absorbed results;
- structured-capable fixtures work with screen detection disabled, fallback-only
  fixtures still work, and both sources produce one monotonic live lifecycle;
- durable compaction survives restart/replay independently of transient condition
  state;
- every removed central/legacy route has catalog, fixture, shadow comparison, and
  replay proof;
- the inbox/corpus reports no unknown, misrouted, unsupported, or unknown-outcome
  residue for the migrated Git and compaction shapes.

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
6. **Can every provider/version expose live compaction without screen parsing?**
   Decide from captured structured events. Where the answer is no, retain screen
   detection as an explicit versioned fallback with source provenance and
   deduplication, rather than making the screen channel the primary contract.

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
  durable semantics; structured semantic/proxy evidence leads live compaction
  where available, screen detection is only a proven compatibility fallback,
  and durable entries render from provider-owned compaction directories;
- feed Git UI consumes paired provider-normalized command evidence through a
  rich formatter directory, while the persistent workspace Git bar remains a
  separate product surface;
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
