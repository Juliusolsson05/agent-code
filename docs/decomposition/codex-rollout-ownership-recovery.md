# Codex Fresh Rollout Ownership Recovery

> **Status:** Reopened after the tenth independent gate found five reachable
> causal-admission, transport-retention, capability, protocol, and launch-order
> regressions around the now-stable ownership graph. Stages 33–36 below must
> complete before any dependency or parent PR merges. The earlier gates remain
> recorded as evidence; no green CI run or live happy path overrides a RED
> exact-head review.
>
> **Incident:** Agent Code issue #632.
>
> **Observed boundary:** the local rollout corpus contains
> `event_msg.user_message` on Codex `0.145.0` and does not contain it on
> `0.147.0` or `0.149.0`. There is no local `0.146.x` capture, so the evidence
> establishes `(0.145.0, 0.147.0]`, not an imagined exact release.

## 1. A and D

### A — what exists and is trusted

| Artifact | Location | What is trusted |
|---|---|---|
| Codex's durable rollout | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Codex created and continuously appended the file for the active provider thread. It is the committed transcript source. |
| Prompt-delivery lifecycle | active incident/session recording, `submit.start` through `submit.result` | Four observed submits returned `ok: true` in 12–20 ms. This proves the Agent Code write path accepted the prompt; it does not by itself prove model processing. |
| Independent processing evidence | recorded terminal snapshots and semantic proxy events | The active capture contains `turn_started`, response deltas, tool calls, and completion after the submitted prompts. Together with the rollout, this proves Codex processed them. |
| Failed committed channel | session recording `17ee1e36-12ff-4d08-8470-f52de6b5f100` | Thousands of screen/semantic events and zero `session:jsonl-entries`. A second fresh `0.149.0` capture has the same shape. |
| Local prompt identity | `CodexHeadless.submittedPrompts` in `packages/codex-headless/src/CodexHeadless.ts` | A prompt observed at this particular PTY is admissible ownership evidence. CWD and file recency are not ownership evidence. |
| Cross-wire safety invariant | `decideFreshRolloutClaim` in `packages/codex-headless/src/transcript/FreshRolloutClaim.ts` | Multiple agents can start concurrently in the same CWD. Ambiguity must fail closed instead of assigning a sibling's transcript. |
| Existing recording substrate | `~/.config/agent-code/session-recordings`, `feed-debug`, and incident runs | The system already records delivery, screen, semantic, and committed channels. It does not yet record why a fresh rollout candidate was held or accepted. |

The current parser's **single-first-user-message representation is not
trusted**. It is the failed substrate. Its fallback chooses injected startup
context on the recorded `0.147.0` and `0.149.0` shapes.

### D — observable end state

1. A fresh top-level Codex session attaches its own rollout when the recorded
   rollout contains injected role-user bootstrap items before the actual prompt
   and contains no `event_msg.user_message`.
2. The committed channel emits `session:jsonl-entries`, transcript status leaves
   `disconnected`, and a prompt Codex processed no longer remains in QueueStrip.
3. Two concurrent fresh agents in the same CWD cannot claim one another's
   rollout, including when they submit identical normalized prompt text.
4. Resume/fork/subagent attachment continues to use its existing exact-id or
   lineage proof and does not regress.
5. Every fresh candidate decision is inspectable in a debug bundle without
   recording raw prompt or injected-instruction text in new diagnostics.
6. Fresh ownership has one process-wide source of truth per normalized Codex
   sessions root. A rollout path is leased atomically at most once, and a
   session never starts tailing before that shared owner has resolved it.

## 2. Root cause established before implementation

`parseFreshRolloutCandidate` currently stores only one
`normalizedFirstUserMessage`. It prefers the first
`event_msg.user_message`; when that event is absent it takes the first role-user
`response_item`. `decideFreshRolloutClaim` compares only that value with prompts
recorded from this PTY.

In the active Codex `0.149.0` rollout, the first role-user item contains injected
`AGENTS.md` instructions and the submitted prompt is a later role-user item. In
the captured `0.147.0` rollout, injected environment context comes first. Neither
version emits `event_msg.user_message`. The candidate therefore remains in the
`same-cwd candidates exist but none match` hold state forever. Because only an
accepted candidate calls `tailFile`, `CodexSession` has no `rollout-entry` to
forward as `jsonl-entry`, even while the terminal and proxy show a live turn.

The existing `RolloutOwnership.test.ts` helper manufactures an
`event_msg.user_message` fixture. That test validates an obsolete assumed wire
shape and cannot be used as evidence that current rollout ownership works.

## 3. Intermediate stages

### Stage 0 — record ownership decisions without changing them

- [x] **Produces:** a versioned, content-safe `rollout-ownership-decision`
  diagnostic record for every candidate evaluation. It records candidate file
  identity, Codex version when available, CWD-match result, counts and stable
  hashes of candidate/local normalized user texts, decision, reason, ambiguity
  cardinality, and whether tailing began. It records no new raw prompt text.
- **Verified by:** reproduce the current `0.149.0` incident and independently
  show a same-CWD candidate held because the chosen bootstrap item does not
  match, while the matching later role-user item is visible by hash/index. The
  session's attachment behavior must remain unchanged in this stage.
- **Why separate:** changing the claimant before the missing decision is
  observable would make a false attachment look like a successful fix. The
  recorder is also the only way to measure ambiguity frequency during real
  concurrent use.
- **Reality check:** the active session recording proves all surrounding
  channels are captured but contains no event explaining the claimant's hold.
  The fields above close that exact evidence gap.

### Stage 1 — build a recorded rollout-shape corpus and catalog

- [x] **Produces:** a deterministic sanitizer/extractor, committed sanitized
  fixtures, and a catalog with source CLI version, fresh/resume/subagent class,
  ordered user-entry shapes, ownership-decision result, source-recording ID,
  original SHA-256, and transformation version. Minimum source cases:
  `0.145.0` with `event_msg.user_message`; `0.147.0` with environment context
  first; two failed fresh `0.149.0` sessions with distinct injected context;
  one working resumed/subagent `0.149.0` session; and newly recorded concurrent
  same-CWD fresh sessions.
- **Verified by:** run the production parser over both each private source and
  its sanitized fixture and compare a structural signature: line types/order,
  user-item indices/counts, normalized equality relationships, CWD relation,
  thread metadata, and decision. The catalog must report frequencies, not only
  named examples.
- **Why separate:** a hand-written JSON literal would encode the same mistaken
  assumption as the current green test. Sanitization is separate from tests so
  privacy edits cannot silently alter the ownership-relevant structure.
- **Reality check:** the source corpus already shows the important shape change
  between `0.145.0` and `0.147.0`, and both failed fresh `0.149.0` recordings
  contain zero Agent Code rollout entries while their Codex rollout files grow.

### Stage 2 — state and approve ownership semantics as failing fixture tests

- [x] **Produces:** fixture-driven tests, written before the claimant change,
  that fail for the two recorded fresh `0.149.0` cases and stay green for legacy,
  resume, and cross-wire cases. An explicit outcome table in the fixture catalog
  records `accept`, `hold`, or `ambiguous` and the evidence that justifies it.
- **Verified by:** demonstrate the intended red tests against the unchanged
  claimant; review every expected ownership outcome against the source session
  rather than deriving expectations from the proposed code.
- **Why separate:** tests and implementation written from the same proposed
  algorithm would only prove self-consistency. This stage forces the ownership
  semantics—especially identical-prompt ambiguity—to be agreed before code can
  bless them.
- **Reality check:** the current imagined helper emits
  `event_msg.user_message`, while all captured `0.147.0` and `0.149.0` fresh
  failures omit it. The recorded fixtures replace that false confidence.

### Stage 3 — replace the single-message claimant inside the isolated layer

- [x] **Produces:** a claimant that represents all ownership-relevant user
  observations from the bounded candidate prefix and applies the Stage 2
  evidence table. It must retain exact local-prompt proof, same-CWD filtering,
  and fail-closed ambiguity; it must not classify bootstrap text by English
  prefixes such as `# AGENTS.md` or `<environment_context>`.
- **Verified by:** all Stage 2 fixture tests pass; mutation checks prove that
  removing the later matching item, changing its normalized text, or adding a
  second matching candidate restores `hold`/`ambiguous`. Legacy synthesized
  unit cases may supplement but may not replace the recorded corpus.
- **Why separate:** parsing/claiming is the genuinely hard ownership problem.
  QueueStrip, transcript rendering, and semantic proxy consumers should receive
  one clean attachment decision and must not arbitrate among rollout candidates.
- **Reality check:** both real failure variants differ in bootstrap text but
  share the same invariant: the actual locally submitted prompt is a later
  durable role-user item. Structural matching covers the observations without
  hard-coding either captured string.

### Stage 4 — integrate the package and verify the complete channel handoff

- [x] **Produces:** a pinned `codex-headless` revision in Agent Code, decision
  diagnostics included in debug/session recordings, and an end-to-end capture
  showing delivery → ownership acceptance → rollout tail → committed renderer
  entries → queue reconciliation for a fresh Codex session.
- **Verified by:** replay the recorded corpus in package tests, run Agent Code's
  contract/type/build suites, and record live fresh, resumed, and two-concurrent-
  same-CWD scenarios. Verification must assert provider thread IDs and rollout
  file paths, not merely that the UI looks connected.
- **Why separate:** a correct pure claimant can still fail if the file watcher
  does not re-read a growing candidate, the submodule pin is stale, or the
  renderer never receives the committed entries. Integration verifies those
  boundaries without moving ownership logic into them.
- **Reality check:** the current active incident already exercises this entire
  chain and shows its precise break: delivery/processing are present, candidate
  attachment and all downstream committed events are absent.

### Stage 5 — record the failed concurrency substrate as tests

- [x] **Produces:** fixture-driven red tests for sequential watcher delivery,
  including two same-CWD sessions with the same normalized submitted prompt,
  two sessions with distinct recorded prompts whose filesystem events arrive
  in reverse order, registration-before-PTY-write ordering, participant cleanup,
  and start-failure cleanup. The exact-id subagent recording also becomes an
  executable locator test rather than catalog-only evidence.
