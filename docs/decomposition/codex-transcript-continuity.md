# Codex Transcript Continuity

> **Status:** Approved by the user on 2026-08-30. Stage 0 is in progress.
>
> **Primary issues:** #339 (submitted prompts lose visible ownership), #96
> (Resume and conversation search disagree), #151 (known prompts are not
> findable), and #234 / `codex-headless` #16 (Codex 0.151.0 is newer than the
> attested prompt-input profile).
>
> **Incident source:**
> `~/.config/agent-code/debug-bundles/manual/2026-08-30T17-20-50-241-d00b4e7c`
>
> **Review provenance:** three independent repository-analysis agents and six
> fresh Agent Code MCP orchestration agents reviewed the evidence, source, and
> first draft. All six MCP reviewers returned `RED` on the first draft. This
> revision incorporates their evidence-backed blockers: default proxy-off
> behavior, divergent duplicate rollouts, prompt ordering, app-server coverage
> and side effects, existing fixture infrastructure, and provider blast radius.
> All six returned `GO` on the narrow second pass. A final line-level audit then
> caught a durable-key mismatch and mixed evidence-count units; those corrections,
> plus transport availability, prompt-store retention, and the shared OpenCode
> queue seam, are incorporated below.

## Executive summary

The user's Codex history is not gone, and the prompt shown as “queued for
delivery” was not waiting to be delivered.

The recorded Codex 0.151.0 session had a healthy, still-growing native rollout
containing the missing user prompts and assistant turns. Agent Code rendered
zero committed entries because fresh-session ownership depended on an exact
0.149.1 prompt-input profile. The 0.151.0 profile refusal was then sent through
the fatal `jsonl-error` channel, producing “transcript unavailable.” This is a
capability mismatch, not an authentication, model, terminal, or native-history
failure.

Agent Code also observed a stronger identity in the incident:
the UUID component before `:` in `x-codex-window-id` on each main `/responses`
request exactly equaled the rollout's `session_meta.payload.id`. The adapter
records but does not consume that header. However, the header is currently
available only when the Codex
Responses proxy is enabled, while `useProxyStreaming` defaults off and is
presented as a Claude-oriented experimental option. A real fix therefore must
separate minimal Codex identity observation from semantic proxy streaming; a
header-only fix behind today's toggle would leave the default path broken.

A second independent bug makes the prompt itself disappear. A renderer guard
from PR #252 parks some Codex submissions in `queuedMessages` as
`unowned-history`. The incident shows main accepting the PTY write, Codex
committing and echoing the prompt, and Responses traffic starting while the UI
still says “queued for delivery.” The recorded deletion came from PR #252's
`process_state` idle edge, not PR #304's later sweep backstop. Five sites can
empty `queuedMessages`, and a sixth committed-row filter can remove matching
items. The prompt has no durable visible owner when the committed tail is
detached, so the assistant appears to answer from nowhere.

Removing only that guard is also unsafe: a prompt submitted during an active
semantic turn can jump above that turn after it moves from current work to
completed history. The fix must model submitted-prompt lifecycle and ordering,
not delete one conditional.

Resume has a third source-of-truth problem. The main Resume surface requests 20
sessions and searches only those 20; a second path-picker repeats the same cap.
The exact-checkout inventory contains more than 300 interactive sessions, plus
hundreds of exec and subagent rollouts. Codex app-server pagination is useful,
but it is not a complete source: live evidence shows recent rollouts without
`event_msg.user_message` can be absent, overlapping pages can repeat IDs, and
the app-server implementation may repair or prune provider-owned index state
while listing. Raw files are therefore not an exceptional fallback. The
catalog must reconcile provider metadata with the durable file inventory and
must prove that browsing does not mutate the user's native Codex history.

Finally, duplicate provider IDs are not harmless copies. Recorded legacy pairs
with the same ID diverge in content, so “one ID = one row” would silently hide
history. The correct invariant is one provider ID = at most one resume target,
while every divergent physical recording remains reachable and previewable.

This decomposition replaces those failed substrates. It does not add a Codex
0.151.0 version conditional.

## 1. A and D

### A — what exists and is trusted

| Artifact | Location | Trusted fact |
|---|---|---|
| Submitted-prompt incident | supplied bundle `incident-events.jsonl`, `feed-debug.jsonl`, `state-snapshot.json`, screen/tail samples, its referenced proxy run, and the durable per-session feed log at `~/.config/agent-code/feed-debug/d00b4e7c-c146-436d-8d3b-fee3a3a5b572.jsonl` | The bundle contains only the renderer's deliberate 500-row snapshot, but the durable per-session log still contains the earlier evidence: 16,155 rows at the Stage 0 inspection, including eight submits, one direct optimistic row, seven queue parks across both queue reasons, and three recorded idle clears. The app-run incident journal already carries `ids.sessionId`; the missing join is submission identity. |
| Native committed transcript | `~/.codex/sessions/2026/08/30/rollout-2026-08-30T10-11-55-01a053a8-0611-7711-9ca3-f69f130764ab.jsonl` | Codex 0.151.0 created and appended the file. `session_meta.payload.id` is `01a053a8-0611-7711-9ca3-f69f130764ab`, and the file contains prompts missing from Agent Code's committed feed. It is mutable; Stage 1 must snapshot, byte-count, and hash it before fixture extraction. |
| Provider-issued incident identity | bundle plus referenced proxy run | Main `/responses` requests carry `x-codex-window-id: 01a053a8-0611-7711-9ca3-f69f130764ab:0`; the UUID component before `:` exactly equals `session_meta.payload.id`. Header generation and rollout-internal `context_window.window_id` are different identity spaces. |
| Saved identity observations | debug-bundle and proxy recordings across Codex 0.132.0, 0.144.3, 0.149.1, and 0.151.0 | The header-to-`payload.id` relation is strongly supported, including generations 0–19. Measured consistently as distinct observed `x-codex-window-id` UUID components, the uneven distribution is 0.132.0 ×14, 0.144.3 ×1, 0.149.1 ×1, and 0.151.0 ×10. Nine of the ten 0.151.0 UUIDs come from six proxy runs in one worktree/session family, not independent environments, so count is not broad version attestation. At least one recorded legacy provider ID resolves to two divergent files, so provider ID alone is not always a physical-path authority. Presence of `x-openai-subagent` disqualifies a child flow; absence of a parent header does not prove a root flow. |
| Process/file observation | live read-only macOS inspection on 2026-08-30 | The spawned Codex PID held one current rollout open and its `payload.id` matched the live header. This is a hypothesis for a proxy-free positive edge, not a cross-platform contract and never negative evidence when absent. |
| Pinned upstream reference | `vendor/codex-src` at `8035cb03` dated 2026-04-10 | The pin documents older header/generation behavior only. It is about 4.5 months older than installed Codex 0.151.0 and is not trusted as proof of 0.151.0 resume/fork/compaction semantics. |
| Fail-closed ownership graph | `packages/codex-headless/src/transcript/FreshRolloutOwnershipCoordinator.ts` and its gate suites | CWD and timing are not identity; a physical path may be leased to at most one participant. The current coordinator accepts prompt evidence, not provider-ID evidence, so Stage 6 must extend the authority rather than bypass it. |
| Exact 0.149.1 input capability | `packages/codex-headless/src/transcript/prompt-input/` | The profile proves the exact Enter/Tab composer contract for 0.149.1. It proves neither that every newer CLI is unsafe nor that keymap evidence should own provider-thread identity. |
| Existing nonfatal diagnostic path | `transcript-diagnostic` / `rollout-diagnostic` from Codex session through recorder/forwarder | The app already has a channel intentionally used for rollout capability diagnostics that must not make healthy sessions look fatal. |
| Existing prompt state and render machinery | `PromptDeliveryUiState`, `src/renderer/src/rendering/`, `queueInvariants.ts`, `deadCommittedChannel159`, `queueHandoff`, and `fixtures.buriedPrompt239.test.ts` | Sending/uncertain state and optimistic-to-committed ownership already exist in pieces. `buriedPrompt239` is a useful hand-authored control, not a recorded fixture. The complete lifecycle still has multiple writers and no durable local owner across reload. |
| Existing real fixture infrastructure | `testing/fixtures/rendering-bundles`, `rendering-recordings`, `queue-operations`, their catalogs, and extraction/triage scripts | The repo already has real bundle/recording replay with captured `visible_rows` and queue evidence. New corpora must extend these pipelines rather than create parallel fixture machinery. |
| Existing human-turn projection | `src/providers/codex/renderer/transcript/rollout.ts` | Marker-based filtering drops the incident's leading injected role-user record and keeps its human prompts. There is no reliable positive structural discriminator in the 0.151.0 fallback shape, so this behavior must be shared and carry degraded provenance rather than be independently reimplemented. |
| Local inventory snapshot | `~/.codex/sessions`, captured during this investigation | The moving corpus was about 1,743 files / 1,726 distinct IDs / 4.0 GB decimal (3.7 GiB), with a largest file about 147.7 MiB, more than 300 exact-cwd interactive rollouts, hundreds of exec/subagent rollouts, and divergent duplicate-ID groups. Stage 1 must freeze exact counts and methods. |
| Official catalog capability | installed Codex 0.151.0 `app-server` `thread/list` / `thread/read` | The API supports cursor pagination and useful provider metadata. A live exact-cwd probe returned 289 row occurrences / 288 unique IDs and one cross-page duplicate, but it omitted recent raw interactive threads and cannot be treated as a complete inventory or an automatically read-only operation. |

