# Evidence-First, Provider-Owned Feed Rendering — Lean Plan

**Status:** Phases 1–7 implemented on PR #555 and under whole-branch hardening; Phases 8–10 remain. Do not merge until all ten phases pass.

**Date:** 2026-07-16

**Branch:** `feat/render-shapes-phase1-fingerprint-catalog`

**Baseline:** `origin/main` at `8f357260`

**Salvage source:** [PR #524](https://github.com/Juliusolsson05/agent-code/pull/524)
(116 files, +17,122 / −3,981; draft/salvage only — not a merge base)

## What this document is

This is the lean, decision-dense companion to
`2026-07-16-evidence-first-provider-owned-feed-rendering.md`. The long plan
carries the exhaustive interface listings, the full per-family visual contract,
the complete before/after repository tree, and the new / modified-file ledger.
**This document is the one an implementer reads first.** It states every
load-bearing product, architecture, migration, privacy, performance, conditions,
testing, and PR #524 decision in the fewest words that still commit us. When the
two disagree, the long plan wins on detail; this plan wins on intent.

## The goal, in the user's words

The ownership/order pipeline already works. This project is _not_ about
ownership. It is about **"actually rendering a UI that users want to see, line
by line code edits and all that."** The current renderer file structure is
_"a hard mess, extremely hard to represent and maintain,"_ and the current
rewrite attempt (PR #524) _"has to be completely redone."_

Two deliverables, strictly in this order:

1. **First, a development system that captures every DISTINCTIVE / unknown
   provider shape while we use the app**, then lets us classify it into a
   fixture + typed catalog entry. The motivation is blunt and non-negotiable:
   _"the issue when working with agentic development is that we quickly forget
   all the different results we have."_ The capture harness is the cure for
   that forgetting. We had something similar when we first built the renderer;
   this rebuilds it deliberately.
2. **Only then, an exceptional modular renderer built against that evidence** —
   not against a guessed universal taxonomy.

The product bar is equally blunt: **Agent Code wants to be known for having
amazing rendering.** A command should look like a command; an edit should make
the changed lines obvious line by line; a command family may earn a distinctive
color, icon, or summary so it reads at a glance; an unfamiliar operation stays
legible instead of vanishing. That quality requires specialization — but **not**
one React component per raw wire shape, one component per possible shell command,
or a framework that predicts every future provider.

## The product contract, stated bluntly

The first thing we ship is **not another batch of cards.** It is the system that
stops us forgetting what providers emit. While we use Agent Code in development,
the app observes every distinctive renderer-facing structure at the exact point
the painter is about to interpret it. A catalogued fingerprint records another
sighting (provider, version, model, plane, lifecycle); an uncatalogued one lands
in a bounded local **Unknown Shape Inbox** immediately, linked back to the
session recording so it can become a complete local fixture draft without a future agent
re-deriving the payload from prose.

The system must keep **four separate facts distinct**, because collapsing them
is exactly how the current renderer accumulated duplicate decoders:

1. **Raw shape** — which provider/version/model wire structure was observed,
   including meaningful streaming prefixes.
2. **Provider interpretation** — how _that provider_ maps the raw structure to
   a visual meaning (command, edit, read, search, condition).
3. **Visual protocol** — the narrow provider-neutral model a genuinely shared
   view accepts, e.g. `CodeEditRenderModel`.
4. **React composition** — the component, optional formatter, primitives, and
   fallback that paint the meaning.

Two component rules follow directly from the user, and they are the spine of
this plan:

> **Every distinctive raw shape gets a catalog entry and a fixture. Every
> meaningful visual grammar gets a component. Those are not the same
> cardinality.**

We capture and identify _all_ shapes in types/fixtures so we stop forgetting
them — _"but of course a bash command will be a component, because we are not
going to write a component for millions of bash commands."_ `Bash` / command
execution is a **component family.** `git status`, `npm test`, and every other
command are instances of one grammar, not new components. Proven command
grammars add conservative formatters (color, icon, summary, links) _inside_ the
command component while the bounded raw output stays available.

> **Claude and Codex do not share a raw interpretation layer.**

In the user's exact words: _"do not try to share rendering layer between Claude
and Codex, that has fucked shit up for us."_ The fix he specified is a shared
directory of **protocols** — _"code writing protocols and edit protocols"_ —
where each provider _"just transforms its data model to map the shared
component."_ Claude's edit component maps Claude shapes into a shared code-edit
protocol; Codex's independently maps Codex shapes into the same protocol; the
shared view receives only the protocol. A future provider reuses it by writing
its own adapter, or declines it if its semantics don't fit. This is the level
that _"clears up the owner relationships and makes it foolproof for more
providers"_ — and the only level. Raw parsing is never shared.

## Non-negotiable invariants

1. **Order of operations:** capture/inspect → collect unknown shapes live while
   using the app → classify into fixtures + typed catalog → _then_ write
   rendering components. Components come after the evidence corpus exists.
2. **Two cardinalities:** catalog every distinctive raw shape; build a component
   only for a meaningful visual grammar.
3. **Provider raw-interpretation isolation is total:** `claude/**` never imports
   Codex/OpenCode renderer code, and vice versa; shared code never imports a
   specific provider or names a provider wire type; a shared-protocol view never
   branches on `provider`.
4. **Shared happens only after interpretation,** at the narrow protocol level,
   and only once two real providers prove the same semantic model.
5. **Ownership/order is frozen.** `FeedRenderItem[]` stays the clean boundary.
   The painter derives visual info; it never decides visibility. Any absorption
   of an independently owned item is an explicit receipt proven against the
   ownership corpus.
6. **No silent `return null`.** Every item is rendered, generic-rendered,
   absorbed with a named owner + reason, or routed to a named condition/composer
   surface. Unknown is a visible bounded state, not a disappearance.
7. **Conditions stay a parallel semantic system** with their own provider-owned
   detection, policy, and outlet routing. They are never routed through ordinary
   tool cards.
8. **Truncate-by-default is a hard product rule:** a tool call shows _"one line
   with click to expand to see the full tool call,"_ not the full payload dumped
   into activity UI.
9. **Runtime capture is metadata-only, bounded, dev-gated,** and can never throw
   into the provider/feed path or flood IPC.

## Explicit non-goals

- No `presentation/` folder. It is a new naming convention that _"changes
  something we have today"_ for no earned reason; PR #524's `presentation/`
  layer duplicated `ui/resolve/` and let one Codex wrapper get decoded twice.
- No broad renames of `ui/`, `model/`, `ledger/`, `rendering/`. Cosmetic
  alignment is not part of this project. _"We should not be renaming stuff file
  structure wise if it serves no purpose."_
- No universal/global classifier; no cross-provider parsing; no shared component
  that reads provider wire data.
- No base-card React inheritance tree. (The user floated a _"base definition
  that they all inherit"_; we honor its intent through a shared **contract** +
  composed **primitives**, not class inheritance — see below.)
- No component per tool name, command string, or structural fingerprint.
- No generated type union when `keyof typeof catalog` suffices.
- No second recorder/replay/fixture framework; extend the existing one (~85%
  already exists). Rendering-evidence drafts deliberately preserve the complete
  admitted developer recording rather than passing through replay redaction.
- No empty scaffolding: a directory is created only when its first real
  responsibility lands.
- PR #524 is not a base branch and must not be rebased wholesale onto `main`.

## The end-to-end evidence loop

This is the feature at the center of the plan — an explicit loop, not a bag of
diagnostics a developer must remember how to combine.

**1. Capture.** Dev Debug palette adds `Start/Stop Rendering Evidence Capture`,
`Open Unknown Shape Inbox`, `Attach Rendering Evidence Note`, and
`Export Unknown Shape Report`. Capture reuses the existing `SessionRecorder`
(nine channels, caps, retention, exact local payloads) and additionally arms a
renderer-side **shape observer** for that session. The observer is off in normal
production; an env flag can arm an unattended soak. No hidden always-on
telemetry, no external upload.

**2. Observe.** At the point the painter is about to ask a provider to interpret
a value, the observer records one metadata-only `RenderShapeSighting` per
distinct structure across four planes — committed tool use/result, live semantic
blocks + meaningful prefixes, provider-normalized transcript/system entries, and
live condition records. The sighting carries provider/version/model, plane,
lifecycle, event type, structural fingerprint, literal bounded shape paths +
discriminators, a separate content-sensitive `payloadHash` (never the shape
id), a recording cursor, and the paint outcome. The sidecar stays structural so
it does not duplicate bulky scalar payloads; the linked developer recording is
the lossless source and retains prompts, commands, paths, arguments, output,
and condition content. (Full `RenderShapeSighting` / `RenderOutcome` types:
long plan §Step 2.)

**3. Structural fingerprint.** One pure helper near the existing unknown-shape
code derives a content-independent identity from provider + plane +
event/tool discriminator + normalized key/type identity paths + a small
allowlist of low-cardinality structural values (`type`, `kind`, `subtype`, tool
name). Sightings retain the complete bounded literal key tree even where
identity normalizes dynamic/auth-shaped maps to prevent catalog explosion. Same
structure / different content → same fingerprint (so `Bash ls`
and `Bash git status` are one shape). Render-relevant discriminator change →
different fingerprint. The payload hash stays a separate dedup/sample identity
and must never become the catalog key.

**4. Deduplicate before IPC.** The observer keeps a bounded per-session map keyed
on `provider + plane + lifecycle + eventType + fingerprint + outcome-kind`.
Repeated deltas increment local counters; only a new fingerprint, an outcome
transition, a lifecycle milestone, or the final flush enters a coalesced,
hard-capped outbound queue. This is load-bearing: the renderer-freeze incident
proved a diagnostic can become the performance bug. A thousand partial-JSON
deltas produce a handful of milestone sightings, never a thousand messages.

**5. Compare + inbox.** The observer loads a compiled read-only fingerprint index
from the provider catalogs and classifies each sighting: known-and-claimed,
known-but-misrouted, known-but-unsupported-in-this-lifecycle, unknown structure,
or unknown outcome. The last four enter the **Unknown Shape Inbox** — a local,
bounded, restart-surviving Dev Debug module (derived from recordings + catalogs,
not a second database). It groups by fingerprint (not payload hash) and shows
provider/version/model, fingerprint + discriminator, plane/lifecycle,
first/last/count, current outcome, the complete bounded literal key tree,
links to the source recording cursor/note, and whether a complete local fixture can be
extracted.

**6. Classify.** Classification is a reviewed code change, never a runtime button
that edits source. The developer picks exactly one `RenderShapeDisposition`:
`specialized`, `generic`, `absorbed` (must name the owning render id + a fixture
proving the useful result stays visible — hiding is the most dangerous operation
in the renderer), `condition-surface`, `planned`, or `unsupported` (still paints
a visible fallback). Full type: long plan §Step 6.

**7. Extract a complete local fixture draft.** `scripts/extract-rendering-shape.mts` follows the
recording cursor and emits the smallest useful package (final renderer-facing
input, prefix milestones, paired result/condition state, provenance, expected
ownership key + render-id inputs, outcome receipt, exact bounded raw context,
human description) into `testing/fixtures/rendering-shapes/<provider>/<shape-id>/`
(`manifest`/`final`/`prefixes`/`expected`). The extractor does not redact: it is
a local developer tool and erasing content can erase the evidence that explains
an unknown renderer shape. The draft still requires deliberate human curation
before it becomes a checked-in fixture. This directory is justified by
_behavior_, not aesthetics: recording
fixtures replay multi-event ownership over time; shape fixtures pin one provider
parser + component grammar. Neither replaces the other.

**8. Bind to a typed provider shape.** Each catalogued shape uses one common
declaration (`RenderShapeDefinition` / `defineRenderShape`) carrying id
(`${provider}.${string}`), fingerprints, event types, planes, lifecycles,
observed versions/models, fixture refs, disposition, and a `why`. This is the
useful version of the user's _"base definition they all inherit"_: shared
compile-time metadata + coverage obligations, **no** `match()`/`render()`, no
React inheritance, no shared parser. Missing fixtures, provider-prefix mistakes,
and invalid dispositions become compile/test failures. Claude definitions live
under Claude, Codex under Codex. Start as one `shapes.ts` per provider using
`as const satisfies RenderShapeCatalog` with `keyof typeof` ids; split into
`shapes/` only when real size warrants it.

**9. Implement or reuse the renderer.** A specialized entry points at a stable
`rendererId`; the provider's dispatch claims the shape id and returns a render
decision. Coverage tests check both directions: every specialized catalog shape
is claimed by its provider renderer; every claim names a catalogued shape; every
shared-protocol use comes from a provider-owned adapter; no shared view accepts
provider wire types; generic/absorbed/condition dispositions match actual
outcomes.

**10. Close the inbox for the right reason.** After catalog + fixture + adapter +
component + tests land, replay the source recording. The inbox item closes only
if the same fingerprint now produces the declared outcome at every required
lifecycle milestone. Renaming a fingerprint, deleting a sighting, or hiding an
unknown without a fixture does **not** close it. This loop _is_ the institutional
memory: a future agent adds a provider or tool by following evidence, not by
rebuilding a mental model of the whole renderer.

## Target architecture and dependency rules

Freeze the boundary that already works:

```text
provider channels -> SessionRuntime ingest -> ownership/order ledger
  -> FeedRenderItem[] -> feed painter
```

The feed bridge builds a neutral `ProviderOperationInput` (committed or live)
carrying only what the provider renderer may inspect — it does **not** classify.
The provider capability registry gains **one** narrow optional method, and only
when the first vertical slice needs it:

```ts
renderOperation?: (input: ProviderOperationInput) => ProviderRenderDecision;
```

`ProviderRenderDecision` is `rendered | generic | absorbed | unclaimed` (full
types: long plan §Concrete paint architecture). The shared bridge does exactly
three things: select the provider capability, record the returned decision as
the paint + sighting receipt, and fall back to the bounded generic view for
`generic`/`unclaimed`. It never switches on tool name, reads wrapper JavaScript,
parses provider JSON, or maps provider values into a family.

Each provider owns an explicit dispatch and real components. The provider
component owns: recognition of its tool/event vocabulary; parsing complete and
partial inputs; live-vs-committed evidence precedence; provider lifecycle facts
and labels; mapping to a shared protocol when honest; choosing a provider view
when no protocol fits; and declaring its shape id + renderer id in the receipt.
Claude's component never imports Codex; Codex's never imports Claude; a provider
can change its wrapper format without a shared blast radius.

**Import rules (non-negotiable, enforced by one narrow boundary test with a
clear failure message — not a bespoke framework):**

1. `providers/claude/**` never imports Codex/OpenCode renderer code.
2. `providers/codex/**` never imports Claude/OpenCode renderer code.
3. `providers/opencode/**` never imports Claude/Codex renderer code.
4. `providers/shared/renderer/**` never imports a specific provider.
5. `features/feed/**` selects capabilities through the existing registry but
   never imports a provider decoder/extractor.
6. Shared protocol types never mention provider wire types.
7. A shared-protocol component never branches on `provider`.

PR #524 violates this in at least nine places (shared classifier/projector and
resolvers reaching into provider extractors; `fileEdit.tsx` importing both
Claude and Codex). Those edges are evidence to delete during migration, not a
pattern to keep. Use the existing capability registry; add only the smallest
capability the first slice needs; do not design a wide universal adapter before
two providers prove each method.

**Shared protocols are narrow leaf contracts.** `code-edit/model.ts` carries
files, hunks, line kinds, counts, paths, status, diagnostics, source
availability, and stable ids — no `provider` switch, no raw escape hatch back
into parsing. Mapping is one-way: `toClaudeCodeEditModel`, `toCodexCodeEditModel`
(provider-owned) → `CodeEditView({ model })` (shared, cannot name a provider). If
providers need different chrome, their components wrap the shared view; sharing
line rendering never means sharing the whole operation component.

**The common base is a contract + primitives, not inheritance.** Two altitudes
satisfy the user's clean-base intent: every shape satisfies
`RenderShapeDefinition` (same evidence/fixture/provenance obligations), and
components compose primitives — `OperationFrame`, `StatusLabel`, `PathLabel`,
`BoundedOutput`, `Disclosure`, `DiffHunk`, `AnsiText`. A wait, a streaming patch,
a question picker, and a generated image get _different_ grammars; the contract
makes them accountable, composition makes them consistent, neither flattens them
into one rectangle.

**Stable row identity through streaming and commit.** The row that appears when
an operation begins stays the same row as its input streams, as it runs, when
output arrives, and when committed evidence replaces semantic evidence —
completion is a props update, not a different renderer suddenly winning. The
painter derives `renderId` from provider call/tool id → upstream item id →
committed block id → the existing source-item/block-index fallback. Adapters
prove monotonic interpretation (unknown→specific, partial→complete,
running→terminal; a proven grammar never regresses to generic on a sparse later
event; committed evidence corrects details but never remounts a different
component). Prefix fixtures assert React key + outer DOM-node stability.

## Component granularity and exceptional UX

Decision ladder for every shape: **(1) dedicated component** when the whole
operation has a distinct grammar worth testing across live + committed (code
edit, command, file write, read/search, todo, approval, compact summary) —
dedicated ≠ monolithic; it composes primitives and delegates to formatters.
**(2) formatter inside a family** when the specialness is in output
interpretation, not the shell (git/test/diagnostic/JSON summaries, exit +
duration). Formatters are pure where possible, return `null` when uncertain,
enrich rather than erase bounded raw output, and never become wire parsers —
this is how a command family gets a distinctive color/icon/summary without
minting a component per command, and **color is never the only carrier of
meaning.** **(3) generic structured view** for the long tail with useful
label/params/result but no proven grammar. **(4) visible bounded fallback**
for the unrecognized — a real card with humanized name, one safe headline,
bounded params/result, status/error, and a dev-only fingerprint + inbox link.

A formatter may own a rich, model-only body component when evidence proves a
conclusion line is not enough. The existing multi-card Git feed UI is the
motivating case: it moves under
`protocols/command/formatters/git/`, receives only provider-normalized paired
command evidence, declines conservatively, and leaves bounded raw output
available. That directory is a command-protocol formatter, not a new place to
interpret provider wire shapes.

Every operation presents three levels: **always visible** (verb, subject,
status, most useful result/count); **inline when useful** (diff lines, recent
terminal output, found paths, selected option, active plan step); **expandable**
(complete bounded/paged output, params, source wrapper, debug evidence). Raw
wrapper JavaScript, escaped JSON, XML/tag soup, response-item kind names, and
MCP envelopes are debug source — never the default UI. Interpretation _enriches_
evidence (a test summary sits above the output, it does not replace it). All
large values are bounded before expensive work; closed disclosures unmount heavy
children; streaming paths never run whole-body Markdown/JSON/ANSI/highlight/
Monaco work per token.

Per-family targets (full visual contract: long plan §Exceptional rendering):

- **Code edits / writes:** Claude Edit/MultiEdit/Write/NotebookEdit; Codex
  classic apply-patch, unified-exec patch wrappers, standalone patch-completion;
  OpenCode edit/write/patch once fixtures prove structure. Header:
  Creating/Editing/Moving/Deleting, workspace-relative path ASAP, file count,
  ±totals, status, error summary without expansion. Body: line-by-line red/green
  diff with stable gutter identity as it streams, per-file headers, first/last
  windowing + hidden-line count, safe open/copy. Write is honest: new file =
  additions; overwrite with known before = diff; overwrite without = labeled
  new-content view, never a fabricated diff. Tokens layer independently (plain
  text → cached lexical tokens on sealed lines → optional cheap LSP semantic);
  never remount Monaco per delta.
- **Commands:** Claude Bash/PowerShell; Codex classic + unified exec-command /
  local-shell; OpenCode bash, write-stdin, background continuation, wait/poll.
  Header: Running/Ran/Failed/Timed out/Waiting/Sent input, highlighted command,
  cwd when it differs, provider description, duration, exit/timeout/bg-session.
  Output: live ANSI with control-sequence stripping + span caps, head+tail on
  completion so command and final summary both survive truncation, explicit
  truncation counts, failure visible without expanding, paged/lazy. Correlated
  `write_stdin`/wait fold into the originating command; uncorrelated get compact
  rows; empty poll ticks absorb only with a receipt. Formatters: git accent,
  test totals, linked `path:line:col` diagnostics, bounded JSON, safe links.
  Git may use a rich formatter-owned body for status/diff/add/commit/log/push
  once provider adapters have produced one paired command model. The persistent
  workspace Git bar remains a separate product surface under `features/git/`;
  only feed rendering migrates into the command protocol.
- **Reads / search / discovery:** distinguish read-file/range, list paths, text
  search, tool/resource search, transcript inspect. Header exposes target,
  query/pattern, include filter, offset/range, count; results use safe file links,
  match highlighting, bounded expansion. Completed low-signal reads may collapse
  into activity grammar, but active/failed lookups stay individually visible and
  every absorbed read keeps a receipt.
- **Web / citations:** Searching/Opening/Found/Failed, query/action, domain/URL,
  progress + count, linked sources, fetched content collapsed by default,
  citations as a compact source list (not a bare count).
- **Collaboration / subagents:** spawn, message, wait, list, read-output,
  interrupt/close — each with its concrete facts (role/nickname/model/status,
  target states, agent table, linked child + final). Reuse the existing child
  drill-in / mini-feed. A spawn-result envelope absorbs into the spawn row only
  when the final child report stays available through its own owned source — the
  regression where spawn suppression destroyed final reports gets an explicit
  fixture.
- **Tasks / todos / plans / schedules / skills / workflows:** checklist +
  lifecycle language, not JSON archaeology. Workflows show name, run/resume
  relationship, phase, agent progress, completion, final result/coverage gaps —
  and stay a concise one-line row until expanded, honoring the truncate-by-default
  rule. Workflow rendering consumes bounded Workflow MCP event models and never
  reintroduces high-frequency raw payloads into the feed.
- **Questions:** AskUserQuestion shows text, options, single/multi state,
  free-text affordance, durable answer. Clickability comes from the authoritative
  live condition that owns input, never from a mere transcript row — a historical
  question is a record and cannot send stale keystrokes.
- **MCP / structured tools:** a visual protocol, not one component per server —
  Calling/Called/Failed, humanized name, server badge, safe headline, bounded
  key/value input, output dispatched by declared content block (text/ANSI, JSON/
  table, image, audio/file, embedded resource, resource link, empty, error).
  Known Agent Code orchestration/workspace/workflow tools route through richer
  provider-owned components first; a server-specific component appears only when
  repeated fixtures prove the generic grammar isn't good enough.
- **Rich media / system:** inline images (source/alt + safe open), image
  generation (status, safe revised prompt, preview, saved path), notebook cell
  diffs, LSP operations, workspace/worktree/config transitions, hooks/notices/
  snapshots/errors/compaction as intentional system grammars, and unknown
  committed kinds as a bounded fallback — never an empty text branch.

## Conditions are a parallel semantic system

The user raised this as an explicit open question — _"how does our conditions
system translate into this new system? For example compaction and stuff like
that?"_ — and it must be answered, not folded into tool cards. Conditions answer
_"what live interaction or transient state needs a surface?"_; feed rendering
answers _"how should durable owned work be painted?"_ They share primitives and
provider-ownership rules but never a catch-all classifier.

The current conditions architecture is the positive reference and the exact
import direction the feed renderer emulates:

```text
provider headless/session detects condition state + actions
  -> ProviderConditionSnapshot (namespaced kind)
  -> provider condition view registry + policy
  -> shared ConditionOutlet routes by kind without reading provider state
```

`src/shared/conditions-core/` owns only generic record/action/view contracts +
routing; `src/providers/<provider>/renderer/conditions/` owns the state→view
adapter + policy. **Do not move `conditions-core`, provider condition views, or
policies** as part of the feed rewrite.

**Compaction proves why the split matters** — it exists in two independent forms:

1. **Live condition:** `claude.compaction` is a transient read-only strip with
   running/error/done state; not an attention kind unless it errors.
2. **Durable transcript semantics:** provider transcript mappers normalize a
   completed compaction into `compact_boundary` + `compact_summary` entries.
   Provider durable-entry dispatch owns admission; a model-only shared protocol
   owns only the visual grammar.

The live strip must never become a feed tool card, and the durable summary must
never depend on a still-live condition snapshot. Restart/replay must recover the
durable entries even though the transient condition is gone. This
live-vs-durable translation is the template for every condition.

The condition transport must not become the semantic owner of compaction.
Phase 10 inventories Claude's proxy/semantic synthesis signals plus committed
boundary/summary evidence, Codex's semantic `compaction` plus durable
`compacted` evidence, and OpenCode signals only where recordings prove them.
Structured semantic/proxy evidence is preferred for live state; screen parsing
is retained only as a compatibility fallback when a provider/version exposes no
usable structured live signal. Explicit precedence, deduplication, and
provenance rules must produce one monotonic lifecycle when structured and screen
signals both fire.

Condition wire structures belong in the evidence catalog, but their
`destination` is one of `condition-outlet`, `feed-inline`, `composer`,
`attention-only`, or `intentional-hidden` — so a known condition with no outlet
view is not mistaken for a missing component (AskUserQuestion is feed-inline +
attention but has no outlet view; the slash picker belongs to the composer;
compaction has an outlet view but isn't normally attention-worthy). The explicit
condition policy is retained and never inferred from the view registry. Seed the
matrix from current code (`claude.trust-dialog`, `permission-prompt`,
`resume-prompt`, `compaction`, `ask-user-question`, `slash-picker`;
`codex.trust-dialog`, `approval`; `opencode.permission`, `question` — full table:
long plan §Conditions), then make it executable via provider catalog definitions
plus coverage tests. One semantic kind may carry multiple structural fingerprints
across versions. Fixtures cover the whole detector lifecycle (absent → prefix →
option/cursor change → resolution-with-surviving-durable-evidence → malformed →
safe no-action + inbox sighting). The observer records condition _structure +
destination_, never the question/command/workspace/option text.

## Storage, evidence fidelity, backpressure, restart

Reuse, do not rebuild — the repo already has `SessionRecorder` (bounded local
capture + retention), replay through the real reducers, `UnknownRegistry`
(shape paths, payload hashes, counts, dispositions), recording/bundle corpus
tests, tick-by-tick prefix replay, and **48 checked-in rendering bundles** to
seed the inventory. A parallel framework would duplicate all of that hardening.

- **Runtime (dev-capture only):** emit structural sightings;
  dedupe by fingerprint + increment counts; keep every buffer bounded; never
  duplicate bulky scalar payloads into the shape sidecar because the linked
  recording already preserves them exactly; retain every admitted literal key;
  observer failure is swallowed, counted, surfaced in the debug panel, and can
  never affect rendering or session execution.
- **Recording sidecar:** coalesced metadata appends as a synthetic
  `__render_shape` recording line — like `__note`, replay ignores it as an input
  event while extraction/audit consume it. Dropped/capped counts go into recorder
  metadata.
- **Backpressure by construction:** the per-session dedup map + coalesced,
  hard-capped queue guarantee no per-token IPC flood — the freeze incident's
  root cause is eliminated structurally, not by tuning.
- **Restart:** the inbox and report are _derived_ from disk-backed recordings +
  checked-in catalogs, so they survive restart with no second database.
- **Offline extraction:** aggregate sightings from exact developer recordings,
  suggest catalog entries + representative fixtures,
  derive prefix fixtures from recorded ticks, and require a human-readable diff
  before any catalog/fixture update. A local sighting never auto-promotes to a
  checked-in catalog entry; the catalog is reviewed evidence, not telemetry.

`UnknownRegistry` evolves toward a bounded sighting sink: group by structural
fingerprint, keep payload hashes only for counts/dedup, optionally record
known-shape sightings during capture to prove coverage, keep exact bounded local
windows for diagnosis (never for identity), and attach disposition + destination
so intentional generic/hidden cases don't read as unfinished.

## Target repository tree (concise)

Files land only when their phase has real content — this is not permission to
scaffold. The exhaustive before/after tree and the new / modified-file ledger
live in the long plan (§Repository change map); here is the ownership shape:

```text
src/shared/types/renderShapes.ts             common metadata-only contracts
src/renderer/src/rendering/evidence/
  shapeFingerprint.ts                        full key capture + normalized identity
  defineRenderShape.ts                       catalog definition helper
  catalogCoverage.ts                         fixture/catalog/claim audit
src/renderer/src/rendering/model/unknowns.ts structurally keyed unknown registry
src/renderer/src/features/feed/evidence/
  observer.ts                                bounded per-session sighting sink
  outcome.ts                                 paint decision -> receipt
  RenderShapeCaptureContext.tsx              capture gate / session binding
src/renderer/src/features/debug/devModules/RenderingShapes/
  UnknownShapeInbox.tsx                      local grouped report
  unknownShapeReport.ts                      derive report from sidecars+catalogs
src/main/recording/SessionRecorder*.ts       existing; accepts __render_shape
src/main/ipc/devDebug.ts + src/preload/api/devDebug.ts   dev-gated batch IPC
src/providers/<provider>/renderer/
  shapes.ts                                  typed per-provider catalog
  adapters/*.ts                              provider wire -> protocol model mapping
  components/<component>/index.tsx           ONE distinguished component per directory
  rows/dispatch.tsx                          provider dispatch table
src/providers/shared/renderer/protocols/
  code-edit/*                                first proven shared protocol
  command/*  structured-tool/*               later, after independent adapters
scripts/
  audit-rendering-shapes.mjs                 known/unknown/misrouted coverage
  extract-rendering-shape.mts                fingerprint -> complete local draft
testing/fixtures/rendering-shapes/<provider>/<shape-id>/*
```

No current folder is renamed; `presentation/` is not introduced; `projection/`
stays deferred (see below). Existing provider `rows/` and shared `rows/` coexist
until each family migrates and its old route is provably unused.

**Dir-per-component convention (2026-07-16 amendment, product-owner rule):**
every distinguished component a provider renders gets its **own directory**,
even while it is a single file — `components/edit/`, `components/write/`,
`components/apply-patch/`, and a future OpenCode write is
`providers/opencode/renderer/components/write/`, never a branch in a shared
file. The directory is the unit of ownership (fixtures/sub-parsers/tests land
beside the component instead of accreting into a grab-bag `rows/<P>Rows.tsx`),
and `ls components/` doubles as the provider's specialized-rendering coverage
list. The same rule holds inside shared protocol families: command formatters
are `protocols/command/formatters/<family>/index.ts` plus one registry line.
When a formatter earns richer UI, its directory may also own a typed model,
detector/parser over normalized command evidence, component, and tests; Git is
the first planned example, not permission to rebuild a shared wire classifier.
`rows/ClaudeRows.tsx` / `rows/CodexRows.tsx` survive only as zero-logic
re-export barrels for the grandfathered `BlockRow` import edges and are
deleted with their `GRANDFATHERED` entries when BlockRow migrates to
`renderOperation`; provider-internal code imports component directories
directly. Full rationale: long plan §One directory per distinguished
component.

## Test-first delivery phases

Every family lands through fixtures before broad integration. All phases remain
on PR #555; each is an independently reviewable, fixture-gated checkpoint, and
the PR merges only after Phase 10 plus the final whole-branch review.

- **Phase 0 — this plan-only PR.** Deliver the contract + non-goals + salvage
  map, no runtime change. Gate: a reviewer can trace an unknown shape from
  observation → catalog → fixture → component → shared protocol → test.
- **Phase 1 — fingerprint + typed catalog contract.** Files:
  `shared/types/renderShapes.ts`, `rendering/evidence/shapeFingerprint.ts`,
  `rendering/evidence/defineRenderShape.ts`, `rendering/model/unknowns.ts`.
  Red/green: same structure/different content →
  same fingerprint; discriminator change → different fingerprint; dynamic/auth-key,
  cycle, depth, array, large-object, and unserializable-input tests; canonical
  typed key paths (types, not keys alone); re-key unknowns by fingerprint keeping
  bounded payload-hash samples; `defineRenderShape` + coverage helpers; the narrow
  provider-import boundary test. No IPC/UI/dispatch/visual change. Gate:
  deterministic fingerprints, unchanged existing corpora, no scalar content in
  the fingerprint, and literal structural keys retained in dev evidence.
- **Phase 2 — shape observer + recording sidecar.** Files:
  `features/feed/evidence/*`, dev-gated preload/main batch IPC, narrow
  `SessionRecorder` additions. Red/green: observer inert when capture off; one
  unknown prefix ×
  thousands → one bounded record + counts (no IPC flood); outcome/lifecycle
  milestones emit explicit records; queue caps / coalescing / final flush /
  unmount / shutdown / missing recorder / serialization failure; sighting
  metadata retains bounded literal structural keys but no scalar prompt/command/result values; `__render_shape`
  appended through the existing lifecycle; dropped/capped counts in metadata.
  Gate: capture creates recording-linked sightings, no per-token flood possible
  by construction, capture-on doesn't change the render tree, diagnostic failure
  can't throw into provider/feed.
- **Phase 3 — inbox + audit/extraction tools.** Files: Dev Debug inbox,
  `scripts/audit-rendering-shapes.mjs`, `scripts/extract-rendering-shape.mjs`,
  fixtures README on first fixture. Red/green: pure report over sidecars +
  catalogs; group by fingerprint with known/misrouted/unknown status; link to
  cursor/note/provenance; extract exact final + prefix windows;
  open/export/attach-note commands; classification stays reviewed source. Gate:
  a developer sees a new unknown, runs one command, gets a complete local
  fixture draft without grepping JSONL; inbox survives restart; known /
  intentional cases don't read as unknown.
- **Phase 4 — seed the inventory before rewriting cards.** Inputs: 48 bundles,
  existing recording fixtures, local recordings referenced by PR #524, `vendor/`
  source only as corroboration. Create human-readable provider-prefixed ids for
  every distinct shape; record multiple fingerprints under one id when versions
  differ but semantics don't; split only on real visual/lifecycle difference;
  attach provenance when verified (unknown, never inferred, when absent); mark
  current outcomes; add catalog↔fixture + import-boundary CI checks; publish a
  coverage report (total / unknown / misrouted / generic / specialized /
  missing-prefix). Gate: zero unclassified fingerprints in the checked-in corpus;
  high-frequency edit + command shapes have complete + prefix fixtures; no
  renderer invented from an unobserved tool list.
- **Phase 5 — provider operation boundary + code-edit vertical slice.** The
  architecture proof and first user-visible rendering PR. Files: narrow
  `renderOperation` capability, `ProviderOperationBoundary` + receipts, Claude
  code-edit adapter/component, Codex code-edit/unified-exec adapter/component,
  shared `protocols/code-edit`, shape fixtures + DOM/perf tests, selected PR #524
  diff/streaming primitives ported with their tests. Red/green: make
  Claude/Codex edit fixtures fail first; independent recognizers/parsers; map
  each to `CodeEditRenderModel` and prove the shared view has no provider
  imports/branches; render path/counts/hunks/status/errors line by line; assert
  same outer DOM node/key across prefixes + live→committed handoff; emit receipts
  and verify inbox items close; shadow-compare each migrated shape vs legacy; cut
  over only catalogued edit shapes; delete an old route only when the catalog
  proves no shape claims it. Gate: modern Codex edit shows an edit as soon as
  patch intent/path is proven (never wrapper JavaScript); Claude/Codex share only
  the protocol/view; huge/streaming diffs stay bounded; success + failure never
  disappear; ownership corpus unchanged. **Decide here whether any neutral
  `projection/` responsibility remains — default no.**
- **Phase 6 — command grammar + trusted formatters.** Independent
  Claude/Codex/OpenCode command adapters/components; shared command protocol only
  if all mappings fit honestly; formatter dir populated one proven grammar at a
  time; PR #524 ANSI/output/streaming primitives ported with caps. Fixture matrix
  covers live + committed, unified/classic/local/Bash/OpenCode, multi-command
  wrappers, CRLF, ANSI/span bombs, empty success, nonzero/timeout/cancel/deny,
  bg-session/stdin/wait/uncorrelated, large head/tail/paging, git/test/
  diagnostic/JSON formatter success + decline. Gate: distinctive command UI
  without losing raw evidence; formatters can't claim malformed output; no
  cross-provider wrapper parsing; no per-delta whole-output work or unbounded DOM.
- **Phase 7 — reads/search/web + collaboration.** Separate inventory-first family
  PRs (reads/list/search/discovery; web search/fetch/open/find + citations;
  spawn/message/wait/list/read/interrupt/close; task notifications + child
  drill-in). Each adds adapters, protocols only when proven, fixtures,
  accessibility/DOM tests, receipts. Low-signal grouping names every absorbed
  owner and keeps failures/active work individually visible. **Completed
  2026-07-17 at the evidence boundary:** Claude read/tool discovery/web/Agent,
  Codex web plus two proven native-spawn inputs, and Agent Code's exact eight-op
  orchestration protocol now have provider-owned paths across semantic and
  committed rendering. Current Codex MCP-inside-exec results use nested
  pretty-JSON without a false orchestration join. Arbitrary MCP and unstable/
  unpaired native collaboration remain explicitly generic; Codex unified-exec
  `wait`, LSP, and compaction are classified into their actual later phases.
  The frozen corpus is structurally clean and all unsupported observed Phase 7
  shapes have a named fallback/TODO rather than an invented component.
- **Phase 8 — tasks/questions/workflows/MCP + rich media. Completed 2026-07-17
  at the evidence boundary.** Captured task mutations, Skill, ScheduleWakeup,
  Codex update_plan, questions, Agent Code workspace operations, typed MCP
  blocks, structured output, and safe media now have provider-owned paths.
  Agent Code Workflow is admitted only by its source-controlled schema and
  carries an explicit paired-fixture TODO. Uncaptured Claude TodoWrite/plan-mode and
  invocation-only Notebook/LSP/Monitor/task-query/workspace-transition/
  third-party-MCP shapes are deliberately generic with per-family evidence
  requirements rather than speculative cards. Provider condition destinations
  are explicit, large disclosures are lazy/bounded, non-conversational system
  metadata remains ledger-excluded with a total muted fallback. Durable compact
  entries were intentionally deferred to Phase 10 and are now provider-owned.
- **Phase 9 — long-tail coverage + proven deletion. Implementation completed
  2026-07-17; fresh live soak remains an operator merge check.** The frozen
  corpus has 3,686 known observations with no structural unknown. The retained
  local sidecars contain 1,250 obsolete schema-v1 receipt sightings and zero
  post-cutover schema-v2 sightings, so the audit ignores them explicitly rather
  than posing old PR-local receipts as current drift. After the feature overlay
  is restarted, a fresh schema-v2 developer recording must be captured before
  merge. The audit sorts its bounded newest-recording window and
  prints actionable fatal details. Deterministic semantic routes graduated;
  content/paired-dependent prefixes, reasoning, results, unified exec, Git, and
  compaction were left for the paired Phase 10 cutover. Duplicate result/partial decoders and
  the Claude/Codex feed barrels, central ToolUseRow, answered-question, and Todo
  exceptions are gone; the generic structured/MCP/media/raw fallback stays
  total and the import-boundary gate proves shared feed neutrality. Evergreen
  docs record the as-built deletion proof and PR #524 port/reject matrix; #524
  is closed as superseded.
- **Phase 10 — final Git + compaction ownership convergence. Completed
  2026-07-17.** Landed the
  actual paired `renderOperation(ProviderOperationInput)` boundary promised by
  Phases 5–6, so one renderer receives correlated tool-use + result evidence.
  Moved feed Git detection/parsing/cards out of `Block.tsx` and
  `features/git/ui/GitRows.tsx` into a rich shared command formatter directory,
  preserving conservative decline, bounded raw output, and explicit result
  absorption receipts; keep the persistent Git bar in `features/git/`. Remove
  and deleted the Git-only `customRendering` gate after proving it had no
  remaining product meaning. Moved durable compact boundary/summary rows out of central
  `EntryRow` selection into provider-owned compaction adapters/components backed
  by `providers/shared/renderer/protocols/compaction/`; colocate each provider's
  transient compaction condition view under its compaction directory while
  keeping live condition state separate from durable feed semantics. Audit and
  prefer structured semantic/proxy compaction signals, leaving screen detection
  only as a documented compatibility fallback. Fixtures cover structured-only
  with screen detection disabled, screen-only fallback, both-source dedup,
  disagreement, error/done, restart/replay, and Codex compaction never rendering
  as an empty generic marker. Gate: no shared feed dispatcher recognizes Git
  intent or raw provider compact discriminators; named provider receipts own
  every migrated outcome; both signal
  sources produce one monotonic live lifecycle; durable compaction survives
  replay; every removed route has catalog + fixture + shadow/replay proof; and
  the corpus has no unknown, misrouted, unsupported, or unknown-outcome residue
  for the migrated shapes. The Git comparison setting and prerelease evidence
  compatibility were deleted; provider durable-entry dispatch now also owns
  Claude task notifications/questions instead of leaving provider XML/payload
  vocabulary in the shared feed.

Cross-phase test contract (full lists: long plan §Testing): fingerprint
stability + literal-key capture/normalized identity; catalog↔adapter agreement both directions; every
rendered entry has fixtures; provider fixtures exercise only that provider's
adapters; malformed/future payloads fail closed to a visible fallback; shared
protocol components tested model-only with no provider names; accessibility
(labels/icons accompany color, keyboard disclosure, status-as-text); large input
creates no eager unbounded DOM; all existing ownership/corpus tests stay green;
live + committed for one operation never double-render; restart/replay yields the
same terminal model; legacy routes deleted only after shadow comparison shows no
unowned/omitted content.

## PR #524 salvage matrix

PR #524 is required reading — _"a FAT but very very important PR"_ — and
simultaneously _"a disaster... with 10s of problems."_ Flag it **draft**, and
port selectively **with tests**, never by copying directories.

**Retain (port with regression fixtures):** ANSI parsing/painting with span caps
plus control-sequence hardening; bounded output with head/tail previews; diff
primitives + per-file summaries; stable streaming-code ideas (sealed-line
caching); segmented streaming Markdown where the perf claim reproduces; safe
partial JSON/string extraction _inside provider adapters_; lazy expansion +
large-content caps; status vocabulary, path labels, disclosure primitives;
fixture discoveries + real wire examples + regression tests; omission/projection
receipt concepts _if_ a neutral assembly stage later proves necessary.

**Reject (do not port wholesale):** the global 17-family taxonomy as assumed
truth; shared classifiers that call provider extractors; shared artifacts
importing a provider; the two-stage `OperationVM`→`ArtifactVM` double projection;
provider switches inside shared components; result suppression before the
replacement proves it consumes the result; large simultaneous legacy deletions;
directory naming that only mirrors the draft branch.

## Open decisions to resolve with evidence

1. **Does a provider-neutral `projection/` stage earn a home?** Decide after the
   code-edit slice. Default: no. If created, it assembles already-interpreted
   nodes + omission receipts; it may not parse wire shapes, import provider
   modules, or become a global classifier.
2. **Where is model/CLI version provenance trustworthy per provider?** Audit real
   start/semantic/recording metadata before defining required fields. Missing
   provenance is `unknown`, never inferred from content.
3. **How much known-shape runtime sighting is affordable?** Benchmark explicit
   capture; production rendering must not pay unbounded per-delta shape work.
4. **Which PR #524 primitives already match current `main` contracts?** Port via
   small PRs with their fixtures; do not assume draft-branch code is still
   correct.
5. **Which command formatters ship first?** Choose by observed frequency + user
   value, not an exhaustive command taxonomy.
6. **Can every provider/version expose live compaction without screen parsing?**
   Decide from captured structured events, not preference. Where the answer is
   no, keep screen detection as an explicit versioned fallback with provenance
   and deduplication rather than making the screen channel the primary contract.

## Definition of done

- Every observed distinctive shape in the checked-in corpus has a typed catalog
  entry + representative fixture; unknown shapes are structurally deduplicated,
  bounded, safe, and visible.
- Claude, Codex, and OpenCode interpretations are isolated behind provider
  renderer capabilities; shared protocols contain no provider types or branches.
- Code edits and commands render with high-quality, accessible,
  provider-consistent UI without sharing raw decoders; live/committed/prefix/
  restart/replay behavior is covered.
- Compaction and all conditions keep their separate transient + durable
  semantics; structured semantic/proxy signals lead live compaction where
  available, screen detection is only a proven compatibility fallback, durable
  entries render through provider-owned compaction directories, and the
  ownership/order pipeline stays the source of truth for what may paint.
- Feed Git rendering is a paired-evidence command formatter, while the
  persistent workspace Git bar remains an independent product surface.
- PR #524 is reduced to a closed historical/salvage reference, not a giant
  conflicted merge candidate.
- A future agent can answer _"what shapes exist, where was each observed, how is
  it rendered, and which fixture proves it?"_ by reading code and fixtures — not
  by reconstructing history from conversations. That is the whole point: we stop
  forgetting what the providers emit.