- **Verified by:** run the tests against PR #41's current per-instance maps and
  demonstrate the identical-prompt case can lease the first observed rollout to
  whichever watcher callback runs first. Record the failing assertions before
  implementation changes make them green.
- **Why separate:** the first concurrency test presented both candidates to one
  pure function at once. That proves set-level ambiguity but misses the runtime
  ordering bug, where one private watcher accepts before its sibling has even
  observed the candidate. The red runtime sequence must exist independently of
  the replacement coordinator.
- **Reality check:** the PR gate traced the actual call chain from private
  `freshRolloutCandidates` maps to immediate `tailFile()`. The recorded alpha
  and beta rollouts supply the real event shapes; the identical-prompt variant
  changes only their sanitized equality token to exercise an unrecordable
  privacy-safe collision without inventing a rollout structure.

### Stage 6 — centralize fresh ownership and path leasing

- [x] **Produces:** an isolated, process-wide coordinator keyed by normalized
  sessions root. It owns global candidate visibility, participants partitioned
  by normalized CWD, synchronous prompt registration, causal evidence sequence,
  and irreversible path leases. An edge exists only when the prompt was
  registered before the matching durable message was first observed. It emits a
  lease only for a mutual singleton in the participant ↔ candidate evidence
  graph; it uses no settlement timeout. `CodexHeadless` remains the sole
  consumer and the sole caller of `tailFile()`.
- **Verified by:** Stage 5's ordered-event tests pass under every tested
  interleaving. Distinct prompts attach immediately to their matching paths;
  identical prompts remain unresolved after one or both candidates arrive; a
  leased path is never reassigned after owner cleanup; and coordinator
  references are released after normal stop and partial startup failure.
- **Why separate:** watcher delivery order is not ownership evidence. If every
  `CodexHeadless` instance retains its own candidate set, no local conditional
  can know that a sibling is also eligible. Reconciliation and leasing must be
  one atomic decision owned outside every individual consumer.
- **Reality check:** Agent Code records a prompt synchronously in
  `CodexHeadless.write()` before invoking the PTY write. Therefore a later
  participant cannot have durably authored a rollout that was already uniquely
  matched and leased before its prompt existed. This permits immediate unique
  leases without guessing a delay while still holding true collisions closed.

### Stage 7 — make fixture verification independent and shape-faithful

- [x] **Produces:** a frozen legacy oracle that does not import the modern
  claimant, a separate modern target verification, and sanitizer v2 fixtures
  that preserve user transport wrappers, item counts/types, ordered equality
  classes, and exact text-length shape while replacing all private text.
- **Verified by:** private-source `--verify` independently reproduces the
  historical and target decisions, compares source/projection structural
  signatures, and fails under wrapper, item-count, length, equality, hash, or
  source-prefix mutation. The known modern `hold → accept` recordings verify
  successfully instead of asking the modern claimant to reproduce legacy hold.
- **Why separate:** using the production claimant as the historical oracle
  makes verification circular, while flattening multipart content can erase the
  exact upstream shape a future parser regression depends on. Neither defect is
  repaired by more claimant assertions.
- **Reality check:** review found both defects in the committed extractor: its
  `expectedLegacyDecision` check calls the upgraded claimant, and its sanitizer
  rewrites multipart content into a single item with a different size shape.

### Stage 8 — unify exact-id lookup and content-safe diagnostics

- [x] **Produces:** one exported exact-rollout locator used by both
  `codex-headless` and Agent Code, an executable test built from the recorded
  exact-id subagent fixture, and ownership diagnostics whose candidate identities
  are process-local HMACs rather than rollout paths or UUID-bearing basenames.
- **Verified by:** the recorded exact-id fixture wins over decoys according to
  one documented newest-verified-match rule; partial IDs and filename-only
  matches are rejected; the requested ID, filename UUID, and parsed
  `session_meta.id` must all agree; package and parent callers return the same
  path; and an exported structure-only debug bundle contains neither the private
  sessions root nor rollout UUID/path fragments.
- **Why separate:** exact resume/subagent identity must bypass fresh arbitration,
  but two independently implemented locators can select different duplicates.
  Diagnostics also cross the package boundary, so path privacy cannot be left to
  a downstream exporter that intentionally preserves structural values.
- **Reality check:** review found reverse-`readdir` selection in the package,
  newest-mtime selection in Agent Code, a recorded exact-id fixture never loaded
  by tests, and raw `changedPath`/candidate paths in the diagnostic payload.

### Stage 9 — reintegrate, exercise reality, and rerun the merge gate

- [ ] **Produces:** an updated codex-headless commit and PR, an updated Agent Code
  submodule pin plus startup rollback that stops a partially started headless
  instance, live fresh/resume/concurrent captures, and a new independent
  orchestration verdict covering the complete diffs.
- **Verified by:** package tests/typecheck/build/contracts, private fixture
  verification, parent tests/typecheck/build, live Codex CLI smokes, GitHub CI,
  and a fresh multi-agent review are all green. Merge order is dependency first:
  codex-headless PR #41, then Agent Code PR #634.
- **Why separate:** a correct coordinator can still leak its process-wide
  registration when parent startup rolls back, or remain absent from the parent
  build if the submodule pin is stale. The release gate must inspect the exact
  commits that will merge, not the earlier red revisions.
- **Reality check:** `CodexSession.rollbackStart()` currently nulls the headless
  instance without calling its idempotent `stop()`. That was harmless with only
  private state but would leak coordinator membership after this redesign.

### Stage 10 — record cross-policy and teardown failures

- [x] **Produces:** red recorded-fixture regressions for a reconstructed
  resume/subagent rollout whose copied prompt also matches a fresh sibling; a
  stopped fresh owner compacted before its PTY flush; overlapping `stop()` calls
  while an exact tail close is gated; an exact path reopened after its tail has
  switched cleanly to a fork; and a released registry inspected for raw session
  roots.
- **Verified by:** each test fails against package `6c2c069` for the reviewer’s
  stated reason, while the existing fresh, exact, and sanitizer corpus remains
  green. The resume/fresh collision must reuse the recorded exact-id fixture and
  a recorded prompt equality class, not an invented rollout object.
- **Why separate:** a green implementation-authored happy path would not prove
  that split fresh/resume arbitration is gone. These interleavings must remain
  independently inspectable even if the coordinator is redesigned again.
- **Reality check:** gate `run_d5e0bbe3-ef4b-4039-a1de-835bea799d0a` traced each
  failure through reachable package and parent lifecycle calls. The existing
  stopped-owner test omitted the production compaction boundary, and the exact
  test was sequential rather than overlapping.

### Stage 11 — reconcile lineage and prompt evidence in one owner

- [x] **Produces:** one coordinator graph containing fresh prompt participants
  and active resume-lineage participants. Recorded candidate parsing exposes
  bounded opaque item IDs; the coordinator HMACs them and gives verified lineage
  claims precedence before evaluating copied user history as fresh evidence.
  Tail switching retires only the tail actually closed, stop is promise-
  idempotent, stopped prompt tombstones survive the post-watcher PTY flush
  window, and the global registry is keyed by a process-local HMAC rather than a
  raw sessions root.
- **Verified by:** all Stage 10 failures become green under both candidate
  delivery orders; a real unrelated fresh candidate remains immediately
  attachable while a resume window is active; two lineage claimants fail closed;
  no exact path has two active tails; and the post-drain registry projection has
  no root, path, provider ID, CWD, or prompt.
- **Why separate:** copied history and fresh prompt equality are individually
  valid evidence but have different strength. Letting independent watchers race
  them makes callback order the hidden arbiter. The coordinator must resolve the
  stronger lineage edge first and emit one lease.
- **Reality check:** reconstructed rollouts copy opaque item IDs and prior user
  messages together. The existing resume verifier already uses overlap of those
  IDs; moving that evidence into the coordinator removes policy duplication
  without inventing a new provider signal.

### Stage 12 — repin and obtain a fourth clean gate

- [ ] **Produces:** repaired package and parent commits, a fresh real Codex
  smoke, green GitHub checks, and a fourth independent orchestration verdict
  against the exact merge heads.
- **Verified by:** inspect every constituent reviewer result as well as the
  synthesizer; require zero confirmed findings of every severity. Merge package
  PR #41 first, verify the parent pin remains reachable from package `main`, then
  merge Agent Code PR #634 and close issue #632 with evidence.
- **Why separate:** the third gate’s CI was green while ownership was still
  structurally split. Tests and CI are necessary but not sufficient; the final
  gate must challenge the new unified graph rather than the superseded commits.
- **Reality check:** package and parent GitHub checks passed on `6c2c069` and
  `c31b72bd`, and a live Codex 0.149.1 smoke committed 14 entries with no errors,
  yet independent review still produced reachable counterexamples.

### Stage 13 — record pre-spawn, causal, and shared-lifetime counterexamples

- [x] **Produces:** recorded-fixture red regressions for all six fourth-gate
  findings: reconstructed Y arriving before resume lineage registration; an O1
  prefix that already contains P being superseded by unrelated O2 after local P;
  an old exact X changed after fresh registration; resume-window expiry with an
  otherwise live root acquisition; insufficient lineage with no ignored-fork
  diagnostic; and one stopped participant whose sibling acquisition remains
  live beyond the grace interval.
- **Verified by:** each new test fails independently against package `d620c07`
  for the gate's stated reason. Y, X, P, and insufficient-lineage structure must
  derive from the recorded exact/concurrent fixtures; synthetic control is
  limited to event order, time, and removing recorded equality classes.
- **Why separate:** the existing green tests register lineage before Y, put P
  only in the later append, use current-generation files, stop the last root
  reference, and assert only successful switches. Implementing first would let
  the same process invent both the missing ordering and its asserted fix.