The following are explicitly **not** trusted as authorities:

- `queuedMessages`, because it conflates local write state, provider queueing,
  local visibility, and committed reconciliation;
- `promptDelivery: idle` as evidence that a prompt has another visible owner;
- an `ok: true` PTY write as proof of provider acceptance or execution;
- a same-thread proxy request as proof that one specific prompt caused it;
- CWD, recency, file size, line count, or filename timestamp as identity;
- request header and request-body IDs as independent sources; they are one
  transport observation;
- rollout `session_id`, `forked_from_id`, `parent_thread_id`,
  `context_window.window_id`, `first_window_id`, or `previous_window_id` as a
  substitute for `session_meta.payload.id`;
- the exact CLI version check as general rollout identity;
- `SessionList.ts`'s first role-user record as a human prompt;
- app-server `thread/list` as complete existence inventory or side-effect-free
  browsing;
- either current app-local filesystem walker as a canonical catalog;
- filename wall-clock text as an absolute timestamp.

### D — observable end state

1. A default-config fresh Codex session obtains a privacy-bounded provider
   identity independently of the Claude semantic-proxy toggle. Explicit opt-out
   or unsupported platforms degrade safely; the pane still preserves local
   user prompts and never claims a committed tail exists.
2. Concurrent same-CWD sessions, subagents, compaction windows, resumes, forks,
   repeated prompts, and duplicate rollout generations cannot cross-wire. Weak
   or contradictory evidence fails closed.
3. `unsupported-cli` is always a nonfatal prompt-input capability diagnostic,
   never a JSONL I/O error. The UI explains whether committed attachment is
   pending, unavailable, conflicted, or failed and offers a meaningful retry or
   an explicit “no automatic recovery available” action.
4. Late exact identity can attach the correct rollout without relaunch. History
   is replayed from a stable snapshot boundary in bounded, incremental chunks;
   progress is visible, memory is bounded, active appends are not lost, and
   first paint does not wait for a multi-megabyte archive.
5. Every app-originated submission has exactly one visible surface owner from
   submit onward. The Feed owns the local row with `sending`, `uncertain`, or
   `submitted` status. QueueStrip is reserved for independently proven
   provider-owned future-turn queueing; a lifecycle record may never project to
   both surfaces.
6. Local write, provider queue/observation, committed-row observation,
   attachment/tail state, and render selection remain separate facts. Producers
   emit observations; idle, semantic completion, bootstrap, exit, or missing
   committed history cannot mutate ownership directly.
7. All user-facing queue surfaces—the lane count, “unconfirmed” count, ARIA
   label, delivering text, stale text, and dialog—describe the same proven
   state. `promptDelivery: idle` cannot coexist with “queued for delivery.”
8. A committed Codex row atomically replaces its matching local row without a
   duplicate or jump. A prompt submitted during an already-live semantic turn
   remains after that turn when it completes. Repeated identical prompts remain
   distinct by submission identity.
9. Before-write failure unwinds exactly one submission. Partial/uncertain write
   retains exactly one visible row with recovery guidance. Renderer/app reload
   cannot erase accepted or uncertain local submissions.
10. Resume, preview, exact lookup, `listAllSessions`, and search consume one
    canonical catalog that reconciles durable file existence with provider
    metadata. No browse operation silently mutates provider-owned Codex state.
11. One provider thread ID has at most one approved resume target, but every
    divergent physical recording remains individually reachable, labeled, and
    previewable. No recency/size heuristic silently discards history.
12. Resume and path picking are paginated/searchable beyond 20. Exact checkout,
    logical repository/worktree family, all projects, background/subagents, and
    archived history are explicit scopes. The selected thread's validated
    resume CWD is used, with origin/latest/resume CWD provenance retained.
13. Session labels exclude injected `AGENTS.md`, developer,
    `<environment_context>`, and subagent-notification content. The projection
    reuses one provider-aware implementation and exposes whether provenance is
    provider-verified or marker-derived.
14. Prompt Search does not full-read the global multi-gigabyte corpus per query,
    does not retain unbounded raw prompt bodies, and does not collide physical
    recording variants under one provider-ID cache key.

## 2. Root causes established before implementation

### 2.1 Prompt-input capability is incorrectly acting as thread identity

