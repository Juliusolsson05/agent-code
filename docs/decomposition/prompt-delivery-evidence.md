# Prompt delivery is a single-witness trial — decomposition

**Status: awaiting approval. No implementation may start until the stages below
are approved.** (staged-decomposition applies: ~200k LOC, multiple data sources
that must agree on one verdict, and the last two attempts at this bug family
were forward patches on the wrong substrate.)

Supersedes the *stages* of `composer-ownership.md`. That document's Stage 1
(the write journal) shipped in PR #689 and stands; its later stages assumed the
dominant failure was an unattributed composer writer, and the evidence below
shows it is not. Its corrected findings (the writers table, the condition
resolver bypass) remain valid inputs here.

---

## 1. The proven facts

Every claim in this section is anchored to an artifact on disk. Nothing in
this section is inferred.

**F1 — `never-owned`: fixed.** A hibernated agent placed in a Grid Dispatch
lane without a wake. 16 refusals in run `2026-08-30T20-05-09-879Z`, all one
session, `registryHit=false reason=never-owned`. Fixed by #691 (merged
2026-08-30 20:54); the next run had 33/33 submits succeed. Closed as #690.

**F2 — the composer-state latch: proven, unfixed.** `composerState` is cached
in `ClaudeCodeHeadless` and recomputed only when `HeadlessTerminal` emits a
`screen` frame. The frame gate compares **text only** (deliberately —
attribute-aware comparison at 60Hz is the CPU regression of agent-code#390).
A styling-only transition (draft text replaced by a byte-identical dim
placeholder) emits no frame, so the cached `drafted` verdict never updates.
`HeadlessTerminal.ts`'s own comment says the staleness is absorbed by "the
prompt gate's bounded-staleness rule" — **which was deleted the same day the
comment was written**: gate commit `58d7d851` ("drop the prompt-gate staleness
bound, it destroyed drafts", 2026-07-19) vs headless commit `0058e76` (same
date). Reproduced against the real classes: live buffer `empty`, cached
verdict `drafted`, one frame emitted. Repro preserved at
`scratchpad/composer-latch-repro.test.ts` (session scratchpad; must become a
committed fixture in Stage 3).

**F3 — the false `acceptance-timeout`: proven, unfixed, and NOT a latency
problem.** Session `88c29f92`, run `2026-08-30T20-58-30-122Z`, user debug
bundle `2026-08-30T22-07-43-944-88c29f92` (user note: *"the fucck did it send
the propmt but not clear the composer?"*):

```
22:07:38.114  submit.begin
22:07:38.150  Claude JSONL: queue-operation entry carrying the prompt
22:07:38.430  Claude JSONL: user entry carrying the prompt (505 chars)
   (proxy dump: the prompt text present in a POST /v1/messages body)
22:07:58.168  submit.result ok=false code=acceptance-timeout
              bodyWritten=true enterWritten=true retryable=false
```

The durable entry existed **316ms** after `submit.begin`. The waiter had
**19.7 seconds** to observe it and never fired. The delivery succeeded end to
end — PTY, Claude, API — and we reported failure, restored the draft into the
local composer, and armed the resend guard ("Claude may already have this
prompt"). Every visible symptom is downstream of one wrong verdict.

Context that matters: Claude was **mid-turn** (previous submit 22:07:15.663,
tool results still landing at 22:07:56). The prompt therefore went through
Claude's queue path — hence the `queue-operation` entry at .150 before the
`user` entry at .430.

**F4 — corpus counts.** Across all 50 journal runs: 1475 submits ok, 104
failed. Failure shapes: 73 × `not-ready before-write` (16 of which are F1),
21 × `acceptance-timeout after-enter bodyWritten=true enterWritten=true`,
10 × `absorption-timeout`, 1 × `threw`. Separately: 890 `human-draft` gate
verdicts, of which the 32 matchable against recordings all showed genuine
typed text — the gate's *classification* is usually right; F2 is about its
*freshness* and F3 is about the delivery verdict, not the gate.

**F5 — dead theories, kept so they stay dead.** (a) Screen-text misparse of
scrollback: 122,906 recorded Claude frames, 15 `drafted` calls not explained
by chrome — all real typed text. (b) Attribute sampler null via missing
divider: reproducible in isolation, but all 119,346 recorded composer frames
have a divider; never fires in production. (c) The npm `> banner` marker
collision: real, but observed only on a Codex pane; Claude's gate never ran
on it. (d) "Orphaned writes cause the refusals": review showed 52/57 refusals
had no orphaned write. The orphan-rollback work in PR #689 remains correct as
hygiene; it is not the fix for this family.

## 2. The root cause

**Delivery outcome is decided by a single witness, and both of the app's
verdicts share the flaw.**

*Acceptance* trusts exactly one channel: a JSONL ingest callback whose match
must survive four filters — ingest-cursor ordering, an `entryTimestamp <
armedAt` rejection, image-count congruence, and byte-level canonical text
equality — against an entry whose schema Claude changes between versions and
whose shape differs on the queue path. When any filter mis-fires, there is no
second witness to overrule it, so a **successful delivery is reported failed**
after an arbitrary timeout. The app already possesses at least three other
independent witnesses at that moment — the composer visibly emptied on
screen, a `queue-operation` entry, the turn/stream lifecycle — and consults
none of them.

*The gate* trusts exactly one witness too: a cached screen parse whose refresh
is text-gated, with a safety net that no longer exists (F2).

**Why "fix the timing" is the wrong frame.** A timeout on a mis-firing witness
has no good value: shorter means more false failures, longer means the user
stares at a stuck composer longer before the same false failure. F3's entry
arrived in 316ms — the 20s budget was already 60× too generous and still
failed, because the waiter was never going to match. More witnesses, not more
time.

**Prior art already in-tree, to build on rather than beside:** the headless
`liveOwner` already models "done but not yet durable" (reconciling) for
assistant turns. Prompts deserve the same ladder: *written → observed →
durable*. Today delivery collapses all three into one boolean behind one
timer.

## 3. Unknowns — measured before code, each from recorded data

1. **Why did F3's waiter miss?** Candidates, each testable: (a) the
   `entryTimestamp < armedAt` guard rejecting an entry that raced arming on
   the queue path; (b) queue-operation schema drift — the entry at line 733 of
   transcript `47211034` yields no text through the current extractor;
   (c) canonicalisation mismatch on the 505-char body; (d) the tail follower
   not delivering the callback at all. Measured by replaying the *actual
   transcript slice* through the *actual ingest + matcher* with the waiter
   armed at the journal's timestamps.
2. **How many of the 21 timeouts are false?** For each: does the prompt text
   exist in the provider transcript, at what timestamp, in what entry type?
   Label every one: `false-failure/<filter>`, `true-failure`, `unknown`.
3. **Same for the 10 absorption-timeouts.**
4. **How often is "composer emptied after Enter" observable, and how fast?**
   Validate the proposed second witness against recorded screen frames
   following each successful submit.
5. **Latch trigger frequency (F2).** Recordings store no cell attributes, so
   this is unmeasurable today — Stage 1b adds the attribute descriptor to
   `gate.eval` and to recordings.
6. **Queue-path shape inventory.** What Claude 2.1.207 writes for a prompt
   submitted mid-turn, from real transcripts, not docs.

## 4. Stages

### Stage 0 — Ground-truth labeler *(tooling only; no app change)*
- **Produces** — a script (`scripts/debug/label-delivery-outcomes.mjs`) that
  joins journal `submit.*` events against provider transcripts and proxy
  dumps, and emits one labeled row per failed submit; plus the labeled corpus
  committed as a doc table. Fixture extraction for Stages 2–3 falls out of it:
  the tool snapshots the transcript slice + journal window for each case.
- **Verified by** — the F3 row must label itself from disk alone with the
  cause category U1 resolves to. Every one of the 21+10 rows gets a label or
  an explicit `unknown`.
- **Why separate** — it answers U1–U3 and U6 before any engine is designed;
  merged into the implementation it becomes a justification for it.

### Stage 1b — The missing witnesses become observable *(instrumentation)*
- **Produces** — `acceptance.arm` / `acceptance.match` / `acceptance.miss`
  journal events carrying the four filter inputs (cursor, armedAt,
  entryTimestamp, canonical-equality) so a dropped match names the filter that
  dropped it; the composer attribute descriptor `{dim,inverse,plain}` attached
  to `gate.eval` and to session recordings (closes U5's measurement gap).
- **Verified by** — replaying one live session end to end: every submit shows
  arm→match; a forced mid-turn submit shows the queue-path event sequence.
- **Why separate** — PR #689's Stage 1a journaled the *writers*; this journals
  the *judges*. Together they make the next false verdict diagnosable in
  minutes from disk, which is the property that found F1 and F3.

### Stage 2 — Acceptance becomes an evidence ledger *(the fix)*
- **Produces** — per-delivery evidence record with independent witnesses:
  `jsonl-user`, `jsonl-queue`, `screen-composer-emptied` (post-Enter
  transition, distinct from the pre-write gate), `turn-started`. A verdict
  function over the ledger replaces the single waiter: *durable* (JSONL) >
  *observed* (screen + turn) > *unconfirmed*. The verdict may **upgrade after
  reporting** — report `delivered (observed)` fast, upgrade to `durable` when
  the entry lands, raise a reconciliation flag (journal + pane surface) if it
  never does. `PromptDeliveryResult` widens to carry the witness set;
  today's boolean callers read `ok = observed-or-better`. Draft restore and
  the resend guard key off the ledger: restore only on `unconfirmed`.
- **Verified by** — Stage 0's fixtures replayed through the real engine: the
  F3 slice MUST verdict `delivered`, and every row Stage 0 labeled
  `true-failure` must stay failed. No imagined cases: each labeled row is a
  fixture.
- **Why separate** — it is the substrate change; entangled with Stage 3 it
  becomes unreviewable, and its correctness is provable purely against
  recorded data.

### Stage 3 — Gate verdict freshness *(kills F2)*
- **Produces** — gate-time recomputation from the live buffer at decision
  points (submit, publish), removing the trust in the frame-gated cache; the
  60Hz cost stays paid-per-decision, not per-frame, so #390 does not return.
  The stale `HeadlessTerminal` comment is corrected to describe the actual
  contract.
- **Verified by** — the latch repro (promoted from scratchpad into
  `ScreenParser.composer.test.ts`) flips from red to green; plus attribute
  fixtures recorded via Stage 1b.
- **Why separate** — different defect, different package (headless), different
  blast radius; and Stage 1b's data may show it fires rarely, which changes
  its priority but not its correctness.

### Stage 4 — The renderer stops lying *(UX truthfulness)*
- **Produces** — local composer clears on `observed`; the resend banner
  states which witness blocked it and offers "verified in transcript — send
  again" only when the ledger can prove receipt; toasts describe what was
  done, not what was hoped.
- **Verified by** — renderer tests driven by ledger fixtures from Stage 0.
- **Why separate** — pure consumer of Stage 2's contract; doing it first
  (the earlier Clear-command toast) is how we shipped a dishonest string.

## 5. Rejected as tape

- **Raise the acceptance timeout** — F3 failed with 60× headroom; time was
  never the variable.
- **Retry on timeout** — retrying a delivery that succeeded double-sends; the
  resend guard exists precisely because this was learned once already.
- **Clear the local composer on `enterWritten`** — Enter reaching the PTY is
  not receipt; on a true failure this destroys the draft (the exact data-loss
  class that got the staleness bound deleted).
- **Re-add a time-based gate staleness bound** — already tried, reverted for
  destroying drafts (`58d7d851`); elapsed time cannot distinguish "misread"
  from "user thinking".

## 6. Fixture sources (real data only)

- Journal runs: `incidents/runs/2026-08-30T20-58-30-122Z-*` (F3),
  `2026-08-30T20-05-09-879Z-*` (F1), plus the runs holding the other 20
  acceptance-timeouts (enumerated by Stage 0).
- Provider transcript: `~/.claude/projects/...-agent-code/47211034-*.jsonl`
  lines 733–740 (queue-operation + user entry pair).
- Debug bundle: `debug-bundles/manual/2026-08-30T22-07-43-944-88c29f92`
  (proxy body proof + state snapshot).
- Session recordings: `session-recordings/2026-08-30T*` for U4/U6.
- Latch repro: session scratchpad `composer-latch-repro.test.ts` → Stage 3.