- **Reality check:** run `run_cae34b23-8d7e-4db3-8939-48d117692ee8` inspected
  exact parent `839ea0de` and package `d620c07`. Three independent reviewers and
  a synthesizer confirmed all six sequences with zero rejected candidates.

### Stage 14 — prepare resume ownership and close causal lifetimes

- [x] **Produces:** a package-owned prepared-resume handle acquired before the
  consumer spawns `codex`; it reserves exact X, fingerprints X lineage, and
  registers the resume participant before reconstructed Y can exist. Agent Code
  consumes that handle before PTY spawn without implementing ownership policy.
  Candidate commits preserve earliest serialized observation rather than newest
  reservation; every fresh edge enforces the generation lower bound. Resume
  watcher references release after switch/window expiry, ignored-fork decisions
  regain candidate-correlated HMAC diagnostics, and every participant release
  arms expiry behind the current admitted-read barrier even if siblings remain.
- **Verified by:** all Stage 13 failures turn green under both relevant delivery
  orders; preparation is disposed on proxy/pre-spawn/spawn/headless-start
  failure; exact and fork tails keep their physical lease until their own close;
  the watcher stops while the exact JsonlTailer remains live after window expiry;
  and diagnostics/retention inspection contain no raw root, path, CWD, prompt,
  provider ID, or lineage value.
- **Why separate:** provider spawn is the irreversible boundary: once Codex can
  create Y, registering stronger lineage later cannot revoke a fresh physical
  tail. Preparation therefore belongs in the isolated transcript package and
  must be handed to the parent as one opaque capability, not recreated from
  locator/coordinator primitives in Agent Code.
- **Reality check:** Agent Code currently invokes `ptySpawn()` before
  `CodexHeadless.start()`. A sibling acquisition can already transport Y while
  start awaits locator/coordinator/file reads. The package also serializes reads,
  so throwing away O1 merely because O2 was reserved is unnecessary and erases
  the real causal boundary.

### Stage 15 — repin and obtain a fifth clean gate

- [ ] **Produces:** repaired package and parent commits, fresh live fresh/resume
  smokes, exact-head GitHub checks, and a fifth independent orchestration verdict
  whose reviewers explicitly challenge all six fourth-gate sequences.
- **Verified by:** inspect every constituent result plus the synthesizer and
  require zero confirmed findings of every severity. Merge package PR #41 first,
  prove the parent pin is an ancestor of package `main`, then merge Agent Code PR
  #634 and close issue #632 with the final evidence.
- **Why separate:** the fourth gate was RED despite green CI and a successful
  live fresh turn. Only a new review of the repaired exact heads can establish
  that pre-spawn precedence and shared-root lifetimes work outside the tests that
  introduced them.
- **Reality check:** package `d620c07` passed 67 tests and both PRs were clean and
  mergeable; real Codex 0.149.1 committed a prompt, response, and 14 rollout
  entries with zero errors. Those facts did not cover the six confirmed orders.

### Stage 16 — record unknown-age, buffered-observer, and raw-retention cases

- [x] **Produces:** three red regressions derived from the recorded ownership
  corpus: an old rollout generation first surfaced by `change` on a filesystem
  without birth time; an insufficient-lineage decision buffered before
  `CodexHeadless.start()` and replayed to a throwing diagnostic listener; and an
  unmatched candidate whose participant expires while a sibling acquisition
  keeps the root watcher live.
- **Verified by:** each test fails independently against package `4fc0a30` for
  the fifth gate's exact reason. The unknown-age test preserves the recorded
  file/generation identity across the stale initial scan and later change; the
  observer test proves exact X remains tail-able despite a diagnostic throw;
  and the retention test asserts the sibling watcher stays live while all
  coordinator candidates report `hasRawPath: false` after the grace barrier.
- **Why separate:** birth-time fallback, buffered callback replay, and privacy
  compaction are three different lifetimes. Fixing them before recording each
  failure would let one broad cleanup change accidentally hide another.
- **Reality check:** fifth gate
  `run_4f82b82c-be41-4c20-98c5-39e3d249d875` replayed the six fourth-gate
  sequences. All three reviewers agreed the previous fixes landed, while two
  independently reproduced the unknown-birth-time cross-wire and the remaining
  reviewers identified buffered diagnostic failure and raw candidate retention.

### Stage 17 — preserve stale-generation knowledge and isolate observation

- [x] **Produces:** content-safe watcher state that remembers a stale
  path+generation pair even when birth time is unavailable; candidate
  compaction behind the same admitted-read barrier used for participant expiry;
  and exception isolation for buffered diagnostic decisions without weakening
  lease-callback failure semantics.
- **Verified by:** every Stage 16 regression turns green; replacement inodes
  remain eligible, append/change of the same stale inode remains ineligible,
  future candidate appends restore only the raw path needed for an active
  decision, and a throwing diagnostic listener neither closes exact X nor
  changes its path lease. Privacy projections retain HMAC evidence but no root,
  path, CWD, prompt, provider ID, or lineage value after compaction.
- **Why separate:** an observation timestamp is not a creation timestamp. The
  watcher is the only layer that saw the stale generation before registration,
  so that content-safe fact must cross into arbitration explicitly. Diagnostics
  remain observational and may not acquire ownership semantics.
- **Reality check:** `snapshotFile()` intentionally maps unavailable birth time
  to null, after which the coordinator currently substitutes the later change
  observation time. The live-sibling timer currently calls only participant
  expiry, and `consume()` directly invokes buffered decisions unlike the
  coordinator's exception-isolated live callbacks.

### Stage 18 — repin and obtain a sixth clean gate

- [ ] **Produces:** repaired exact package and parent heads, repeated live fresh
  and pre-spawn resume smokes, exact-head GitHub checks, and a sixth independent
  workflow verdict covering both the previous six sequences and all Stage 16
  counterexamples.
- **Verified by:** every reviewer artifact and the synthesizer contain zero
  confirmed findings of every severity. Only then merge codex-headless PR #41,
  prove the parent submodule pin is reachable from package `main`, merge Agent
  Code PR #634, and close issue #632 with the final evidence.
- **Why separate:** package `4fc0a30` and parent `402094cd` are CI-green and real
  Codex 0.149.1 committed both a fresh and a prepared-resume turn, but the fifth
  adversarial review still found reachable ownership/privacy failures. A new
  exact-head review is therefore a release artifact, not optional reassurance.
- **Reality check:** the successful smoke produced 10 fresh and 15 resume
  rollout entries from one file each, with both exact prompt/response tokens and
  zero errors. Runtime success does not exercise unsupported birth times,
  observer exceptions, or post-grace in-memory privacy.

### Stage 19 — record missed consumers, interactive input, and observer lifetimes

- [x] **Produces:** independently failing integration artifacts from the
  sixth-gate attempt: the tracked live-resume probe's dedicated TypeScript gate
  covering both Codex resume call sites; a fresh headless regression that feeds
  the real xterm chunk order (`"h"`, `"i"`, `"\r"`) before a matching recorded
  rollout; a coordinator system regression in which a live acquisition's
  throwing error observer precedes a later recorded candidate event; a fresh
  accepted-decision observer that throws after the physical tail opens; and a
  resume preparation stopped after construction without `start()`. Two watcher
  transport cases additionally reserve inode A before opening replacement inode
  B's recorded bytes, and inspect raw known-path/fingerprint caches after graph
  compaction while a sibling keeps the watcher live.
- **Verified by:** `npm run typecheck:probe` fails at both
  `live-resume-probe.mts` construction sites because they omit the mandatory
  prepared-resume capability; the chunked-input case remains
  `awaiting-local-prompt`; the queue case proves one observational throw rejects
  a predecessor and skips the later recorded observation; the accepted decision
  case turns successful tail setup into an uncertain lease tombstone; and the
  never-started resume continues to reject an otherwise sequential exact reopen.
  The replacement test leases B under A's eligible generation, while the
  live-sibling test shows coordinator paths scrubbed but one raw registry cache
  entry retained.
- **Why separate:** the probe failure is a consumer migration/CI-coverage gap;
  chunk assembly is input evidence; queue continuity and accepted-decision
  delivery are exception boundaries; constructor-held preparation is a resource
  lifetime. Treating any as another ownership conditional would hide which
  upstream artifact was lost or which observer acquired authority.
- **Reality check:** the fallback exact-head gate ran the repository's separately
  declared `typecheck:probe` against parent `7d0c3356` and got TS2345 at lines
  391 and 520. Agent Code's xterm callbacks forward each `onData` chunk unchanged,
  while `extractSubmittedPromptFromWrite()` accepts only one complete write.
  Other reviewers traced live callbacks into serialized queues and the
  post-`tailFile()` lease callback with no exception isolation, and confirmed
  `stop()` returns early when a constructor-held preparation has not reached
  `start()`.

### Stage 20 — assemble input, migrate resume spawns, and isolate observers

- [x] **Produces:** one shared live-probe helper/order that prepares the exact
  rollout before every Codex resume PTY spawn and passes the opaque capability
  into `CodexHeadless`; one transcript-owned incremental input assembler that
  reconstructs ordinary chunked typing and complete bracketed paste before
  registering submitted prompt evidence; process-global error and ownership
  diagnostics become best-effort observations that cannot reject watcher/read/
  maintenance queues or invalidate a successfully opened tail. Never-started
  resume preparations are disposed by `stop()`. Reserved prefix reads verify
  the opened handle still names the snapshotted generation, and retention
  compacts registry transport caches with the graph. Agent Code's integration
  verification includes the probe typecheck so a future cross-package API
  migration cannot silently break the real-data tool again; the standalone
  parser repository cannot run that check because the probe intentionally
  imports its two sibling headless packages.
- **Verified by:** every Stage 19 failure turns green; preparation is disposed if
  spawn or construction fails and when stopped before start; the live probe
  remains the sole owner of PTY termination and `CodexHeadless.stop()`; chunked
  typed/pasted prompts register exactly once while cancellations and unsupported
  editing fail closed; throwing observers do not suppress the next candidate,
  tail authorization, queue drain, or clean sequential exact reopen. Parent and
  package checks, artifacts, and `git diff --check` pass.