`CodexSession.preparePromptInputProfile()` attests the installed binary against
the exact 0.149.1 composer/keymap contract. Codex 0.151.0 returns
`unsupported-cli`. The terminal continues, but `PromptInputEvidence` produces no
fresh ownership edge, so no rollout lease or native tail is created. The refusal
is emitted through `jsonl-error`, which the renderer turns into
`transcriptStatus: error` and “transcript unavailable.” The bundle records
`totalEntries: 0` and `lastJsonlEntryAt: null` despite healthy native output.

This is correct fail-closed behavior for unverified keymap evidence and the
wrong system boundary for provider-thread identity. The incident's main
Responses requests already expose the rollout's `session_meta.payload.id` via
`x-codex-window-id`. The current adapter labels it forensic-only.

The first draft missed a deployment blocker: `ResponsesProxy.create()` is
gated by `useProxyStreaming`, which defaults false and is described as an
experimental Claude/mitmproxy feature. Consuming the header without separating
minimal Codex identity observation would not fix a default-config user.

Identity matching must also be exact. The header UUID matches
`session_meta.payload.id`, not similarly named rollout window/lineage fields.
Child traffic with `x-openai-subagent` must be excluded. A provider UUID that
matches multiple eligible physical files is a conflict unless an independent
exact-path observation reduces the set to one.

### 2.2 Prompt delivery and visible ownership are six competing mutation paths

The third fully correlated prompt demonstrates the failure:

| Time (UTC) | Observation |
|---|---|
| 17:19:22.535 | app-wide submit journal records begin |
| 17:19:22.537 | renderer parks the prompt in `queuedMessages` as `unowned-history` |
| 17:19:22.552 | main reports PTY write `ok: true`—local write completion only |
| 17:19:22.584 | native rollout contains the user item |
| 17:19:22.659 | screen shows the prompt |
| after 17:19:22 | same-session Responses traffic and assistant work continue |
| 17:19:39.438 | `process_state` idle clears one queued item |

The fourth prompt is natively committed but still says “queued for delivery” at
capture. The bundle's 500-row snapshot omitted earlier evidence, but the durable
per-session feed log retains it: prompt 1 took the direct optimistic-entry path;
prompt 2 was parked as `live-current-turn`; prompts 3 and 4 were parked as
`unowned-history`; and three idle clears are present. Later submissions in the
same file also supply non-erased controls for both queue-reason branches. Stage
1 must freeze the file at a byte boundary because it remains live and its
128 MiB cap has begun dropping tail records.

The causal deletion is the `process_state` edge clear added with PR #252 / commit
`b0050cde`, not PR #304's later timer backstop. Current queue removal can occur
from process state, semantic state, bootstrap completion, a timer sweep, process
exit, and JSONL text-match filtering. The composer catch path also removes an
optimistic row before it knows whether nothing or only part of the input was
written. Add and remove paths are asymmetric, and three equality-based sites
collapse repeated identical prompts.

`PromptDeliveryUiState`, optimistic ledger candidates, committed ownership, and
`providerReportsPendingQueue` already implement parts of the required model, but
they are not one authority and are not durable across renderer reload.

### 2.3 Removing the stale queue guard alone can reorder history

The `unowned-history` guard was written for Feed's former fixed planes. The
unified chronological ledger landed one day later. The hand-authored
`fixtures.buriedPrompt239.test.ts` proves only the benign ordering where a
completed turn ends before the next submit.

For a prompt submitted at T1 during a live turn spanning T0–T2, current semantic
work sorts at T0 while live, then at T2 when it becomes history. A local prompt
at T1 can therefore appear after the live work and jump above it at completion.
The production migration needs an explicit invariant: a submitted prompt may
not sort before a semantic turn that was already live when the prompt was
submitted.

### 2.4 Resume and search truncate, disagree, and retain too much

`CommandPalette.tsx` and `PathPickerModal.tsx` request 20 sessions and search
only those 20. The Codex lister walks files, sorts by mtime, filters exact initial
CWD, mixes source kinds, does not deduplicate, and stops at the limit. Querying
cannot discover row 21. The exact-CWD restriction prevents Codex's wrong-CWD
confirmation from swallowing a prompt, but it is a resume-safety rule, not a
complete browse scope.

`src/main/sessionIndex.ts` is a separate Prompt Search implementation. Cold
search discovers and full-reads global Codex rollouts before scoped rejection,
caps results, and stores raw prompt bodies in an unbounded module-level Map keyed
too coarsely for duplicate physical recordings.

### 2.5 Official app-server metadata is useful but not a complete read-only catalog

A live probe returned 289 exact-cwd interactive row occurrences / 288 unique
IDs, far more than Agent Code's 20. It is still not a superset of recent durable
history. The incident and most sampled recent 0.147+ rollouts contain real
role-user items but no `event_msg.user_message`; the official list/title
extraction path depends on that older event shape. Overlapping pages can repeat
IDs, default model-provider filters can hide history, CWD filtering happens
after internal paging, `path` is optional/unstable, archive is a query dimension,
and official `searchTerm` is not deep prompt search.

The app-server list path may also repair stale rollout paths or delete index rows
whose files are missing. “Read-only live probe” described our intent, not a
proven no-mutation contract. Browsing must not change the user's native resume
inventory, so Stage 8 measures and gates the transport before any UI depends on
it.

### 2.6 Duplicate IDs and injected first-user records are data-model problems

Recorded legacy duplicate-ID pairs share provider ID, metadata timestamp, and
CWD but contain divergent histories. Listing both is closer to correct than
silently canonicalizing either. Resume still needs one validated provider target
or a conflict, while preview must preserve all recordings.

On Codex 0.151.0 the incident has zero `event_msg.user_message` rows. The first
role-user record is entirely injected—a leading untagged AGENTS payload plus
`<environment_context>`—and the human prompt is a later record. The existing
renderer marker predicate handles the recorded shape; `SessionList.ts` and
`sessionIndex.ts` independently do not. Human-turn projection must be shared,
not re-created inside the catalog.

## 3. Proposed policy decisions

Approval accepts these defaults unless the user changes one explicitly. Stage
2 converts them into real-fixture expectations before production behavior
changes.

1. **Default Codex identity path:** split privacy-bounded Codex identity
   observation from semantic proxy streaming. Enable the metadata-only identity
   path by default for Codex; its default mode must not persist request bodies,
   `body_b64`, or semantic request shapes. An explicit identity opt-out remains
   respected and degrades to approved process evidence or safe hold. Identity
   transport startup failure, port conflict, main restart, or mid-session loss
   must leave Codex model traffic on—or restore it to—direct upstream, emit a
   capability diagnostic, and hold attachment safely; it must never fail session
   start or interrupt an otherwise healthy Codex turn. A transport that cannot
   prove this fail-open contract is not eligible to become the default path.
2. **Exact identity authority:** admit only a parsed main `/responses` header UUID
   matched to `session_meta.payload.id`, exact resume authority, or a separately
   approved exact process-owned path. Header/body repetition is one source.
   `x-openai-subagent` presence disqualifies the request. CWD is a safety filter,
   not identity.
