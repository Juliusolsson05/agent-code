# Provider Switching — Design

> Status: evergreen design doc. Update this when provider-switch ownership,
> compaction policy, or native transcript semantics change.

## Purpose

Provider switching moves one live Agent Code pane among Claude, Codex, and
OpenCode while preserving enough conversation state for the target provider to
continue useful work. The target receives a new provider session and a newly
projected native transcript. The local Agent Code pane is replaced only after
every preparation step succeeds.

This is not a byte-for-byte format conversion. Claude and Codex persist
different concepts, and some provider-owned data is intentionally not portable.
The durable contract is therefore:

1. Decode the source into `ConversationDocument`.
2. Determine the effective history after the latest real compaction.
3. Ask the parser for a typed target-context plan.
4. If the plan does not fit, shrink deterministically and report what that cost.
   (Compacting through the live source provider and waiting for durable evidence
   of completion is an opt-in alternative, not the default — see "Source
   transcript mutation".)
5. Project the effective conversation into the target's native transcript.
6. Persist it through the target adapter (file write for Claude/Codex, supported
   CLI import for OpenCode).
7. Replace the pane only after persistence succeeds.
8. Optionally, once the pane is live, ask the TARGET to compact with its own
   quota — see "Arrival compaction". That step is outside the transaction and
   its failure is never the switch's failure.

## Capacity outcomes

The parser owns semantic history, capacity planning, durable-compaction
classification, and provider portability rules. It does not own live processes,
timeouts, prompt delivery, or UI.

`planConversationContext(conversation, targetProvider, budgetCharacters, options?)`
takes `options.allowSourceTurns`. It defaults to `true`, which preserves the four
original outcomes byte for byte — every caller that predates quota-independent
switching keeps the behaviour it was written against, including the two outcomes
that instruct the host to spend a live turn on the source. The host passes
`false` by default (`DEFAULT_SWITCH_CONTEXT_POLICY` in
`src/main/providerSwitch/switchProvider.ts`), and that path returns only outcomes
the host can execute alone.

| Outcome | Reachable with | Meaning | Production action |
|---|---|---|---|
| `ready` | both | Effective history fits the target | Project immediately |
| `existing-compaction` | both | A persisted portable summary plus newer turns fits | Project from that summary boundary |
| `requires-portable-handoff` | `allowSourceTurns: true` only | Codex has a durable encrypted compaction, or OpenCode lacks a portable native summary | Ask the live source for a read-only plaintext handoff |
| `requires-compaction` | `allowSourceTurns: true` only | No sufficient persisted summary exists | Drive native source compaction, then reassess |
| `raw-history` | `allowSourceTurns: false` only | The latest compaction carries nothing the target can read, and the plaintext records it claimed to replace still fit | Project the stripped history; the source is never consulted |
| `shrunk` | `allowSourceTurns: false` only | Nothing else fits; the deterministic ladder removed content and reported what it cost | Project the shrunk conversation and surface the report |

When even the ladder cannot fit one complete user turn, the planner throws
`ConversationUnfittableError` carrying the report so far. There is deliberately
no seventh outcome, because none could honestly describe "we emitted half a
turn": a transcript that starts mid-turn asks the target to continue an
assistant message it never wrote, or answers a `tool_result` whose `tool_use` is
gone — Claude rejects the whole resumed conversation for the second case.

Ordering inside the `allowSourceTurns: false` planner is the design, not an
implementation detail. Slice at the latest portable compaction FIRST — a
plaintext summary the source wrote has already replaced everything before it, so
stripping first would resurrect records the source itself evicted and show the
target both the summary and the history it summarizes. Then strip what the
target cannot read. Only then shrink. The second step is what converts the old
`requires-portable-handoff` outcome, which cost a live source turn, into
`raw-history`, which costs nothing — and the Stage 0 census says that is the
common case, not the exotic one: 211 of 230 single-compaction Codex rollouts
(91.7 %) keep a median 74.3 % of their characters ahead of the compaction.

Lossy suffix truncation still exists as an explicit parser operation
(`fitConversationToCharacterBudget`) for diagnostics and emergency tooling, and
the ladder's fourth rung reuses its boundary rules. Neither is ever implicit. A
switch that loses anything reports what it lost.

Character estimates intentionally exclude `source.raw`, because raw provenance
duplicates semantic content and can be much larger than the prompt the target
actually constructs. Target budgets reserve room for provider-added system
instructions, tool schemas, and environment context.

## The shrink ladder

`packages/agent-transcript-parser/src/operations/shrink.ts` is the only place
that decides what a conversation loses when it must fit a smaller window with no
model call. Rungs are ordered by what the loss costs the target model, cheapest
first, and every rung stops the instant the estimate fits — a conversation 5 %
over budget loses a few old tool outputs, not a third of its history.

1. **Strip compactions the target cannot read.** Only `portable` compaction
   entries survive, so encrypted Codex carriers, `incomplete` Claude boundary
   placeholders and `rejected` rate-limit carriers all go in one rule. That is
   deliberate: all three mean "this entry carries no history a foreign target
   can use", and in all three the records it claims to summarize are still in
   the conversation. Portable and synthetic summaries stay — a synthetic marker
   is the ladder's own output, and re-running must not delete the explanation of
   an earlier drop. Report: `strippedCompactions`.
2. **Clear tool results, oldest first,** replacing the output with
   `[tool output cleared during provider switch: N characters]` while keeping
   the entry, its `callId` and its `isError`, so the call/result pairing every
   projector relies on is untouched. `N` is the raw payload length the model
   lost, not the serialized budget estimate. A net-savings floor skips any
   result whose placeholder would be longer than the output it replaces —
   without it the report could claim a saving while the conversation grew, and
   the report is the host's only evidence of what the switch cost. Tool-call
   inputs are never touched here; edit diffs live in them. Report:
   `clearedResults`, `clearedChars` (net).
3. **Trim long tool-call inputs,** oldest first, above `maxInputChars`. Objects
   are trimmed member by member rather than stringified, because a Claude
   historical `tool_use.input` must be an object: replacing
   `{ file_path, content }` with a string forces the projector's
   `input-object-repaired` path and the target then sees a `Write` whose
   `file_path` has vanished. Only the record's own top-level string members are
   trimmed — strings nested inside a member object or array are left to rung 4,
   because recursing would mean deciding which nested key is safe to gut without
   knowing any tool's schema, which is exactly the provider knowledge this
   module does not have. The cap applies to the *serialized* result including
   the truncation marker and is found by binary search, so this arithmetic and
   the budget arithmetic cannot disagree. Report: `trimmedInputs`,
   `trimmedChars` (net).
4. **Drop the oldest complete turns,** cutting only at a safe resume boundary
   and explaining the loss in a synthetic compaction marker that indexes the
   dropped user prompts. The marker is budget-aware: its prompt index is trimmed
   oldest-first to fit the room left, and a carried-over plaintext summary is
   dropped before the headline is, because the headline is the only part the
   target actually needs in order to know history is missing. Report:
   `droppedEntries`, `droppedTurns`, `retainedDeveloperMessages`,
   `promptIndexLength`.

Recent-turn protection on rungs 2 and 3 is narrower than "never inside the most
recent `keepRecentTurns` user turns":

- more than `keepRecentTurns` user turns — the original rule;
- two to `keepRecentTurns` turns — the final turn only, so the work in progress
  survives without the newest turn becoming clearable at the exact moment the
  option's value is met rather than exceeded;
- exactly one user turn — no protection at all. The rule is a statement about
  the boundary between old history and recent work, and a single-turn
  conversation has no such boundary; applied literally it protects 100 % of the
  transcript and makes the ladder a no-op. `claude-sequence-oversized` is a real
  67-entry transcript with one user message, 92.1 % of its characters in tool
  results and 1.11× the Codex budget. Declaring that unfittable while nine
  tenths of it is stale tool output would be a worse answer than the evidence
  supports.

`keepDeveloperMessages` decides whether rung 4 lifts developer-role messages out
of the dropped range and keeps them after the marker. It defaults to `true`,
which is what the census supports about a source thread: Codex developer
messages are 36.9 % of the repeatedly-compacted fixture's characters and are the
only plaintext left in a remotely-compacted rollout. But whether retention is
worth budget depends on what the *target* persists, so the PLANNER sets it, not
the ladder — see "Provider knowledge" below. Either way the marker records how
many developer messages existed, so a deletion is never silent.

Thresholds are `keepRecentTurns: 3`, `maxInputChars: 8,000`,
`maxIndexedPrompts: 40`, `promptIndexChars: 200`. The first two are
**placeholders chosen by argument, not by measurement** — the census reports no
per-turn size distribution and no tool-call input-size percentiles, and rung 3
did not fire at all in the committed ladder runs. The Stage 7 live probe is what
replaces them with observed numbers; until it reports, treat both as
unvalidated. The last two only bound a courtesy list (8,208 characters worst
case, 1.4 % of a real 581,400-character budget) so the index cannot itself
become the thing that overflows the window.

### Provider knowledge

The ladder knows entry kinds and character budgets. It never names a provider,
its single consumer is `operations/contextBudget.ts`, and no projector, decoder
or host file may import it. Sizing policy has exactly one home, so the host
cannot arbitrate sizes itself and a projector cannot grow a second opinion.

There is ONE provider-specific decision in this area, and it lives in the
planner rather than the ladder: `keepDeveloperMessages` defaults to
`targetProvider !== 'claude'`. The Claude native-resume projector drops every
developer- and system-role message outright
(`packages/agent-transcript-parser/src/claude/project/nativeResume.ts`,
`native-resume.message.<role>.dropped`), so retaining them for a Claude target
would charge the budget for content deleted on arrival — and could raise
`ConversationUnfittableError` on a conversation that in fact fits, refusing a
switch to protect messages the target then throws away. Codex preserves the role
verbatim; OpenCode demotes it to labeled user context. An explicit caller option
still wins, so a host that knows better is not locked out. The durable shape
would be a capability flag on the projector profile; no projector exposes
capabilities today, so this stays a hard-coded provider string with this
paragraph as its record.

## Source transcript mutation

Source-side compaction is **opt-in and off by default**. The default transaction
never delivers a prompt to the source provider: it reads the transcript, plans
with `allowSourceTurns: false`, shrinks deterministically if it must, projects,
writes, and replaces the pane. That is the whole point of the feature — it
exists for the moment the source provider is out of quota, when asking it to
compact itself is guaranteed to fail, and fails only *after* `/compact` has
already destroyed the history the switch was trying to rescue.

A user can still choose the old path with
`contextPolicy.allowSourceTurns: true` ("compact on source first" in the bulk
modal). Then Agent Code submits `/compact` to the live source session, the
source provider appends its own native compaction records to the source
transcript, and the switch stays locked until a durable compaction record
appears or the operation fails. The checkbox is **disabled while the source is
exhausted** and the modal forces the policy to false in that state, because that
combination spends quota the provider has already refused. The confirmation is
one batch-level arm-and-confirm in the modal on this path; main's per-agent
native dialog is skipped when the request says a human already confirmed
(`sourceCompactionConfirmed`).

The pane is not replaced while any of this happens. If compaction, summary
extraction, projection, or target write fails, the user remains on the source
provider.

## Claude compaction

Claude persists one semantic compaction across two records:

1. `system/subtype=compact_boundary`
2. a following `user/isCompactSummary=true` carrier

Current Claude versions put the generic UI text `Conversation compacted` in the
boundary's `content`. The actual detailed handoff is in the carrier's message
content. The decoder must always prefer the carrier when it exists, even when
the boundary content is non-empty. Treating the placeholder as authoritative
causes a structurally valid switch that has forgotten all substantive work.
The live poll therefore treats the boundary as incomplete and waits for the
carrier instead of accepting the first syntactically valid JSONL snapshot.

Claude's summary is plaintext and can be represented natively in another Claude
transcript or carried to Codex as ordinary history.

### A carrier that is not a summary

`compactionAvailability` has a fourth value, `rejected`, for a Claude carrier
whose text contains one of Claude Code's rate-limit lines
(`CLAUDE_RATE_LIMIT_PREFIXES`, byte-identical to that product's
`services/rateLimitMessages.ts`). Claude Code's own compaction only rejects a
summary that starts with `API Error`, so a limit hit during `/compact` can
plausibly be persisted *as* the summary — a carrier that looks entirely healthy
to a fingerprint-and-availability check while the history it replaced is gone
(#820).

Two details of the rule matter:

- The match is at **any line start**, not at position 0, because the parser only
  ever sees the persisted, *wrapped* record.
  `getCompactUserSummaryMessage` unconditionally prefixes "This session is being
  continued from a previous conversation that ran out of context…", so the limit
  text lands roughly 150 characters in, behind that preamble and usually behind
  a `Summary:` header as well. A `startsWith` check would never fire on the
  exact artifact the guard exists to catch. The cost of the wider match is a
  false `rejected` on a genuine summary that happens to open a line with "You've
  used" — which costs one raw-history carry. The cost of missing one is a
  destroyed conversation.
- It is gated on `entry.source.provider === 'claude'`, because the prefix list
  is Claude Code's own and the line-start match is wide enough that an unrelated
  Codex or OpenCode summary would otherwise be discarded for words no other
  provider writes as a limit notice.

`conversationAfterLatestPortableCompaction` treats `rejected` exactly like
`native-only` and `incomplete`: all of them mean the pre-compaction turns must
be reconsidered, and a separate branch would only be a second place to forget
the next value.

Separately, the Claude decoder maps an assistant record with
`isApiErrorMessage: true` to an `opaque` entry with `nativeType: 'api_error'`,
keeping the raw record. Claude persists "You've hit your session limit…" as an
assistant-shaped record so its TUI can render it; it is not model output.
Projecting it would carry a provider's billing message into another provider's
history as if the model had said it, and would make a rate-limit text
indistinguishable from a summary. Projectors already drop opaque entries.

The census found the hazard does not currently manifest on disk: of seven local
Claude transcripts carrying a `rate_limit` record, only one has a compaction
after the error, and its carrier is a genuine 16,632-character summary. The
guard ships anyway — it is cheap, and the failure it prevents is unrecoverable.

## Arrival compaction

The quota-independent path deliberately carries a large history over raw or
shrunk. If the user wants that history summarized, the summarizer is the
**target's** own compaction, spending the **target's** quota, *after* the pane
is live.

`src/main/providerSwitch/compactOnArrival.ts` owns it, behind the IPC
`session:compact-after-switch`. The renderer calls it fire-and-forget once
`replaceSession` returns, only for a Claude target and only when the policy
asked for it. Main holds a second in-flight lock keyed on the NEW session id:
the switch lock is keyed on the source and is released before the renderer has
even replaced the pane, and two arrival compactions on one pane would send
`/compact` twice and then race each other's wait, the second accepting the
first's carrier and reporting success for work it did not do.

The sequence is one bounded wait with two exits, then the standard compaction
wait:

1. Poll the new pane until it is either asking the resume question or ready for
   input. Readiness and the resume prompt are ONE wait on purpose: a visible
   condition *blocks* prompt input (`derivePromptGateState` returns `blocked`
   for any condition `conditionBlocksPromptInput` accepts), so readiness stays
   false while the prompt is on screen. A readiness-first gate would deadlock on
   exactly the biggest, oldest sessions the step exists for.
2. If `claude.resume-prompt` is visible, answer it with "Resume from summary" —
   `selectedIndex` Up keystrokes then Enter, mirroring what the modal does,
   because the headless condition module deliberately exposes only the two
   view-independent keystrokes and leaves selection movement to the caller.
   Claude then runs its own compaction.
3. Otherwise deliver `/compact` through the provider's prompt delivery.
4. Reuse `waitForNewCompactionOn` against the TARGET session and kind, with
   arrival-specific phrasing, and emit `compacting` progress on the new session
   id. Sharing that loop is what keeps the two #820 hazard checks from existing
   in only one of the two copies.

Failure is **reported, never thrown**: `{ ok: false, message }`, surfaced as a
toast. The pane is already live with its complete imported history, so a busy
composer, a missing prompt or a timeout leaves the user no worse off than before
and one command away from compacting by hand. Turning that into "your switch
failed" would be a lie about a transaction that already committed. Everything
below the guard clauses is inside one `try` for the same reason.

The 30-second readiness deadline is an **estimate, not a measurement**. It has
to cover Claude replaying a projected transcript that can be tens of megabytes
while sibling agents do the same, and no recording of that exists yet; the live
probe is where it gets pinned down. Whether Claude's resume dialog appears at
all for a freshly projected transcript is likewise unobserved — both branches
are implemented regardless.

Codex and OpenCode targets skip the step: Codex auto-compacts at its own
threshold and the projection is written below it, and OpenCode has no
slash-command surface outside its TUI.

## Codex compaction

Current Codex rollouts persist `type=compacted` with a provider-authenticated
encrypted item in `replacement_history`. Agent Code cannot decrypt or forge
that payload, and a plaintext object shaped like a native compaction record is
not equivalent. Codex may load such a record without a syntax error but ignore
the supposed summary when constructing the next API request.

This creates two directional rules:

- **Claude → Codex:** project Claude's plaintext compact summary as a developer
  handoff message. Do not manufacture a Codex `compacted` record.
- **Codex → Claude, opt-in path only:** if no native compaction exists, first
  let Codex run `/compact`. Then ask the compacted live Codex session,
  read-only and without tools, to write a detailed portable handoff. Persist
  only the authoritative completed-turn message—not an earlier assistant
  preamble—as the plaintext summary used to construct Claude's compact boundary
  and carrier.

The second Codex turn is necessary because only Codex can read its encrypted
replacement history. It is not a fallback truncation and does not ask Agent
Code to interpret ciphertext.

By default that turn does not happen at all. Codex keeps every pre-compaction
record on disk in plaintext — the encrypted item is the only opaque part, and
the history it summarizes is right there in the same rollout — so the
`allowSourceTurns: false` planner strips the unreadable carrier and carries the
plaintext records instead (`raw-history`). That is the whole reason a switch off
an exhausted Codex account works without Codex answering anything.

## OpenCode transcripts and oversized context

OpenCode owns its SQLite schema. Agent Code reads and writes only through the
supported `opencode export <ses_…>` and `opencode import <file>` commands; the
pure parser consumes and produces the resulting `{ info, messages }` envelope.
This boundary is shared by rendered OpenCode and OpenCode Terminal because both
are runtime flavors of the same provider identity.

OpenCode exports do not provide a portable native compaction carrier. On the
opt-in source path, when its history exceeds the target budget, Agent Code asks
the live source for one ordinary read-only handoff turn, waits for an assistant
message with a durable `time.completed`, and projects only that summary. CLI
exports have no cheap file change token, so polling is capped at one full
export/decode per second. By default there is no OpenCode handoff turn: its
oversized edges go through the same ladder as every other provider.

A brand-new OpenCode Terminal pre-creates a durable `ses_…` identity for crash
recovery before any message exists. Consequently, “provider id exists” does not
prove “transcript has content.” The main transaction returns an explicit
`source-empty` outcome, and the renderer replaces the blank pane while keeping
its unsent Agent Code draft and compatible MCP-domain policy.

## Model metadata

The target transcript and capacity check must use the same target model.

For Codex, Agent Code reads the active profile (or top-level model and model
provider) from `$CODEX_HOME/config.toml`, then resolves context metadata from
`models_cache.json`. A stale hardcoded model can produce a transcript that loads
with `Model metadata ... not found`, prevents prompt submission, or applies the
wrong context budget.

If exact cache metadata is unavailable, the configured model remains the target
identity and the budget falls back conservatively. If no model identity can be
resolved at all, lookup fails before a target transcript is written.

Claude uses an explicit `ANTHROPIC_MODEL` or `settings.json` model when present.
Without an explicit `[1m]` selector, capacity planning assumes the conservative
200k window rather than treating a long-context beta as the default.

OpenCode resolves its merged project configuration through `opencode debug
config --pure`; if that has no model, the first installed `provider/model` from
`opencode models` is used. OpenCode can front providers with different context
windows and does not expose one reliable capacity field here, so switching uses
a conservative 128k planning window and carries the exact resolved provider and
model IDs into the imported native messages.

## Exhaustion signal and the bulk modal

Exhaustion is a **read-only signal that picks defaults**. Nothing in the switch
transaction may branch on it: a usage endpoint can be stale, wrong or
unreachable, and this feature exists precisely for people whose provider is
misbehaving.

`src/shared/usage/exhaustion.ts` derives, per provider, from an already
normalized `UsageProviderSnapshot`:
`{ exhausted, scope: 'all-models' | 'model-family' | 'unknown', resetsAt, label }`.
`exhausted` means an active row at 100 % or more — not the 95 % that
`severityFromPercent` already calls critical, because that value only colors a
chip while this one gates defaults in a modal that moves agents. A shared
`all-models` window wins over a `model-family` one, because it is the stronger
claim (no model on this provider will answer) and reporting the family scope
there would offer a model switch that cannot help. Scope is classified once, in
the normalizers: Claude `session` and `weekly_all` rows are `all-models` and
`weekly_scoped` rows are `model-family`; the Codex main `rate_limit` windows are
`all-models` and entries under `additional_rate_limits` are `model-family`,
passed down from the call site because a Codex window carries no field saying
what it covers. The usage IPC does **not** return the derivation alongside the
snapshot — the modal is its only consumer and derives it in the renderer.

The renderer also carries a live per-session signal,
`SessionRuntime.limitHit: { at, source: 'transcript' | 'api_error' } | null`,
set from an appended Claude assistant record with `isApiErrorMessage: true` and
`error: 'rate_limit'` — dated by **the record's own timestamp**, because a
resumed pane replays its last lines through the same channel and stamping a
days-old record with `Date.now()` would make it look newer than any turn — or
from a Codex `usage_limit_reached` api error. It is cleared on `turn_completed`
and deliberately NOT on `turn_stopped`, since a turn can stop precisely because
the limit was hit.

`isLimitIdle` (`providerSwitchCore.ts`) widens the switch guard with it: both
providers keep their process alive while a window is exhausted — Claude paints
"Usage limit reached · continuing automatically", Codex keeps the conversation
open after its 429 — so `processActive` stays true for the exact population this
feature exists to rescue. **Unknown 1 is unrecorded:** nobody has captured that
screen, so the predicate is defensive rather than evidence-driven. It can only
widen the guard, never narrow it, so being wrong about the banner costs nothing.
One known gap follows from it: a restored pane whose replayed tail contains a
genuine carrier reads as limit-idle, because `turnStartedAt` is null on such a
pane. That is the intended reading of "there is no turn to protect", and the
guard is only consulted when something else already says the pane is busy; if it
ever proves wrong, the fix belongs in `isLimitIdle`, not in the reducer.

The bulk modal (`BulkProviderSwitchModal.tsx`) turns all of that into defaults
the user can override: a banner per exhausted provider with a relative reset
("resets in 2h"), the direction defaulting to the single exhausted source (two
exhausted providers fall back, because moving agents from one full provider to
another helps nobody), "compact on arrival" offered only for Claude targets and
default on above 150,000 estimated characters in the largest pane of the batch,
"compact on source first" default off and disabled while the source is
exhausted, a "switch model instead" row for Claude family-scoped limits
(suppressed when the exhausted family is the one the command would land on), one
confirmation per batch, and per-agent strategy in the batch summary and the pane
toast. Usage polling is gated on `open`, because this modal is a permanently
mounted surface.

## Transaction and UI rules

- The renderer rejects switching during an active source turn, except for a pane
  parked on a usage limit (see `isLimitIdle` above).
- Renderer and main process both lock by the live Agent Code session id, so a
  repeated command cannot start a second compaction or target write. Arrival
  compaction holds a separate lock keyed on the new session id.
- Main emits explicit `compacting`, `summarizing`, `shrinking`, and `projecting`
  progress.
- A successful switch reports `strategy: 'native' | 'raw' | 'shrunk'` and, for a
  shrunk one, a one-line `shrinkSummary`. `truncatedBeforeSwitch` means "the
  ladder removed anything at all", not only "it dropped entries" — clearing an
  output or trimming an input is just as lossy from the target's point of view.
  Prose is formatted by the host, never by the parser, which reports numbers.
- `overflowPolicy` still works for existing callers: `truncate` now routes to
  the ladder (a strict upgrade on the whole-turn fitter it replaces, which
  refused outright when an encrypted Codex carrier was in the way), while `fail`
  keeps its legacy branch, because "refuse an oversized switch" must not
  silently become "make it fit lossily".
- The progress surface has no cancellation action after `/compact` is accepted.
- Provider-native prompt delivery owns composer readiness and Enter handling.
- Completion means a new durable transcript record, not merely a successful PTY
  write or an idle-looking screen.
- The target pane replacement happens last.

Closing or crashing the source provider still aborts the operation. The lock is
not permission to continue against a dead or re-owned session.

## Failure policy

The switch aborts without replacing the pane when any of these occur:

- source session kind or workspace no longer matches the request;
- the source transcript cannot be decoded;
- target model or context profile cannot be resolved;
- the shrink ladder cannot fit the last complete user turn
  (`ConversationUnfittableError`);
- projected native transcript validation, file write, or OpenCode import fails;
- the source process exits during orchestration.

On the opt-in source path, additionally:

- provider rejects `/compact` or the portable-summary prompt;
- no new durable compaction appears before the bounded timeout;
- native compaction still exceeds the target budget;
- an OpenCode export ends in a user or incomplete assistant message, providing
  no durable evidence that the native turn has settled;
- the latest compaction's availability is `rejected`, or an `api_error` record
  lands after the `/compact` baseline line. Both fail fast, before any pane is
  replaced, instead of waiting out the 300-second timeout or accepting the
  provider's limit message as a summary. The same probe was added to the Codex
  and OpenCode handoff waits; it is **inert in production today**, because only
  the Claude decoder classifies `api_error` records, so a Codex limit during the
  handoff turn still ends in the timeout. It is written now because it is the
  correct shape and starts working the moment those decoders classify error
  records.

Arrival compaction failure is not in this list: the pane is already live and
keeps its full history.

No failure path silently invokes lossy truncation. The ladder is the one lossy
mechanism, it runs only when the plan says nothing else fits, and everything it
removes is reported in the result.

## Code map

- `src/main/providerSwitch/switchProvider.ts` — executes the parser's typed plan,
  owns transaction order, `SwitchContextPolicy`, `SwitchStrategy` and
  `describeShrink`.
- `src/main/providerSwitch/compactBeforeSwitch.ts` — the opt-in live source
  compaction, Codex/OpenCode portable-summary orchestration, and the shared
  `waitForNewCompactionOn` / `TranscriptWatchTarget` / `latestSourceLine`.
- `src/main/providerSwitch/compactOnArrival.ts` — arrival compaction on the new
  pane. Single consumer: the IPC handler. Never imported by `switchProvider.ts`
  or by renderer code.
- `src/main/providerSwitch/transcriptEngine.ts` — provider adapters, target
  model metadata, decode/project/write boundaries.
- `src/main/ipc/provider.ts` — main-process locks (switch, and a separate one
  for arrival), the per-agent native confirmation dialog on the opt-in path, and
  progress events.
- `src/shared/usage/exhaustion.ts` — pure exhaustion derivation. Consumed by the
  bulk modal; never by `providerSwitch/*`, because the transaction must not gate
  on it.
- `src/renderer/src/workspace/hook/actions/providerSwitchCore.ts` — renderer
  lock, active-turn guard with the `isLimitIdle` exception, pane replacement
  ordering, and the fire-and-forget arrival call.
- `src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.tsx` —
  exhaustion banner, policy checkboxes, one batch confirmation, strategy tally.
- `packages/agent-transcript-parser` — neutral conversation model, compaction
  planning/portability, native projectors, and real resume probe.
- `packages/agent-transcript-parser/src/operations/shrink.ts` — the shrink
  ladder. Single consumer: `operations/contextBudget.ts`. Forbidden importers:
  every projector, every decoder, every host file. It knows entry kinds and
  character budgets, never provider names.

## Verification

Structural tests prove legal native record shapes, but they cannot prove that a
provider includes translated history in its next model request. The opt-in live
probe in `agent-transcript-parser/testing/live-resume-probe.mts` therefore:

1. reads a real transcript or corpus directory;
2. decodes and projects it into the target provider;
3. resumes through the real headless Claude or Codex package;
4. submits a read-only diagnostic prompt;
5. requires a committed assistant response with a unique marker;
6. reports capacity strategy, projection changes, and provider diagnostics.

Large-corpus review must inspect the meaning of the response, not only the exit
code. The Claude placeholder bug and the fake Codex compaction bug both produced
syntactically valid sessions and successful model turns whose answers revealed
that the actual work context had been lost.

The quota-independent outcomes need the same treatment and **have not had it
yet**. Structural tests prove that Claude and Codex accept a cleared tool result
and a synthetic drop marker; nothing yet proves that a live Codex tolerates a
`custom_tool_call_output` whose output is a placeholder rather than treating it
as an error, that a shrunk projection's real token count matches the 2.5
characters-per-token estimate closely enough to stay under Codex's 90 % auto-
compact limit, or that Claude's resume dialog appears on a freshly projected
transcript. Until a `raw` and a `shrunk` probe run against real sessions, those
are open questions, and the ladder's `keepRecentTurns` and `maxInputChars`
defaults remain placeholders.

OpenCode currently adds a separate isolated CLI contract probe: import the
projected envelope into temporary XDG state, export the resulting `ses_…`, and
decode it again. This proves native schema/load compatibility without reading
or mutating personal OpenCode storage. A paid semantic follow-up turn remains a
stronger optional validation, just as it is for the two file-backed providers.

## Warning

Do not unify Claude, Codex, and OpenCode compaction behind a shared wire shape.
They share a planning concept, not persistence semantics. Never copy encrypted
provider payloads across providers, never treat Claude's boundary placeholder
as its summary, never accept a rate-limit message as a summary, never project a
provider's API-error record as assistant text, never invent an OpenCode
compaction record, and never make truncation an implicit recovery path. Any
change to these rules requires both structural tests and a real semantic resume
probe.

No fallback silently truncates. The shrink ladder is not a counter-example: it
runs only on the explicit `allowSourceTurns: false` plan, only when nothing else
fits, and every rung reports what it removed all the way out to a strategy label
and a toast line. The moment a lossy step stops being reported, it has become
the silent truncation this document forbids.

Do not let the ladder learn a provider name, and do not let a host or a
projector learn how to size a conversation. Sizing policy has one home
(`operations/shrink.ts`, one consumer) and target-shaped knowledge has one home
above it (`planConversationContext`). The single exception — the planner's
`targetProvider !== 'claude'` developer-message decision — is documented under
"Provider knowledge" with the projector behaviour that forced it; a second such
exception is the signal to build the capability flag rather than to add another
string comparison.

Do not turn the exhaustion signal into a gate. It picks defaults in a modal the
user can override, and nothing inside the transaction may branch on it.