- **Why separate:** preparation must cross the irreversible spawn boundary as a
  capability; input assembly must precede the PTY write to preserve causal
  ordering; diagnostics must remain outside ownership semantics. One helper
  makes resume ordering reviewable at both probe call sites without moving
  arbitration policy into the probe.
- **Reality check:** Agent Code's production `CodexSession` already uses the
  correct pre-spawn sequence, proving the public integration shape. The missed
  probe still uses the superseded spawn-first order, and its script is excluded
  from the parser package's current `check` command.

Package `3e6a019` turns all recorded Stage 19 cases green in an 83-test suite;
parser `a3fee9d` passes its 94-test check plus the monorepo-only probe typecheck.
A real `codex-cli 0.149.1` run submitted the fresh prompt as character chunks,
then resumed through the prepared capability: fresh committed 14 entries and
resume committed 25, each from one rollout with exact prompt/response evidence
and zero errors. A deliberately immediate synthetic Enter first remained
visible in the composer while ownership correctly reported one local prompt and
no matching rollout; a 250 ms human input boundary submitted normally, proving
that failure was PTY delivery timing rather than transcript attachment.

### Stage 21 — obtain a seventh exact-head gate and merge

- [ ] **Produces:** newly pinned parent and both dependency commits, exact-head CI, a live
  fresh plus prepared-resume smoke, and a seventh independent review with no
  coverage gaps or confirmed findings. Because the Agent Code workflow provider
  failed both the original and manual-recovery sixth runs, the final evidence
  must include completed constituent reviewer results rather than treating an
  orchestration transport failure as approval.
- **Verified by:** all reviewer artifacts are inspectable and GREEN; package and
  parent checks cover the probe typecheck; live committed streams contain the
  exact prompt and response from one rollout each with zero errors; both PRs are
  clean/mergeable at the reviewed commits. Merge dependency PR #41 first,
  merge both dependency PRs, verify each pinned commit is reachable from its
  `main`, then merge PR #634 and close issue #632.
- **Why separate:** exact-head review is invalidated by any corrective commit.
  The failed workflow runs produced coverage-gap values, not code verdicts, and
  therefore cannot satisfy the release gate even though GitHub CI was green.
- **Reality check:** workflow runs `run_5930a8e0-8bd9-4398-9710-1e0731e5edfa`
  and recovery `run_6061aadd-5dae-4e58-8efb-fa1b8265d90a` ended
  `completed_with_errors` after DNS/stream and unconfirmed-provider-termination
  failures. The fallback review then found the red live-probe typecheck that
  those runs never reached.

### Stage 22 — record the seventh-gate ownership and input counterexamples

- [x] **Produces:** deterministic red regressions for all four confirmed
  findings from workflow `run_813d693c-517f-4c9e-a3df-32d54566b9a5`: a
  recorded fresh prompt submitted synchronously after `start()` is called but
  before watcher readiness; replacement of verified inode A after ownership
  authorization but before the fresh physical tail opens; the same replacement
  boundary on prepared exact X and a lineage switch; modified/private CSI,
  multiline Ctrl+U, and punctuation-sensitive Ctrl+W sequences whose current
  reconstruction differs from Codex; and a plain Tab submission in an observed
  no-popup composer state. The input cases retain a captured screen/state label
  identifying whether Codex treated Tab as submission or completion.
- **Verified by:** the startup case remains `awaiting-local-prompt`; each inode
  case emits replacement B under A's proof; the editing cases return a false
  prompt token or incorrectly recover validity; and the no-popup Tab case
  registers no local prompt against package `3e6a019`. Each failure must be
  observed before implementation changes and must use the existing recorded
  rollout transport rather than a newly imagined JSONL literal.
- **Why separate:** watcher readiness, physical file generation, provider input
  semantics, and Tab popup state are independent evidence boundaries. Fixing
  them together first would let one green integration hide a second false
  ownership path and would repeat the forward-patching failure this document is
  meant to prevent.
- **Reality check:** the fresh rollout body comes from
  `modern-0149-agents-first`; the provider controls come from the vendored exact
  `rust-v0.149.1` source and its textarea/composer tests (Ctrl+U is line-scoped,
  Ctrl+W honors `/`, modified arrows move by word, and default plain Tab invokes
  submission when no popup consumes it). The generation sequence is the real
  watcher-prefix-to-`JsonlTailer` handoff traced independently by two reviewers,
  not a speculative filesystem policy.

Package checkpoint `4bf01d6` records the failures before implementation. The
focused run produced exactly eight red assertions and 50 green controls: stale
history recovery, multiline Ctrl+U, Tab submission, fresh/lineage lease
generation, startup-time submission, exact preparation generation, buffered
lineage generation, and `JsonlTailer` following replacement B. The same-inode
append control passed before the replacement assertion failed.

### Stage 23 — bind physical tails and preserve submitted evidence

- [x] **Produces:** one generation-bound rollout capability shared by fresh,
  exact-id, and resume-lineage paths. It carries the verified `dev:ino` through
  arbitration into `JsonlTailer`, verifies the descriptor at the physical-open
  boundary, follows same-inode appends, and permanently refuses bytes from a
  replacement generation. Fresh participation is installed synchronously in
  `start()` before its first await so prompt registration precedes both PTY
  delivery and watcher observations. The input assembler either implements the
  exact recorded default editing result or invalidates that submission; it may
  recover unknown state only from a control proven to reset the real composer.
  Tab becomes evidence only when the pre-write screen/input state proves the
  provider will submit rather than complete.
- **Verified by:** every Stage 22 regression turns green; inode B contributes
  zero entries under A's proof while later bytes appended to A still commit;
  exact lookup metadata, lineage extraction, bootstrap, and polling all remain
  on the same verified generation; startup typing attaches to the recorded
  rollout; false editing tokens cannot lease a sibling; and both no-popup Tab
  submission and popup-consumed Tab are distinguished. Existing causal-order,
  overlap, replacement-prefix, and clean exact-reopen tests remain green.
- **Why separate:** `dev:ino` is an authorization capability, not another
  candidate field, and prompt registration is a causal event, not buffered UI
  state. Both must survive intact to their consumers. The renderer and Agent
  Code adapter remain forbidden from inventing ownership; their only input
  responsibility is forwarding the exact terminal bytes already observed by
  the package.
- **Reality check:** the accepted prefix reader already proves A by `fstat` but
  then closes it, `FreshRolloutLease` currently drops the generation, exact
  lookup separately reopens by pathname, and `JsonlTailer` deliberately resets
  onto a new inode. `CodexHeadless.write()` also consumes and resets a complete
  prompt while `freshRolloutParticipant` is null during async watcher priming.
  These are concrete missing handoffs in the current source.

Package `6244eac` turns every Stage 22 failure green. The physical tail now
opens/fstats the authorized generation synchronously, reads from that descriptor,
and stops with one structure-only error if the pathname later names another
inode. Exact lookup and lineage extraction use verified handles; fresh startup
installs its participant before the first await. The exact `0.149.1` input cases
and a provider-footer Tab integration pass. Package check is green at 92 tests,
parser check at 94 tests, the monorepo live-probe typecheck is green, and the
parent typecheck plus focused nine-test Codex readiness suite pass.

### Stage 24 — repin and obtain an eighth exact-head gate

- [ ] **Produces:** a new codex-headless commit and PR head, any required parser
  API migration, an Agent Code submodule repin, package/parent CI, live fresh,
  prepared-resume, and provider-backed Tab-queue smokes, the recorded
  startup-typing regression, plus a new independent multi-agent review of the
  exact commits intended for merge.
- **Verified by:** every package and parent check is green; live committed
  streams contain the exact submitted prompt and response from one verified
  generation with zero rollout errors; all constituent reviewer artifacts and
  the synthesizer report no coverage gaps and zero confirmed findings. Merge
  codex-headless PR #41, then parser PR #21, prove both pinned commits are
  ancestors of dependency `main`, merge Agent Code PR #634, and verify issue
  #632 closes.
- **Why separate:** any corrective commit invalidates the seventh gate even if
  its old CI remains green. Dependency reachability and live provider behavior
  are release facts that cannot be inferred from unit tests or an earlier
  reviewed SHA.
- **Reality check:** the seventh gate completed with four agents, no provider
  failures, and a RED synthesizer at exact parent `91d4a70f`, codex-headless
  `3e6a019`, and parser `a3fee9d`. Its clean orchestration health makes these
  findings code blockers rather than workflow transport ambiguity.

Pre-push Stage 24 live evidence is green against the standalone Codex CLI
`0.149.1`: a typed fresh turn committed 12 entries, an exact prepared resume
committed 21, and a second prompt submitted with the provider-rendered
`tab to queue` state committed 29; every stream contained its exact prompt and
response token with zero rollout errors. The same sequence also passed the
repository-pinned Codex `0.144.4` with 14/23/32 entries and zero errors. A
separate attempt to inject terminal bytes before the provider rendered any TUI
produced no provider rollout at all, so it is not counted as ownership evidence:
the actual Agent Code race begins after the PTY is interactive but before
watcher readiness, and remains independently covered by the recorded system
fixture that holds watcher priming while the exact terminal chunks arrive.

### Stage 25 — record effective-input and capability-boundary reality

- [x] **Produces:** a content-safe Codex `0.149.1` input-evidence corpus and
  catalog containing the exact PTY chunks, pre-write structural screen state,
  effective TUI configuration class, and durable submitted user value for:
  trust/update or approval modal actions, modal-consumed Ctrl+C, decomposed
  grapheme Backspace/Delete, mixed ASCII/CJK Ctrl+W, repeated multiline
  Ctrl+A/Ctrl+E, a custom composer submit mapping, an unbound editor action,
  `tui.vim_mode_default`, active-footer Tab queue, transcript-spoofed footer,
  and `$` skill completion. It also records a package-level capability
  projection showing construction, own/enumerable keys, serialization, consume,
  and post-dispose retention at exact head `6244eac`.