3. **Atomic lease authority:** identity evidence is added inside the existing
   ownership coordinator. That authority installs the irreversible physical
   lease before emitting `FreshRolloutLease`; no adapter or `CodexHeadless`
   consumer receives a selected path and asks for a lease later.
4. **Visible prompt ownership:** for Codex, the Feed owns one local row
   immediately. QueueStrip is only for proven provider-owned future-turn
   queueing. Surface handoff is atomic and mutually exclusive; idle is never
   deletion evidence. Shared renderer call sites choose their projection through
   provider capabilities: Claude and OpenCode keep their recorded existing queue
   policy behind that seam until their own replacement is approved.
5. **Separate lifecycle facts:** local-write `pending/accepted/rejected/uncertain`,
   provider queue/observation, committed-row observation, attachment/tail, and
   render owner are separate. `ok: true` clears only local-write pending.
6. **Durability and retention:** submission lifecycle records live in
   `src/shared/` and main persists them under
   `STATE_DIR/prompt-lifecycle/<sessionId>.json` with directory mode `0700` and
   file mode `0600`, because current renderer-only queue/optimistic state cannot
   survive app reload. The key is the durable Agent Code `SessionId`; each event
   carries its launch-scoped session-run ID as a field. The renderer owns
   projection, not durable truth.
   The store contains only prompt/render content and lifecycle fields needed to
   recover unresolved local rows—never auth, proxy bodies, or raw image bytes.
   A record is deleted after durable committed-row handoff; an explicit Agent
   Code session deletion removes its file, while renderer reload, app restart,
   temporary process exit, and ordinary detach do not. Abandoned files no longer
   referenced by workspace/session state have 14-day retention. The initial hard
   ceilings are 512 unresolved records or 16 MiB UTF-8 per session and 256 MiB
   globally, subject to the Stage 2B evidence gate; exceeding a ceiling may not
   silently evict an unresolved row or claim a PTY submission is durable. Debug
   bundles include lifecycle state, counts, and content hashes by default; raw
   prompt text requires an explicit user-authorized private capture.
7. **Compatibility:** retain the exact 0.149.1 input profile as optional
   keymap-dependent fallback evidence. Never widen it from source inspection
   alone. `unsupported-cli` always uses the existing nonfatal diagnostic path.
8. **Late replay:** read a stable file generation from offset zero in bounded,
   incremental chunks, then bridge to active appends without gaps. Exact ID may
   bypass prompt-prefix-size exhaustion, but never integrity/generation
   quarantine.
9. **Catalog authority:** durable file inventory is authoritative for existence;
   provider APIs are authoritative only for fields whose coverage and side
   effects are recorded. The canonical catalog is always a reconciler, never an
   app-server-primary/fallback-files design.
10. **No browse mutation:** a catalog browse may not silently repair, delete, or
    rewrite provider-owned state. A mutating app-server method must be isolated
    safely or excluded from browsing.
11. **Duplicate preservation:** one provider ID has at most one resume target,
    but every divergent physical recording stays separately previewable. An
    unresolved conflict disables only resume, never history access.
12. **Resume scopes:** default to `This checkout`, with explicit `This repository`
    and `All`. Repository scope is app-derived from Git/worktree relationships.
    Resume uses the catalog-selected valid CWD while retaining origin/latest CWD
    provenance.
13. **Default sources and archives:** interactive roots first; background exec,
    subagents, and archived sessions remain explicit filters. OpenCode never
    falls back silently to Claude sessions.
14. **Labels:** explicit provider name/title, then provider-verified human
    preview, then shared marker-derived human preview, then short provider ID.
    If no human provenance is trustworthy, use the ID; never promote injected
    text.
15. **Fixture privacy:** always-on observations are content-safe. Private
   extractors may transform real prompt bytes before production normalization
   so whitespace/Unicode equivalence is preserved without committing personal
   text. Sanitization never normalizes first and then tests that same result.
   This governs new additions; existing fixtures and their captured
   `visible_rows` ground truth are not retro-redacted or rewritten.
16. **Deleted worktrees:** keep history discoverable, but never invent a resume
    directory. Offer preview or an explicit user-selected valid replacement CWD.

## 4. Intermediate stages

### Stage 0 — record the complete decision chain without changing behavior

- [ ] **Produces:** a versioned, session-scoped
  `codex-transcript-observations` stream in recordings/debug bundles. It extends
  the existing `pasteId`/delivery identity across renderer, IPC, local write,
  queue/entry candidates, and render selection. Separate identifiers represent
  session run, submission, proxy request, semantic turn, rollout entry, and file
  generation; only explicit relations join them. Pre-lease runtime observations
  contain content-safe candidate/session-meta fingerprints only. Unleased native
  content may be correlated only by the offline private extractor.
- **Verified by:** a fresh capture can derive prompt chronology per session
  without raw text or cross-pane inference. It distinguishes local-write result,
  provider request/queue, committed-row observed, attachment/tail, and visible
  surface. It records both `_counts.entries` and `totalEntries` when they disagree.
  Runtime decisions remain byte-for-byte unchanged.
- **Why separate:** today's app-run journal already has `ids.sessionId` but no
  submission key, while its bounded bundle tail interleaves panes. The durable
  feed log is session-scoped but carries raw text and has no submission token.
  One imagined universal token would falsely imply prompt-to-request causality.
  Stage 0 therefore extends the existing lifecycle/incident and feed-debug
  substrates, then exports a session-filtered content-safe view; it does not
  create another runtime store or let diagnostics become a decider.
- **Reality check:** incident seq 81–92 interleaves four Codex and two Claude
  submits. The supplied bundle retained complete cross-channel evidence only for
  prompts 3/4, but the 128 MiB durable per-session feed log retains the earlier
  prompt 1/2 queue decisions plus later positive controls. The existing paste
  journal already supplies the usable submission UUID but is absent from every
  content-safe observation view.

### Stage 1 — freeze and extend the real fixture corpora

- [ ] **Produces:** immutable source snapshots plus deterministic extractors and
  catalogs for identity/attachment, prompt lifecycle/rendering, and session
  catalog/search. Extend `rendering-bundles`, `rendering-recordings`, and
  `queue-operations`; do not create parallel harnesses. Each fixture records
  source checksum/byte boundary, CLI version, extractor/sanitizer version,
  ordering/equality, source kind, frequency, and privacy transform. Missing live
  recordings listed in section 7 block Stage 1 completion.
- **Verified by:** structural signatures match private sources before and after
  sanitization; existing corpus audit/triage tools accept the additions; no
  fixture is a plausible hand-authored literal. Pre-normalization whitespace and
  Unicode relations survive sanitization. Current inventory/app-server probes
  are captured together so moving counts become a reproducible snapshot.
- **Why separate:** the three broken substrates have different evidence shapes.
  Reusing real pipelines makes regressions comparable with past incidents, while
  source freezing prevents a still-appending rollout from changing expected data.
- **Reality check:** available sources include the incident and its 339 MB proxy
  run, multi-version proxy bundles, parent/subagent and compaction observations,
  existing real rendering/queue corpora, divergent duplicate groups, deleted
  worktrees, and the raw rollout inventory. Busy queue, write-failure,
  proxy-disabled, reload, and exact 0.151 resume/fork recordings are missing.