- **Verified by:** for each provider case, compare the terminal input with the
  actual durable role-user item written by the same fresh Codex rollout and
  record whether no submission occurred. Capture the exact CLI version and the
  isolated `CODEX_HOME`/profile/`-c` configuration inputs without committing
  private paths or prompt text. The capability projection must be reproduced
  from the built package, not only TypeScript source inspection.
- **Why separate:** the provider keymap, active bottom-pane stack, Unicode text
  model, and footer layout are upstream facts. If their expected outcomes are
  written first by the implementation author, the resulting tests merely bless
  another terminal-editor guess. Capability privacy is likewise a runtime
  representation property, not a TypeScript declaration property.
- **Reality check:** gate
  `run_cafdcd49-8732-4847-9871-0ea8eb4e2f23` traced real production trust bytes
  through `CodexHeadless.write()`, verified the configurable `tui.keymap.*` and
  `tui.vim_mode_default` surface in exact `rust-v0.149.1`, reproduced divergent
  grapheme/word/line navigation, and constructed a forged preparation from the
  built package. These observations define the recording matrix; they are not
  substitutes for the provider recordings this stage produces.

### Stage 26 — turn the recordings into independent red contracts

- [x] **Produces:** fixture-driven failing tests for every Stage 25 input class,
  plus package tests proving a caller-created object cannot authorize exact
  tailing and that the issued resume capability exposes no raw root, path, CWD,
  provider ID, owner ID, generation ID, coordinator acquisition, or buffered
  lease through reflection/serialization before or after disposal.
- **Verified by:** run the focused contracts against package `6244eac` and
  record each expected failure before production changes. The input assertions
  compare with the recorded durable provider result/no-result; capability tests
  compare the public built artifact with the Stage 25 runtime projection. Every
  previous 92-test ownership/lifecycle control must remain green.
- **Why separate:** keymap/modal invalidation, exact default editing, structural
  footer proof, and runtime issuance are distinct contracts. Recording all red
  boundaries before repair prevents one fail-closed shortcut from concealing a
  different false-positive ownership path.
- **Reality check:** the eighth gate confirmed that CI and fresh/resume/Tab live
  smokes all passed while these boundaries remained reachable. The new tests
  must therefore exercise the exact omitted states rather than add more copies
  of those already-green happy paths.

Package checkpoint `89506f1` records the red boundary before production edits.
The 21-case prompt suite executes all ten provider recordings plus corpus and
provenance controls: 12 controls pass and nine behavior cases fail for the
recorded trust, Unicode, repeated-boundary, keymap, Vim, history-modal, and Tab
differences. The recorded resume-capability group has one lifecycle control
green and three expected failures proving enumerable sensitive state,
reflective construction, and duck/prototype forgery. Typecheck and diff checks
remain green, and the prior buffered-lineage test now synchronizes through the
coordinator's public inspection result instead of reopening private state.

### Stage 27 — isolate provider input evidence and seal resume issuance

- [x] **Produces:** a transcript-owned input-evidence state machine with an
  explicit composer/modal/mode boundary. Non-composer actions bypass or
  invalidate prompt evidence; configurable/unproven keymaps and Vim mode fail
  closed; supported default editing follows the recorded Codex grapheme, word,
  and repeated line-boundary semantics; and Tab requires a structurally located
  active bottom footer with no completion pane/token. The resume preparation is
  an issued public capability whose sensitive state lives only in package-
  private storage, whose runtime issuer is validated at consume, and whose
  disposal scrubs that storage. Agent Code and the live probe may only prepare,
  pass, and dispose it.
- **Verified by:** every Stage 26 red contract turns green, all earlier recorded
  ownership/lifecycle fixtures stay green, and mutation checks prove that
  transcript text cannot spoof footer evidence, adding `$` disables Tab proof,
  a mode/keymap override cannot register a local prompt, fabricated lookalikes
  fail before any tail opens, and disposed capabilities cannot be reused or
  inspected for raw identity.
- **Why separate:** prompt text is evidence consumed by the ownership graph; it
  is not ownership policy itself. Effective input semantics belong in one
  provider adapter with the coordinator as its single consumer. Resume
  preparation similarly remains one package-issued handoff across spawn rather
  than exposing locator/coordinator state to callers.
- **Reality check:** the current assembler accepts every `write()` as composer
  input, scans the whole screen for `tab to queue`, edits JavaScript code points,
  and assumes default bindings. The current exported class has a public
  constructor and enumerable raw fields. Those are substrate defects at the two
  named boundaries; renderer or queue changes are forbidden workarounds.

Codex-headless `93c6fcb` and parent `dc226882` complete this stage. The package
now issues a frozen, version-pinned launch profile whose final CLI overrides
force Enter submit, Tab queue, non-Vim startup, and no runtime Vim-toggle
binding. `CodexHeadless` accepts prompt evidence only with that issued object;
Agent Code probes the exact binary, appends the issued arguments after every
other configuration layer and immediately before `resume`, then passes the same
capability beside the PTY. The isolated adapter reads an immutable xterm frame,
requires a recorded bottom composer/footer, and uses the provider-rendered draft
instead of reproducing Unicode, word, history, or configurable editor behavior.
Terminal attachment now follows the synchronous ownership setup but precedes
watcher readiness, preserving real startup frames while `start()` is pending.

The resume preparation is now a factory-only public interface with native
private fields, a module-private constructor token, WeakSet issuer validation at
`CodexHeadless` construction, and disposal-time scrubbing. Package check is
green at 119 tests, including all ten recorded input cases and the recorded
capability attacks; type/build/package contracts are green. Parent typecheck and
the 15 focused Codex readiness/delivery tests are green. The otherwise-complete
parent test run has one unrelated local corpus-reference failure because a
fixture cites a deleted private Claude session; the changed Codex suites and CI
do not depend on that machine-local artifact.

### Stage 28 — repin, exercise configuration reality, and obtain a ninth gate

- [ ] **Produces:** repaired codex-headless and parent commits, any necessary
  parser probe API migration, live default/custom-keymap/Vim/modal/Unicode/Tab
  recordings, exact-head CI, and a ninth independent workflow verdict against
  the commits intended for merge.
- **Verified by:** inspect every constituent reviewer artifact plus the
  synthesizer and require zero coverage gaps and zero confirmed findings of any
  severity. Live default input still attaches and reconciles QueueStrip; custom
  or unproven input modes demonstrably fail closed without cross-wiring a
  sibling. Merge codex-headless PR #41, then parser PR #21, prove both pinned
  commits are ancestors of dependency `main`, merge Agent Code PR #634, and
  verify issue #632 closes.
- **Why separate:** any corrective commit invalidates the eighth review and its
  earlier green CI. Runtime package shape, provider configuration, dependency
  reachability, and the final parent pin are release facts that must be checked
  on the exact merge heads.
- **Reality check:** the eighth run completed normally with four agents, no
  stalls, retries, provider failures, or coverage gaps, and returned RED with
  four HIGH findings plus one MEDIUM privacy finding. This is code work, not an
  orchestration-health ambiguity.

The ninth exact-head gate
`run_82f91693-7c19-450a-8862-0b5821d962bf` completed normally against parent
`680cccc1`, codex-headless `93c6fcbe`, and parser `a3fee9d`. All four agents
completed with no retry, stall, provider failure, or coverage gap. The
synthesizer returned **RED** with ten deduplicated findings. It rejected the
claimed atomic-paste/no-submission bug because no committed provider recording
proved that outcome; that candidate remains an unknown and is not implementation
authority.

### Stage 29 — record ninth-gate causality, configuration, and retention reality

- [x] **Produces:** inspectable artifacts for all ten confirmed findings before
  production edits: recorded 0.149.1 narrow-wrap frames across resize; ordinary
  composer submissions whose draft/CWD contain the modal and Vim sentinel
  strings; a real lower-layer conflicting keymap plus the exact upstream
  `rust-v0.149.1` precedence/conflict source coordinates; built-package
  reflection projections for resume getters, structural-profile promotion, and
  raw participant IDs; and recorded-rollout lifecycle schedules for synchronous
  generation-open failure/retry, unresolved-candidate missed-event recovery,
  and terminal-candidate post-compaction append.
- **Verified by:** provider cases compare the PTY input with the durable user
  item or explicit startup failure from the same run. Source-derived config
  evidence records tag commit and file hashes. Package projections execute the
  built `93c6fcbe` artifact. Lifecycle schedules retain real rollout bytes and
  mutate only inode/event/timer order. Each artifact must reproduce the
  reviewer's counterexample independently of the later fix.
- **Why separate:** resize interpretation, effective keymap precedence,
  capability reflection, physical-tail transactionality, and watcher retention
  are independent facts. Writing the repair first would let implementation
  assumptions define the evidence and repeat the green-but-wrong failure.
- **Reality check:** the gate reproduced stale-draft promotion and reflective
  leaks from the built package, traced the lifecycle/retention sequences through
  reachable code, and inspected exact upstream precedence 30/40/50. New live
  recording is required only where the gate correctly identified a missing
  provider artifact.

### Stage 30 — turn the ninth-gate artifacts into red contracts

- [x] **Produces:** deterministic failing tests for CH-01 through CH-10 before
  changing production code. The matrix covers clean retry after synchronous
  no-open failure for exact/fresh/lineage; missed-event rescan for a live
  unresolved sibling; post-compaction terminal-path eviction; stale unchanged
  composer redraw after an edit; conflicting and higher-precedence keymap
  refusal; complete prototype-chain capability privacy; unissued compatibility
  lookalike rejection; content-safe retention inspection; resize-layout
  invalidation; and structurally scoped modal/Vim detection.
- **Verified by:** run the focused suite against `93c6fcbe` and record each
  expected failure while all prior recorded controls remain green. Every test
  names its Stage 29 artifact; no hand-authored provider screen or rollout may
  replace the recorded source.
- **Why separate:** these are contracts about outcomes, not a proposed
  algorithm. Keeping the red checkpoint reviewable prevents a broad fail-closed
  shortcut from hiding ordinary valid submissions or permanent transcript
  disconnection.
- **Reality check:** package, parser, and parent CI are all green at the RED
  heads. The new contracts must therefore exercise the exact omitted orders and
  surfaces rather than add more happy-path counts.

### Stage 31 — repair the isolated evidence, capability, and transport boundaries

- [x] **Produces:** composer evidence tied to a causally acknowledged draft and
  layout epoch rather than any PTY byte; structurally scoped footer/modal/Vim
  parsing; a conflict-free input profile issued only when no higher-precedence
  managed layer can alter it; a public resume handle with no sensitive
  prototype surface; no shipped structural-profile promotion or raw testing
  identity projection; transactional tail acquisition whose synchronous
  no-open failure retires cleanly; and state-aware transport retention that
  preserves polling for unresolved active candidates while immediately evicting
  terminal candidates.
- **Verified by:** every Stage 30 red contract turns green, all prior 119 package
  tests and recorded fixture checks remain green, and mutation controls prove
  that an unchanged newer frame, resize-before-redraw, managed config,
  conflicting lower bindings, delayed terminal events, and reflection cannot
  manufacture evidence or retain raw identity. Ordinary adversarial-text
  prompts must still attach.
- **Why separate:** prompt evidence, capability issuance, and transport leasing
  stay isolated sibling layers with `CodexHeadless` as their sole consumer.
  Renderer, QueueStrip, parent readiness, and transcript reducers remain
  forbidden workarounds.
- **Reality check:** CH-01 through CH-10 are all reachable in codex-headless or
  its Agent Code launch integration; the parser and provider-neutral parent
  paths survived review. The repair must remain concentrated at the boundaries
  that produced the false or missing evidence.

### Stage 32 — repin, replay reality, obtain a tenth gate, and merge

- [ ] **Produces:** repaired dependency and parent commits, exact-head package
  and parent CI, live default/conflict/managed-absence/resize/adversarial-text
  evidence, and a tenth independent orchestration verdict against the commits
  intended for merge.
- **Verified by:** inspect every constituent artifact plus the synthesizer and
  require zero coverage gaps and zero confirmed findings. Merge codex-headless
  PR #41, then parser PR #21, prove both pinned commits are ancestors of their
  dependency `main`, merge Agent Code PR #634, and verify issue #632 closes.
- **Why separate:** every corrective commit invalidates the ninth review.
  Dependency reachability, current CI, live provider behavior, and the exact
  parent pin are release artifacts and cannot be inferred from repaired tests.
- **Reality check:** at the ninth heads all three PRs were clean, mergeable, and
  CI-green, and the current development host had no legacy or MDM managed
  config. Those facts did not cover the ten confirmed counterexamples and are
  not permission to merge them.

## 4. Isolation boundary

The hard parts are **fresh rollout ownership**, **provider input evidence**, and
the **pre-spawn resume handoff**, not rendering. They remain in the
`codex-headless` transcript layer as explicit sibling boundaries. The
coordinator is the only fresh-session component that may observe the global
candidate/participant sets or lease a path. The input-evidence adapter is the
only component that may turn PTY bytes plus proven provider state into a local
prompt edge. The resume factory is the only component that may issue a
pre-spawn capability. Their only runtime consumer is `CodexHeadless`, which
receives one lease and alone may start `tailFile`.

Exact-id discovery is a separate inert locator: it may enumerate and validate
rollout metadata but may not import or participate in fresh ownership. The
frozen legacy oracle is test/extraction infrastructure and production code is
forbidden from importing it.

The following are forbidden from importing claimant internals or independently
choosing a rollout:

- Agent Code renderer, QueueStrip, and transcript reducers;
- `src/providers/codex/runtime/codexSession.ts`;
- prompt-delivery/readiness code;
- semantic proxy and screen-fallback channels;
- resume/fork ownership code may register opaque lineage evidence only through
  the shared coordinator; it may not watch, select, or lease candidates through
  a second policy. Shared inert parsing and normalization helpers remain
  separately testable.

Agent Code may forward content-safe decision diagnostics and consume the final
committed stream. It may not implement a second ownership policy to compensate
for the package.

## 5. Unknowns that must not be patched around

1. No `0.146.x` rollout is present, so the exact first upstream release that
   removed `event_msg.user_message` remains unknown.
2. The full population and frequency of injected role-user bootstrap shapes is
   not cataloged. Two observed forms are not an exhaustive grammar.
3. The frequency and correct product behavior for concurrent same-CWD sessions
   submitting identical normalized prompt text needs explicit human judgment.
   The default remains fail closed until that decision is approved.
4. The candidate reader is capped at 4 MiB. We have not measured whether large
   startup instructions can push the first real prompt beyond that prefix.
5. We have not yet proved that every relevant `change` event causes a candidate
   re-read on all supported filesystems, or whether a held partial file can
   remain stale in the candidate map.
6. We have one working `0.149.0` resume/subagent capture, but have not cataloged
   all resume/fork shapes under the new upstream format.
7. It is not yet measured whether normalization can collapse two distinct real
   prompts often enough to create practical ambiguity.
8. The exact renderer transition from disconnected to ready and the queue row
   consumed by the first committed user item must be asserted in Stage 4 rather
   than inferred from package tests.
9. The coordinator guarantee is process-wide. A second operating-system process
   sharing the same Codex sessions root cannot see the first process's
   participants or leases; cross-process locking remains outside this incident's
   evidence and must not be claimed as solved.
10. Filesystem watchers can coalesce or omit intermediate changes. The
    coordinator must re-read known growing candidates on observed changes, but
    the supported-filesystem live smoke remains necessary evidence.
11. Codex keybindings are configurable. The exact default `0.149.1` behavior is
    recorded, but a custom mapping cannot be inferred from raw bytes alone. Tab
    evidence therefore needs an observed provider state/key hint or must fail
    closed; default behavior must not be silently generalized to every config.
12. A pathname replacement after a fresh lease has no safe automatic owner
    without a new arbitration event. The generation-bound tail must reject it;
    whether a later generation at the same pathname may be reconsidered for the
    same live participant remains intentionally fail-closed until recorded
    provider behavior requires and justifies such recovery.
13. Codex configuration layering now includes base config, named profile, CLI
    `-c` overrides, and possibly project/managed policy. Until the complete
    effective keymap can be proven at the spawn boundary, non-default or unknown
    input semantics must fail closed rather than inherit the base-file guess.
14. The complete set of provider bottom panes that consume Ctrl+C or ordinary
    editing keys is not enumerated. Stage 25 records the reachable modal cases;
    every unrecognized active pane remains invalid input evidence.
15. JavaScript `Intl.Segmenter` and Rust `unicode-segmentation` must be compared
    on the recorded grapheme/word cases before equivalence is claimed. Any
    divergent class stays unsupported and fail-closed.
16. Codex 0.149.1 legacy managed file and MDM layers outrank session flags.
    Detecting their absence immediately before spawn is operational evidence,
    not an atomic lock against an administrator changing policy during startup;
    the residual race must be named and fail closed wherever provider state no
    longer agrees with the issued profile.
17. A larger PTY generation is not necessarily a composer acknowledgement. The
    complete set of harmless status/redraw chunks between an edit and the next
    composer paint is not enumerated, so unchanged drafts remain stale.
18. The existing corpus does not prove that production's atomic bracketed paste
    plus Enter fails to submit on 0.149.1. That ninth-gate candidate was rejected
    and must not drive code until a real no-request/no-rollout recording exists.

## 6. Fixture plan

Stage 0 produces the missing claim-decision observations. Stage 1 consumes the
existing private rollout/session recordings plus new controlled concurrency
recordings and emits sanitized, traceable fixtures. Sanitization replaces text
atoms consistently while preserving entry order, entry type, role, equality
relationships, wrappers, and relative size class; the catalog retains source
hashes and transformation version so a future worker can revalidate locally.

Stage 2 is the first stage that turns those recordings into test expectations.
No implementation may create a fixture, and no failing recorded case may be
deleted or weakened to make Stage 3 green. If a recorded case contradicts this
decomposition, revise this document and return to the approval gate instead of
adding a conditional.

Corrective Stage 5 reuses the recorded concurrent rollout structures and
exercises their real arrival order through the coordinator boundary. Stage 7
regenerates sanitizer v2 projections from the same private sources; Stage 10
extends those projections to v3 by retaining content-safe copied-lineage field
and equality shape. Neither stage may replace the sources with plausible
literals. The only synthetic mutations are explicitly labeled equality or
truncation counterexamples whose surrounding rollout transport/order still
comes from recordings.

Stage 25 extends the corpus with provider-produced input outcomes rather than
hand-authored terminal strings. Stage 26 may sanitize prompt atoms consistently,
but it must preserve exact UTF-8/code-unit structure, PTY chunk boundaries,
screen rows, active-pane/footer placement, effective configuration class,
submission/no-submission outcome, and equality with the durable role-user item.
Capability fixtures come from the built package projection and contain only
presence/type/equality flags—never the raw values they prove are retained.

Stage 29 extends those same sources instead of inventing new provider shapes.
Resize and adversarial-text fixtures come from real 0.149.1 terminal/request/
rollout captures; config precedence comes from exact upstream tag
`rust-v0.149.1`; capability/privacy projections execute the built ninth-gate
package; lifecycle tests reuse the existing recorded exact and modern rollout
bodies while changing only reviewed inode, queue, timer, and watcher order.

## 7. Implementation and verification record

- **Stage 0:** `CodexHeadless` emits a content-safe ownership decision with a
  per-process HMAC fingerprint. The active `0.149.0` capture independently
  showed eight ordered observations, a non-matching legacy selection, and the
  later local match without changing the old `hold` behavior.
- **Stage 1:** seven sanitized fixtures were extracted from real rollouts. The
  corpus includes legacy `0.145.0`, first-event-free `0.147.0`, two failed fresh
  `0.149.0` Agent Code recordings, two controlled concurrent same-CWD `0.149.1`
  siblings, and one working exact-id `0.149.0` subagent. The extractor verifies
  private source hashes, pinned live-file boundaries, ordering/equality
  signatures, and absence of raw paths/user text.