### Stage 2A — write RED contracts from evidence already on disk

- [ ] **Produces:** human-readable outcome tables and failing fixture tests for
  identity strength/lease conflict, submitted-turn lifecycle/order, catalog
  reconciliation/duplicates/labels, and app-server coverage/side effects. Cases
  name their fixture and the evidence supporting `accept`, `hold`, `conflict`,
  `visible`, `replace`, `queued`, `preview-only`, or `disabled`.
- **Verified by:** current main fails on the recorded 0.151 attachment, false-fatal
  capability banner, two prompt erasures, false queue wording, row 21, injected
  label, and cross-consumer duplicate choice. Safety controls remain green.
  Mutation tests remove the sole direct identity source, create direct-source
  disagreement, restore one of two agreeing sources, reintroduce
  `unowned-history`, drop committed observation, and alter an indexed path.
- **Why separate:** implementation-written expectations only prove agreement with
  the implementation. Existing evidence can settle most semantics before
  missing queue/error recordings are collected.
- **Reality check:** identity fixtures cover exact header UUID plus generation,
  `payload.id` versus forbidden window/lineage IDs, subagent exclusion, duplicate
  provider IDs, first-observed generation >0, resume X→Y switching, and late
  identity during an active switch. Prompt fixtures cover detached visibility,
  repeated prompts, injected role-user records, and the T0<T1<T2 ordering trap.

### Stage 2B — finish missing recordings and approve the semantics

- [ ] **Produces:** real fixtures and RED table rows for genuine Codex 0.151
  busy/Tab queueing, before-write failure, uncertain partial write, default
  proxy-disabled fresh identity, renderer/app reload before attachment, exact
  resume/fork, and supported-platform process/open-file evidence. It ends with a
  signed-off outcome-table revision recorded in this decomposition.
- **Verified by:** every policy in section 3 has at least one positive and one
  negative real case; a genuine provider queue is representable without sharing
  a surface with the local Feed row; reload proves the main persistence boundary;
  platform gaps are explicit safe holds. The user explicitly approves the
  outcome tables before Stage 3.
- **Why separate:** queue and error semantics cannot be invented from the current
  incident. Keeping this gate distinct prevents imagined fixtures from blocking
  all existing-evidence contracts or being silently filled in later.
- **Reality check:** these recordings do not currently exist in sufficient form.
  The staged-decomposition method requires collecting them, not manufacturing
  equivalent-looking literals.

### Stage 3 — make capability reporting truthful and nonfatal

- [ ] **Produces:** `unsupported-cli` and other prompt-input-profile refusals
  travel through the existing typed transcript/rollout diagnostic path across
  Codex session, SessionManager, forwarder, preload, and renderer. JSONL error is
  reserved for actual committed-tail I/O/parsing failure. The readiness surface
  exposes pending/held/conflict/error separately with retry or explicit no-action
  guidance.
- **Verified by:** the incident capability refusal no longer produces
  “transcript unavailable”; an injected real JSONL failure still does; detached
  committed history remains truthfully unattached; prompt visibility is unchanged
  in this stage.
- **Why separate:** correcting a false fatal banner is independent of proving a
  new identity source. Deferring it behind identity would preserve a known lie
  and conflate diagnostic plumbing with lease authority.
- **Reality check:** the repo already contains a nonfatal diagnostic channel with
  a WHY comment that healthy sibling rollout conditions must not look fatal.

### Stage 4 — isolate and persist submitted-prompt lifecycle

- [ ] **Produces:** `src/shared/prompt-lifecycle/` plus a main-owned event store
  keyed by durable Agent Code `SessionId`, with session-run ID retained inside
  each record. It implements policy 6's path, permissions, privacy, deletion,
  14-day abandonment, and byte/entry ceilings. The reducer subsumes/wraps
  existing `PromptDeliveryUiState`, optimistic ledger candidates, and
  `providerReportsPendingQueue`; it does not create another authority. Producers
  emit observations. It emits one mutually exclusive Feed-or-Queue projection
  and one selected render owner.
- **Verified by:** Stage 2 lifecycle contracts pass without React. Multiple
  detached prompts survive idle, semantic completion, bootstrap, exit, renderer
  reload, and session exit; one before-write failure unwinds one token; uncertain
  write persists; duplicate/out-of-order observations are idempotent; repeated
  identical/image-only prompts remain separate; an external/resumed committed
  user turn needs no local token. Reconciled/session-deleted/abandoned records
  prune at the specified boundary; active unresolved records never disappear at
  a ceiling, and a ceiling refusal is visible before the PTY write is claimed
  durable. Default debug-bundle export contains no raw prompt body.
- **Why separate:** ownership is currently spread across composer catch paths,
  queue add/remove asymmetry, six queue-clearing sites, semantic/process IPC,
  committed ingest, delivery UI state, and Feed. A conditional at one site cannot
  represent detached durable ownership or reload.
- **Reality check:** the incident demonstrates `promptDelivery: idle` with one
  visible queued item and zero committed entries. Current autosave persists only
  draft input, proving renderer-only lifecycle state cannot meet D9.

### Stage 5 — migrate Feed and QueueStrip without reordering prompts

- [ ] **Produces:** the Codex renderer integration that removes only the stale
  `unowned-history` decision after the lifecycle projection owns visibility,
  routes every queue-clearing/filter site through one provider-capability reducer
  seam, and enforces the “already-live turn stays before its mid-turn submit”
  ordering relation. Codex uses the new lifecycle projection. OpenCode's current
  `shouldClearIdleQueuedMessages` decision remains a legacy branch *behind* that
  seam until its own recorded replacement is approved; no call site adds a
  `provider === 'codex'` literal, and capability/branch contract tests prevent
  drift. All queue text/count/ARIA surfaces consume the selected projection.
  Claude's `claudeQueue` remains its provider-owned reconciler.
- **Verified by:** real bundle replay ends with every submitted prompt visible
  exactly once; T0<T1<T2 does not jump; local/committed twins hand off atomically;
  no `promptDelivery: idle`/queued wording contradiction remains. Claude queue
  add/dequeue/stale fixtures and OpenCode optimistic-echo idle fixtures remain
  green. Reintroducing `unowned-history` or any direct clear makes the incident
  fixture RED. Until Stage 7 attaches a committed tail, a detached 0.151 prompt
  remains one honest local Feed row with held/nonfatal attachment status; it
  never falls back to QueueStrip or disappears.
- **Why separate:** the pure model must be proven before React uses it. Removing
  the guard first would recreate #239's ordering defect and provider-blind queue
  changes could regress Claude/OpenCode.
- **Reality check:** `buriedPrompt239` remains a synthetic control; final order is
  grounded in `rendering-bundles` captured `visible_rows` plus the fresh Stage 1
  incident recording.

### Stage 6 — extend the coordinator with provider-thread identity