- **Stage 2:** fixture tests were run before the claimant change. Six assertions
  failed red as expected: five modern candidates and the concurrent attribution
  case returned `hold` where the reviewed target table required `accept`.
- **Stage 3:** the claimant now compares the local PTY prompt ledger with every
  durable user observation. It never recognizes bootstrap strings by content,
  collapses duplicate event/response representations within one file, and
  remains ambiguous across two matching files. Recorded removal/change/collision
  mutations verify the fail-closed boundary.
- **Stage 4:** Agent Code forwards ownership decisions onto a diagnostic-only
  recording channel. A live fresh `CodexSession` smoke against real CLI
  `0.149.1` produced three incomplete-file holds, then `accept:true`, followed
  by 12 committed entries including the submitted prompt. The package's 29
  tests, typecheck, build, contract, artifact verification, and upstream drift
  check pass; accepted/latest are both `0.149.1`. Once that committed user row
  arrives, Agent Code's existing provider-neutral ingestion path removes the
  matching Codex `queuedMessages` item; no queue-specific fallback was added to
  conceal a missing transcript.
- **Agent Code integration:** the recorder suite passes 11/11 in isolation,
  TypeScript, test-contract, keybinding, production build, and `git diff
  --check` pass. The full local suite passed 1,828/1,830. One failure is the
  repository's unchanged missing private image corpus source. The other was a
  transient recorder-directory append failure under full-suite parallelism;
  the complete recorder suite passed immediately before and after that run, so
  the diagnostic assertion was not weakened to hide it.

The exact `0.146.x` change point and the 4 MiB prefix-risk frequency remain
documented unknowns. Neither is papered over: the former does not affect the
structural matcher, and the latter still fails closed rather than attaching by
recency.

## 8. Corrective review record

The independent merge gate run `run_15bdd110-af0f-42f6-9c0b-95411e2e401a`
returned **RED** against package commit `f3b9b8b` and parent commit `08f767a`.
Three independent reviewers and a synthesizer agreed that Stage 3's pure
ambiguity rule was not sufficient because each runtime instance owned a private
candidate map and could tail the first matching filesystem event before sibling
visibility existed. They also found the circular legacy verifier, shape-losing
sanitizer, unused exact-id recording, duplicated locator policy, raw path-bearing
diagnostics, and parent startup cleanup gap captured in Stages 5–9.

This document was revised before corrective implementation. The user's
instruction to resolve the blockers and continue the review/fix loop is the
explicit approval to execute these corrective stages; any later evidence that
invalidates the mutual-singleton model requires another document revision rather
than a forward patch.

A second independent gate, `run_9ac87e29-09c4-4cf7-9db6-aa94298ab59e`,
returned **RED** against package `f10e299` and parent `452f468c`. Its six
confirmed findings became recorded counterexamples before repair:

1. a stopped provider could lose a delayed rollout to a later identical-prompt
   sibling;
2. a process-lifetime exact lease prevented ordinary sequential reopen;
3. a queued async read could assign newly appended bytes an earlier sequence;
4. stopped callbacks and raw ownership evidence remained process-global;
5. sanitized provenance exposed UUID-bearing provider filenames; and
6. aggregate diagnostics could not correlate a decision with a candidate.

Package `6c2c069` resolves those findings with generation-window tombstones,
clean-versus-uncertain lease retirement, watcher-time inode/byte snapshots plus
a known-file rescan, process-keyed HMAC evidence with post-drain compaction,
public-fixture-derived opaque provenance labels, and candidate-level HMAC
diagnostics. Recorded tests exercise the stopped-owner, growing-prefix,
overlapping/sequential exact-tail, callback-failure, and retention sequences.
The package check, build, artifact check, upstream check, and private seven-file
regeneration/verification are green.

The parent integration against that package revision passes contract,
keybindings, typecheck, its production build/artifact verifier, and the focused
Codex rollback suite. The full local suite passes 1,830/1,831; its sole failure
is the unchanged image-attachment fixture that points at a missing private
Claude transcript outside this worktree. Stage 9 intentionally stays open until
the new package pin is committed, pushed, green in GitHub CI, and reviewed by a
fresh orchestration run.

A third independent gate, `run_d5e0bbe3-ef4b-4039-a1de-835bea799d0a`, returned
**RED** against package `6c2c069` and parent `c31b72bd`. Its five confirmed
findings became Stage 10's failing recorded/system tests before Stage 11 code:

1. final watcher release compacted stopped-owner evidence before the parent PTY
   could perform a delayed provider flush;
2. overlapping `CodexHeadless.stop()` calls could retire an exact lease while
   its first physical close remained pending;
3. copied user prompts let a fresh participant lease a reconstructed resume
   fork before the independent lineage watcher reserved it;
4. a successful X → Y resume switch left X's physical lease active; and
5. the process-global registry retained raw Codex sessions roots indefinitely.

Package `d620c07` resolves those counterexamples by arbitrating fresh prompt and
resume lineage edges in one mutual-singleton graph, installing lineage leases
before callbacks, retaining HMAC-only stopped-owner tombstones through the
provider-flush grace, serializing stop and switch cleanup, retiring each closed
physical path, and HMAC-keying the global root registry. Sanitizer v3 preserves
the copied-ID equality shape from all seven private recordings so the lineage
tests do not rely on invented provider objects. Additional recorded tests prove
that an unrelated fresh rollout remains attachable during a resume window, two
resume claimants fail closed, truncated lineage quarantines, pre-start stop
closes late acquisition, and terminal-exit cleanup is joined by explicit stop.
The package contract, typecheck, 67-test suite, production package verifier,
Codex `0.149.1` upstream check, and private seven-recording regeneration are
green. Stage 12 remains open until this exact pin passes parent verification,
live smoke, GitHub CI, and a fourth independent gate.

The fourth gate, `run_cae34b23-8d7e-4db3-8939-48d117692ee8`, returned **RED**
against package `d620c07` and parent `839ea0de`. Package CI, parent CI, and a
real fresh Codex `0.149.1` smoke were green, but the read-only gate confirmed six
counterexamples with zero rejected candidates:

1. Agent Code spawns the resume PTY before the package registers lineage, so a
   reconstructed Y can be irreversibly leased as fresh during start awaits;
2. reserving O2 before serialized O1 commits discards O1 and makes P that was
   already durable appear causally newer than a local P;
3. active fresh participants omit the generation lower bound and can claim an
   old exact X when resume appends before reserving X;
4. resume-window expiry unregisters lineage but retains the watcher acquisition,
   raw live watcher root, and rescan until the pane eventually stops;
5. insufficient/missing lineage no longer emits the public content-safe
   `resume-fork-ignored` diagnostic; and
6. inactive participants expire only when the last root reference stops, so a
   long-lived sibling retains every stopped participant indefinitely.

Stages 13–15 replace forward patching with recorded red order tests, one
pre-spawn package capability, and a new exact-head gate. Stage 11's unified
evidence graph remains the substrate; the corrective work changes when stronger
evidence becomes authoritative, how ordered observations commit, and when its
content-safe state expires.

The seventh exact-head gate,
`run_813d693c-517f-4c9e-a3df-32d54566b9a5`, completed normally against parent
`91d4a70f`, codex-headless `3e6a019`, and parser `a3fee9d`. Three independent
reviewers and the synthesizer confirmed four remaining blockers: generation A
is discarded before pathname-based physical tailing, prompts can be consumed
before the fresh participant exists during `start()`, supported editing controls
can reconstruct a value different from the exact Codex `0.149.1` composer, and
plain Tab submissions produce no local evidence. The synthesizer rejected the
fixture-provenance privacy concern because the committed corpus contract
explicitly retains those app-local identifiers and timestamps, and it found no
independent parser defect. Stages 22–24 are the approved corrective path; no
implementation begins until the red artifacts in Stage 22 exist.

The eighth exact-head gate,
`run_cafdcd49-8732-4847-9871-0ea8eb4e2f23`, completed normally against parent
`793b1a4b`, codex-headless `6244eac`, and parser `a3fee9d`, with four completed
reviewers, zero retries/stalls/coverage gaps, and a RED synthesizer. It confirmed
five reachable findings: input reconstruction is not bound to composer/modal or
effective keymap/Vim state; whole-screen Tab hints are spoofable and `$`
completion is omitted; Unicode grapheme/word and repeated Ctrl+A/Ctrl+E results
diverge from exact Codex; the public resume preparation is forgeable; and its
enumerable fields retain raw ownership identity after disposal. It rejected an
independent parser defect and parent ownership-policy regression. Stages 25–28
are the approved corrective path; implementation follows only after provider
recordings and the red contracts exist.

Stage 25 is complete. `testing/record-live-prompt-input.mts` exercised the real
installed `codex-cli 0.149.1` binary (SHA-256 `f0d876…fb6c`) through an isolated
`CODEX_HOME`, real node-pty/xterm rendering, real rollout persistence, and a
localhost canned Responses server derived from the exact upstream tag. Ten
sanitized cases independently agree on the durable role-user value and the
request-body value, or agree that neither submission nor request occurred. The
corpus covers trust input, Unicode grapheme/word edits, repeated multiline
bounds, remapped/unbound controls, Vim, history-search Ctrl+C preservation,
popup footer spoofing, and a positive provider-backed Tab queue. Each case
retains private PTY/request/rollout SHA-256 provenance but no raw source. A
separate built-artifact projection records the pre-repair capability's deep-
import construction and enumerable pre/post-dispose identity shape. Stage 26
may now create red contracts from these artifacts; it may not rewrite their
provider outcomes to fit the implementation.

Stages 29 and 30 are complete at codex-headless checkpoint `1c8dbfa`. The real
0.149.1 corpus now contains sixteen cases, including the independently durable
resize, unchanged-redraw, adversarial modal/Vim text, and lower-layer keymap
outcomes. A sanitized `config/read` recording proves the effective keymap and
layer projection without retaining raw configuration; exact upstream hashes
pin the precedence and conflict implementation. Built-package and recorded-
rollout lifecycle artifacts cover CH-01–03 and CH-06–08. Against the pre-repair
package, the focused contracts are red exactly as intended: five lifecycle
failures, five prompt/config failures, and three built-package failures, while
the prior recorded controls and typecheck remain green. Stage 31 may now change
production code; these artifacts and expectations may not be weakened to obtain
green.

Stage 31 is complete at codex-headless `6c6336b`. Synchronous tail acquisition
now retires cleanly only when no stop authority was returned; unresolved live
candidates retain bounded rescan transport while terminal paths are evicted;
and retention projections expose process-HMAC participant fingerprints rather
than raw IDs. Resume rollback authority is a frozen null-prototype dispose-only
handle backed by module-private WeakMap state. Prompt evidence requires a
provider-valid layout epoch and a changed keyed composer/cursor revision, while
bottom-pane structure scopes modal/Vim detection. Finally, the exact Codex
binary resolves `config/read` with the imminent cwd/environment/base arguments;
unsupported versions, extra effective bindings, and legacy managed layers
withhold capability without blocking ordinary terminal launch. Package check is
green at 142/142, the built ninth-gate projection is 3/3, real 0.149.1 safe and
conflicting config/read probes produce the expected allow/refuse outcomes, and
the focused parent launch-binding test is 2/2.

## 9. Tenth-gate corrective stages

The tenth exact-head gate,
`run_ad0813cf-5f8f-4644-971d-e6a9ade71d62`, completed normally against parent
`a057cd69`, codex-headless `6c6336b`, and parser `a3fee9d`. All four agents
completed with zero stalls, retries, provider-circuit failures, or coverage
gaps. The synthesizer independently reproduced and confirmed five blockers:

1. a resume-lineage participant accepts a rollout generation first observed
   before its pre-spawn registration because it inherits the fresh session's
   five-second negative grace;
2. an unchanged raw path cached while unresolved survives when a later exact or
   lineage reservation makes it terminal outside the original read callback;
3. the emitted deep resume module exports the WeakMap unwrapper and therefore
   exposes both raw controller state and lease mutation authority;
4. initialize/config-read messages containing both `result` and `error` are
   accepted as successful attestation responses; and
5. parent resume preparation runs after effective-config attestation, leaving a
   material await in which higher-precedence managed input policy can change
   before the PTY reads it.

The gate rejected predictable request IDs as an independent exploit on the
dedicated stdio channel, retained the ninth gate's rejection of an unrecorded
atomic-paste claim, and found no independent parser defect or duplicate parent
ownership policy. The five confirmed boundaries below are the complete repair
set; unsupported candidates do not become implementation work merely because
they are plausible.

### Stage 33 — freeze the tenth-gate evidence and repair boundaries

- [x] **Produces:** this decomposition plus the immutable workflow artifact
  identified by result SHA-256
  `3e9e67215f71461ee0e2394e463a98acd84bf35796b3e3a27e324ca9527c7acb`.
  The implementation set is named as the five confirmed findings above rather
  than inferred from nearby code.
- **Verified by:** the workflow status reports `completed`, four completed
  agents, zero failed/retrying/stalled agents, and the exact three requested
  heads. Each confirmed item includes a reachable sequence, exact source
  locations, and a minimal repair direction; the synthesizer independently
  replayed the lineage and invalid-envelope failures against emitted JS.
- **Why separate:** editing production while reviewers were still reading the
  shared worktree would have invalidated the exact-head audit. Freezing the
  complete set first also prevents one local conditional from hiding a second
  ownership boundary before its red contract exists.
- **Reality check:** all five items came from the completed read-only gate. The
  lineage and envelope cases were executed against `dist`; the retention and
  ordering cases were traced through the existing recorded watcher/config
  schedules; the deep-export case returned the real private root and owner from
  the emitted module.

### Stage 34 — turn the omitted real sequences into red contracts

- [x] **Produces:** a content-safe tenth-gate finding manifest; recorded-rollout
  system tests for pre-registration lineage and later terminalization; a built-
  artifact deep-export projection; recorded app-server result-plus-error modes;
  and a parent resume-preparation barrier test that switches between the already
  recorded safe and conflicting config projections.
- **Verified by:** against codex-headless `6c6336b` and parent `a057cd69`, the
  new focused contracts fail once for each confirmed finding while the existing
  ninth-gate controls remain green. The failure messages must identify the
  causal sequence, raw transport count, exported unwrapper, invalid response,
  or pre-spawn ordering rather than fail through setup noise.
- **Why separate:** tests written after the repair could simply encode the new
  implementation. The red checkpoint must prove that the current substrate
  actually admits the five exact sequences before any production shape changes.
- **Reality check:** rollout bytes come from
  `subagent-0149-exact-attachment`; configuration values come from the real
  sanitized Codex 0.149.1 `config/read` capture; process ordering comes from the
  parent launch sequence confirmed by the gate. No new prompt, lineage, keymap,
  or protocol outcome is invented.

### Stage 35 — repair the five isolated boundaries

- [ ] **Produces:** strict post-registration sequence admission for resume
  lineage; terminal checks ahead of unchanged-fingerprint transport shortcuts;
  resume issuance and consumption co-located in a runtime module closure with no
  shipped unwrapper; success-envelope validation for both app-server responses;
  and parent launch ordering with resume preparation before the final
  config/read await and synchronous PTY spawn.
- **Verified by:** every Stage 34 red contract turns green without weakening its
  recorded inputs, and all prior first-through-ninth gate tests remain green.
  The built output contains no importable controller/unwrapper; malformed
  envelopes issue no profile; and a recorded fork whose first observation
  precedes registration never receives a resume-lineage lease.
- **Why separate:** coordinator policy, watcher transport, runtime capability
  custody, app-server validation, and parent orchestration have different owners.
  Combining them in one helper would let a transport or launch consumer
  arbitrate ownership and recreate the cross-layer substrate this decomposition
  removed.
- **Reality check:** each repair is the narrow inverse of one confirmed gate
  sequence. Fresh participants retain their recorded file-arrival grace; valid
  app-server responses retain their recorded shape; terminal launch remains
  available when profile authority is refused.

### Stage 36 — verify the release candidate and merge in dependency order

- [ ] **Produces:** clean codex-headless, parser, and parent heads; full local
  package/type/test results; live safe/conflicting config evidence; green GitHub
  checks; a new exact-head four-agent gate with zero findings; and merged
  dependency PRs before parent PR #634.
- **Verified by:** inspect every constituent agent artifact, not only the
  synthesizer preview; require no correctness/privacy/ownership/integration
  finding of any severity; prove the pinned dependency commits are ancestors of
  their default branches after merge; then merge the parent and confirm issue
  #632 closes.
- **Why separate:** local tests, CI, and a happy-path live probe cannot establish
  adversarial ownership safety. Conversely, a review of unpushed or unpinned
  heads cannot authorize a real merge.
- **Reality check:** use the installed Codex 0.149.1 binary and the same sixteen-
  case PTY/request/rollout corpus. The one parent-suite reference to a deleted
  private Claude transcript remains an explicitly unrelated environmental
  failure and must not be deleted or weakened to manufacture green.

### Isolation for Stages 34–36

- Resume lineage causality remains in
  `FreshRolloutOwnershipCoordinator`; watcher/registry code may transport
  immutable observations but may not decide which generation belongs to a
  resume.
- Raw path eviction remains in
  `FreshRolloutOwnershipCoordinatorRegistry`; consumers may not import its
  private caches or retain paths in diagnostics.
- Resume controller state and the sole consumer live in the same runtime module
  closure. The shipped deep preparation module may expose the public dispose-
  only type/factory compatibility surface, but must not export a controller,
  unwrapper, token, WeakMap, or lease mutation operation.
- Effective-input reconciliation remains in `CodexPromptInputProfile`; Agent
  Code may order the attestation immediately before spawn but may not parse or
  arbitrate Codex keymap layers itself.

### Unknowns for Stages 34–36

- Whether preserving the historical deep import of the public preparation
  factory requires a type-only/re-export shim or should be removed as a breaking
  package change; either route must leave no runtime internal export.
- Whether a terminal path should be evicted synchronously from a coordinator
  transition hook or within the next 500 ms maintenance pass. The privacy
  contract requires bounded removal while a sibling watcher remains live, not a
  guessed implementation.
- Whether every filesystem exposes reliable birth time remains unknown. Resume
  admission therefore must use coordinator observation sequence, not wall-clock
  creation time.
- A managed policy can theoretically change in the syscall-sized interval
  between the final successful config/read and `ptySpawn`. There must be no
  intervening application await; eliminating external mutation entirely would
  require provider support for a spawn-bound configuration token.

### Fixture plan for Stages 34–36

- Record the gate run ID, exact heads, result checksum, and five content-safe
  finding IDs under `testing/fixtures/tenth-gate/`.
- Reuse the hashed `subagent-0149-exact-attachment` rollout for both lineage and
  terminalization schedules; mutate only scheduler order, birth/observation
  sequence, and the copied thread ID already allowed by prior gate fixtures.
- Extend the existing deterministic app-server shell around the real sanitized
  config/read projection with invalid result-plus-error envelopes. Preserve the
  real projection as the sole success control.
- Drive parent ordering through a controllable resume-preparation barrier and
  the recorded safe/conflicting projections. The test asserts custody and order;
  it does not invent Codex keymap semantics.

Stage 34 is complete at codex-headless `b160578`. Against the unchanged
production implementation, the two recorded ownership schedules fail on the
pre-registration lineage lease and retained terminal path; the two invalid
success/error envelope modes incorrectly issue a profile; the emitted deep
module still exports the controller unwrapper; and the parent barrier observes
profile attestation before `resume:start`. Existing controls in the same focused
runs remain green. These exact assertions are now the implementation boundary
and may not be weakened or replaced with post-repair literals.