- [ ] **Produces:** `packages/codex-headless/src/transcript/identity/` as pure
  evidence normalization plus a new identity-keyed admission API inside
  `FreshRolloutOwnershipCoordinator`. The coordinator—not the adapter—intersects
  eligible candidates, validates CWD/session root/file generation, resolves exact
  evidence, installs the lease atomically, and emits `FreshRolloutLease`. Fresh,
  resume, fork, and compaction use explicit state machines rather than one generic
  conflict rule.
- **Verified by:** the full ownership gate suite plus new recorded gates cover
  header/file arrival order, late identity, UUID generations, subagents, identical
  prompts, competing exact-ID lease, duplicate provider ID, CWD mismatch, stale
  proxy generation, zero/one/many open files, resume X→active Y switch, fork, and
  compaction. Removing the sole direct source holds; removing one redundant
  agreeing source still accepts; disagreeing direct sources conflict; weak prompt
  mismatch cannot overrule an exact accepted identity.
- **Why separate:** identity reconciliation is the cross-wire boundary. Returning
  a path from a side resolver and leasing later creates a race and a second policy
  owner. The existing coordinator's irreversible lease invariant must remain the
  only authority.
- **Reality check:** current participant registration is prompt-keyed and the
  safety module/gates are large. `x-codex-window-id` is admitted only for root
  `/responses` traffic, exact `payload.id`, and the current proxy/session
  generation. Process observation is a positive edge only after canonical-root,
  process-epoch, fstat-generation, and session-meta validation; absence proves
  nothing.

### Stage 7 — attach with bounded replay on the default identity path

- [ ] **Produces:** a metadata-only Codex identity transport independent of the
  semantic-streaming setting, adapter integration into Stage 6, exact leased-tail
  attachment, and bounded snapshot-to-live replay. The path records capability,
  privacy, proxy transport, request endpoint, UUID/generation, and replay progress.
  Its default mode suppresses existing request-body/semantic capture and proves
  policy 1's fail-open availability contract before changing the Codex upstream
  route. Prompt-prefix size exhaustion does not block exact-ID validation;
  integrity or file-generation quarantine remains terminal.
- **Verified by:** default-config Codex 0.151 attaches the incident-equivalent
  rollout; opt-out with no approved process edge safely holds while local prompts
  remain visible; injected port bind, startup, upstream-connectivity, relay-death,
  and main-restart failures preserve healthy Codex traffic through direct
  upstream while attachment holds diagnostically; default captures contain no
  `body_b64`, request body, or semantic request shape. The 0.149.1 fallback
  remains safe; a multi-megabyte file replays incrementally from zero without
  blocking first paint or losing active appends; late identity during resume/fork
  switch preserves open-new-before-close-old and dedupe invariants. Header
  presence as well as agreement is live-gated.
- **Why separate:** a correct lease decision can still fail through missing
  transport, tail-at-EOF, watcher timing, 4 MiB candidate quarantine, unbounded
  bootstrap, or a false I/O status. Integration proves the complete committed
  channel after the authority is independently green.
- **Reality check:** the incident's header is currently visible only because the
  local Responses proxy handled HTTP traffic; WebSocket or future transport drift
  can remove it. Proxy-disabled/process evidence remains a recorded capability,
  not an assumed universal fallback.

### Stage 8 — establish catalog coverage, side effects, and transport bounds

- [ ] **Produces:** an inspectable catalog-behavior report and fixture corpus for
  the installed binary/config/Codex home: app-server lifecycle, initialization,
  request IDs, notifications, timeouts, restart/shutdown, cancellation,
  capability/version failure, row projection, model-provider filters, archive
  queries, pagination overlap/short pages, missing paths, and provider-state
  before/after measurements. It selects a safe process ownership model or
  excludes live app-server listing from browse.
- **Verified by:** same-snapshot app-server pages and durable inventory have an
  asserted coverage ratio; recent omitted threads are preserved; a full browse
  sweep leaves native resume-visible state unchanged; concurrent callers and
  restart/cancellation are bounded; unsupported method differs from temporary
  process failure; no wholesale provider wire object crosses IPC.
- **Why separate:** pagination working does not prove inventory completeness or
  side-effect-free browsing. Choosing app-server as primary before this artifact
  would encode a substrate already contradicted by recent rollouts.
- **Reality check:** recorded pages overlap, official unique rows trail raw
  interactive inventory, recent 0.147+ files often lack the required legacy user
  event, default provider filtering narrows results, and upstream implementation
  paths repair/prune native index rows.

### Stage 9 — isolate the canonical two-source Codex catalog

- [ ] **Produces:** `packages/codex-headless/src/session-catalog/`, reconciles a
  bounded durable-file inventory with only the safe provider metadata adapters
  approved by Stage 8, and emits one clean provider-neutral model. It includes
  provider ID, physical recording ID/generation, resume-target status, conflict,
  origin/latest/effective CWD, source/lineage, archive-query provenance,
  provider-selected optional path, timestamps, explicit name, human-preview
  provenance, history mode, ephemeral state, and capability status. Human-turn
  projection is shared with the existing renderer predicate.
- **Verified by:** every durable fixture is reachable; official-only metadata is
  enriched without deleting file-only recent history; divergent duplicates emit
  separate preview rows and at most one validated resume target; malformed,
  missing, active, large, legacy, paginated, and archived cases degrade
  observably; no private SQLite schema is imported.
- **Why separate:** existence, provider metadata, path generations, human-turn
  extraction, and source/scope are competing authorities. Leaving arbitration in
  UI consumers produced the current lister, locator, and search disagreements.
- **Reality check:** 33 CLI versions exist in the local corpus, so a fallback
  allowlist of four versions would hide most history. The durable inventory is a
  required source with provenance, not a temporary compatibility exception.

### Stage 10 — route lookup, preview, list, and resume preparation through the catalog

- [ ] **Produces:** a provider-neutral main catalog service used by
  `registry.main` list/listAll/resolveTranscriptPath, transcript path resolution,
  SessionManager preview/history, `RolloutLocator`, and resume preparation. It
  owns Git/worktree scope resolution and returns one selected resume CWD with
  origin/latest provenance. Independent path arbitration is removed after parity.
- **Verified by:** the same provider/recording identity, path, preview, and CWD
  appear in listing, listAll, exact lookup, initial history, and launch. An
  unresolved duplicate disables resume only, while all variants preview. Moved,
  deleted, symlinked, and related-worktree cases never launch under an invented
  path.
- **Why separate:** pagination UI cannot repair a lookup/resume identity mismatch.
  `sessionIndex.ts` is not on these paths and is deliberately deferred to Prompt
  Search rather than banned in the wrong stage.
- **Reality check:** `RolloutLocator` currently chooses newest mtime while the
  lister exposes duplicates and provider metadata may select another path. Stage
  10 retires that disagreement before any row becomes clickable.

### Stage 11 — replace every 20-row Resume/path snapshot

- [ ] **Produces:** Command Palette Resume and Path Picker use Stage 10 with
  cursor/incremental loading, overlapping-page dedupe, query restart/cancel,
  stable selection, explicit checkout/repository/all scope, source/archive
  filters, truthful counts, and selected CWD handling. OpenCode receives its own
  supported behavior or an explicit unavailable state, never Claude fallback.
- **Verified by:** a known interactive thread beyond 20 is findable/resumable;
  every unique catalog row is reachable despite overlapping or short pages with
  non-null cursors; additions/removals during paging and cursor invalidation do
  not duplicate keys or move selection; worktree/background/archive fixtures
  appear only in chosen scopes; query latency stays within the Stage 8 budget.
- **Why separate:** correct catalog identity must precede renderer pagination,
  but a correct backend remains unusable if both current clients still truncate
  before search.
- **Reality check:** both `CommandPalette.tsx` and `PathPickerModal.tsx`, plus a
  main IPC default, currently encode 20. The like-for-like failure is more than
  300 interactive sessions versus 20 shown, independent of background history.

### Stage 12 — choose Prompt Search architecture from recorded benchmarks

- [ ] **Produces:** a benchmark artifact and approved search design. It measures
  current cold scoped/global I/O, wall time, peak RSS, retained cache size,
  app-server title-only search coverage, bounded `thread/read`, active append,
  deletion/archive, and large-thread behavior. It chooses and documents either a
  persistent incremental human-turn index or another design that proves deep
  old-prompt reachability with bounded query cost.
- **Verified by:** the chosen design can find recorded prompts outside recent
  pages without eventually full-reading the whole corpus per query; schema,
  versioning, backfill cursor, revision key, crash recovery, invalidation,
  privacy, deletion/archive, and storage bounds are specified. The user approves
  this architecture before Stage 13.
- **Why separate:** lazy reads and a persistent index have materially different
  guarantees. Combining measurement and implementation would let the easier
  design silently weaken “find any old prompt.”
- **Reality check:** official `searchTerm` is not deep prompt search, current cold
  search can read gigabytes, one rollout is roughly 147.7 MiB, and the current raw
  prompt Map is unbounded.

### Stage 13 — implement the approved Prompt Search design

- [ ] **Produces:** Prompt Search consumes Stage 9 identity/human-turn projection
  and the Stage 12 index/query contract. The old global full-read path, false
  Codex-injection comment, unbounded prompt cache, and duplicate-ID collision are
  removed after parity. Queries are scoped, cancellable, and provenance-aware.
- **Verified by:** recorded old human prompts are findable; injected/developer
  text does not match as human input; physical variants cannot overwrite each
  other; active writes, archive/delete, rebuild, crash recovery, stale query
  cancellation, and bounded memory/I/O pass real fixtures and benchmarks.
- **Why separate:** implementation should execute an approved evidence-based
  search contract, not choose storage semantics while coding.
- **Reality check:** `sessionIndex.ts` is consumed by Prompt Search, not core
  resume lookup, and is retired here rather than in Stage 10.

### Stage 14 — run assembled gates and prepare reviewable PRs

- [ ] **Produces:** updated package/reference pins as needed, durable WHY comments,
  focused checks/builds, privacy-safe live recordings, and review-ready PRs
  linked to the primary issues. Work is split at real code boundaries: prompt
  lifecycle/UI, Codex identity/attachment, and catalog/resume/search may be
  separate dependent PRs after shared fixture contracts land. No PR is merged.
- **Verified by:** live matrices cover available 0.149.1/0.151.0 binaries,
  default identity and explicit opt-out, first/follow-up/busy prompts, concurrent
  same-CWD, identical prompts, compaction, resume/fork, subagents, reload,
  large-file late replay, all catalog scopes, duplicate variants, stale/missing
  paths, archive, pagination, and a prompt beyond recent pages. Selected provider
  ID, leased path generation, committed rows, visible owner, catalog row,
  preview, and resumed ID agree in one recording. Independent exact-head review
  returns no unresolved high-severity finding.
- **Why separate:** green isolated contracts do not prove packaged transports,
  real CLI headers, IPC ordering, renderer handoff, provider-state preservation,
  or page/search behavior. Release gates assemble without inventing policy.
- **Reality check:** the incident proves terminal and semantic success are
  insufficient. Stage 14 explicitly gates native identity, visible continuity,
  browse non-mutation, and catalog reachability.

## 5. Isolation boundaries

### 5.1 Provider-thread identity and lease authority

**Lives in:** evidence normalization under
`packages/codex-headless/src/transcript/identity/`; the existing ownership
coordinator remains the single decision/lease authority.

**Single consumer:** the Codex physical tail owner receives an already-installed
`FreshRolloutLease`, never an unleased selected path.

**Forbidden after migration:** renderer or proxy file selection; app-local
CWD/recency arbitration; body/header treated as quorum; negative inference from
missing open-file evidence; prefix matching; using rollout `session_id`,
lineage/window IDs, or subagent traffic as root identity; a second prompt matcher;
semantic activity treated as durable history.

### 5.2 Submitted-prompt lifecycle

**Lives in:** `src/shared/prompt-lifecycle/` with main-owned persistence and a
renderer Feed/Queue projector. It explicitly integrates the existing delivery
state, ledger ownership, and provider queue seam.

**Provider seam:** Claude's `claudeQueue` remains authoritative for Claude queue
departures. OpenCode's existing optimistic-echo cleanup is preserved until real
fixtures approve replacement. Shared `queuedMessages` is no longer a shared
policy owner.

**Forbidden after migration:** direct ownership mutation outside the
provider-capability seam by process state, semantic state, bootstrap, sweep,
exit, or committed text filter; deleting an accepted/uncertain prompt because
committed history is absent; two simultaneous visible surfaces; Feed
independently twinning rows; text-only identity for repeated/image prompts;
queue wording without an explicit provider-queue state.

### 5.3 Canonical session catalog and human-turn projection

**Lives in:** `packages/codex-headless/src/session-catalog/`, exposed through one
main service. App-server transport has one owner per effective binary,
`CODEX_HOME`, relevant config/profile, and provider set. Logical repository scope
lives in main because it owns Git/worktree discovery.

**Consumers:** list, listAll, exact lookup, preview/history, resume preparation,
Resume UI, Path Picker, and Prompt Search consume the clean model. Shared
human-turn projection is the only file-backed label/search classifier.

**Forbidden after migration:** renderer filesystem walking; duplicate discovery
or path arbitration in `sessionIndex.ts`/`RolloutLocator`; direct private SQLite
schema dependency; assuming provider list means durable existence; live catalog
browsing that mutates provider state; separate duplicate-ID rules; applying a
limit before later results are searchable; third-copy injected-text filtering.

## 6. Unknowns that require evidence, not conditionals

1. What exactly happens for a genuine Codex 0.151 busy/Tab submission: native
   commit, provider future queue, both, or neither?
2. What prompt/input shapes does 0.151 produce across Enter, Tab, paste, image,
   multiline, slash/file/mention popups, vim mode, Unicode, and history?
3. What privacy/behavior promise should an explicit Codex identity-observation
   opt-out make, and which recovery action should the UI offer afterward?
4. Can process-owned rollout evidence be implemented safely on macOS, Linux, and
   Windows across descendants, PID reuse, zero/one/many descriptors, resume X/Y,
   subagents, handle loss, rename/delete, and packaged permissions?
5. When can main `/responses` headers be absent, delayed, duplicated, malformed,
   oversized, renamed, or moved to WebSocket/realtime transports?
6. What are exact installed-0.151 resume, fork, compaction, and subagent header
   semantics? The stale vendor pin is a hypothesis, not evidence.
7. Can installed app-server catalog calls be isolated so they never repair/prune
   the user's live provider state? If not, which metadata path replaces them?
8. Which app-server fields/filter/search semantics drift across supported CLI
   versions, model providers, legacy/paginated history, and ephemeral threads?
9. How should repository scope handle active worktrees, moved/deleted paths,
   symlinks, and multiple exact-cwd page streams?
10. For a duplicate provider ID, what evidence validates one resume target, and
    when must all variants remain preview-only?
11. Which provider-injected role-user shapes occur across versions, resume/fork,
    skills, images, and developer instructions? Marker-derived fallback must
    remain honest about degraded provenance.
12. Should archived/deleted-CWD sessions be preview-only, explicitly rebound, or
    resumable after confirmation? The default is preview/choose, never guess.
13. Which persistent Prompt Search architecture meets deep reachability, privacy,
    storage, active-update, and bounded-query requirements?

## 7. Fixture plan

No production behavior changes until Stage 1 evidence exists, Stage 2 tests are
observed RED, and the Stage 2B outcome tables receive explicit human approval.
Failing tests derived from real evidence are retained and never weakened to make
implementation green.

### 7.1 Identity and attachment corpus

Use existing bundle/proxy sources for the incident and the uneven saved version
distribution. On the consistent unit of distinct observed `x-codex-window-id`
UUID components, it is 0.132.0 ×14, 0.144.3 ×1, 0.149.1 ×1, and 0.151.0 ×10.
Nine 0.151.0 UUIDs are concentrated in six proxy runs from one worktree/session
family, so they are not independent attestations. Include generations 0–19,
parent/subagent flows, compaction, shared `first_window_id` collisions, and
divergent duplicate provider IDs. A version represented by one UUID is a case,
not cross-version attestation. Snapshot the referenced full proxy run rather
than relying only on its truncated bundle copy.

Record new real cases for exact 0.151 resume/fork; two concurrent same-CWD fresh
sessions with distinct and identical prompts; default identity path and explicit
opt-out; late/missing/contradictory header; stale proxy generation; zero/one/many
process-open rollouts; and supported-platform process evidence. Include a
full-size over-prefix-cap file receiving identity late.

Sanitization preserves exact `payload.id` equality via fixture-local tokens,
header generation, arrival order, endpoint/method, subagent-header presence,
CWD equality, file generation, conflict, and lease result. It removes auth,
request bodies, absolute homes, raw prompt content, and unrelated transcript
content.

### 7.2 Submitted-turn lifecycle and rendering corpus

Freeze the durable per-session feed log and use its eight recorded submissions:
the supplied bundle remains the cross-channel source for prompts 3/4, while the
full log restores the prompt 1/2 queue decisions and supplies later erased and
non-erased controls for both `live-current-turn` and `unowned-history`. A fresh
recording is still required for missing write-failure, reload, proxy-disabled,
and exact 0.151 resume/fork cases, not to replace evidence that already exists.
Extend the existing rendering-bundle, rendering-recording, and queue-operation
catalogs. Keep `buriedPrompt239` only as a synthetic mutation/control test.

Record real healthy handoff, multi-prompt detached late attach, native rows before
submit result, semantic before screen, duplicated IPC, injected role-user before
human, tool-result/user-role before human, indefinite detach/session exit,
renderer/app reload, sub-second idle gaps, external/resumed user turns, true busy
provider queue, before-write failure, uncertain partial write, multiline/image/
slash/programmatic/voice sources, Unicode/whitespace variants, identical prompts,
stop/interrupt, and Claude/OpenCode control cases.

The sanitizer transforms real bytes before production normalization and
preserves code-point/whitespace relations and equality classes. Tests never
receive a post-normalized token that merely restates the expected result.

### 7.3 Session catalog and search corpus

Capture in one immutable snapshot: complete raw rollout inventory; current
filesystem projections; every app-server page with duplicates/cursors; selected
`thread/read`; provider-state counts/path-existence before and after a full
browse; source/version/history-mode/provider distributions; origin/latest CWD;
active/moved/deleted worktrees; symlink cases; archive queries; divergent
duplicates; provider-selected missing/stale/null paths; recent 0.147–0.151
file-only threads; legacy and paginated history; ephemeral/lineage cases; and
all injected/human shapes.

Include short page plus non-null cursor, cross-page duplicate, additions/removals
during pagination, model-provider filtering, archive transition, active partial
line, malformed/oversized metadata, very large rollouts, a row beyond page one,
and a prompt beyond recent limits. Benchmark current cold Prompt Search on the
snapshot with wall time, peak RSS, bytes read, and retained cache size.

New committed fixtures contain stable tokens, structural part types, counts,
size buckets, source/scope classes, and expected projection. They do not contain
auth, absolute home paths, private SQLite contents, or personal prompt bodies.
Existing fixtures and captured `visible_rows` are immutable ground truth for
prior incidents and are not retro-redacted or rewritten by this work.

## 8. Verification and stop rules

After approval, implement one stage at a time. Record each named artifact and
its independent verification before starting the next. Stage 2B and Stage 12
contain additional explicit human-approval gates.

Stop and revise this decomposition rather than patching forward if:

- a main header UUID fails to equal durable `session_meta.payload.id` in a real
  admitted request;
- a provider ID matches multiple eligible paths and the approved matrix cannot
  reduce it safely;
- a rollout-internal window/lineage ID is needed as identity;
- identity sources disagree in an unmodeled case;
- minimal default identity observation changes Codex behavior or violates its
  approved privacy boundary;
- identity transport startup or loss fails session start, interrupts model
  traffic, or cannot fall back to direct upstream plus a safe attachment hold;
- lifecycle persistence grows past its approved ceilings, exports raw prompt
  text by default, or silently evicts an unresolved submission;
- a real provider queue cannot be represented with exactly one visible surface;
- T0<T1<T2 ordering cannot remain stable without restoring a second owner;
- Claude or OpenCode controls regress;
- catalog browsing mutates provider-owned state;
- durable files disappear from catalog output because provider metadata omits
  them;
- duplicate physical history must be discarded to select a resume target;
- Prompt Search parity requires an unbounded per-query global full-read;
- a consumer must import raw reconciliation details from an isolated layer;
- a real fixture fails and the proposed response is to delete, weaken, or
  rewrite the fixture instead of revising the model.

Merging remains a separate explicit approval. No branch or PR may be merged
automatically.
