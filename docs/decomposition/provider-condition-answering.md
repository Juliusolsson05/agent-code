# Provider condition answering — staged decomposition

Date: 2026-07-22
Branch: `fix/provider-condition-answering`
Scope: two reported breakages —
  1. Claude Code **AskUserQuestion** answering from the feed row
  2. Codex **trust dialog** on a new folder

Status: **decomposition only. No implementation until approved.**

---

## Why this needs staging rather than a fix

Both features are screen-scrapers over a TUI we do not control, reconciled
against a second source of truth (semantic transcript for Claude, rollout
metadata for Codex). That is the shape the staged method exists for.

The evidence that forward-patching has already been tried and is failing is
in the code itself. `AskUserQuestionParser.ts` carries, in its own comments,
a chain of conditionals each added to fix the previous one's regression:

- `dividerSeen` scoped to "after at least one numbered row", because the top
  rule was classifying every option as footer → `options: []`
- `chipTotal` accumulated across lines, because a wrapped nav bar counted
  one chip per line and published a stale header
- `sawHeaderChip` split out from `header`, because a null header could no
  longer mean "not reached yet"
- `isNavChrome()`, because a wrapped nav bar's tail became the question
- `firstChipLabel` gating, because latching early captured the wrong question

Five conditionals, each documented as fixing the last one's failure, all in
one parser. The skill's red flag — *"a second conditional means the substrate
is wrong"* — is met several times over. The substrate is: **a single-pass
plain-text line scan is being asked to recover structure that the rendering
already destroyed.**

---

## A — what exists and is trusted

| Artifact | Trust level |
| --- | --- |
| `SessionRecorderManager` + per-folder `events.jsonl` | **Trusted.** Backpressure, size caps, tombstones, already absorbed the #388 OOM lessons. Records 9 allowlisted channels including `session:screen` and `session:conditions`. |
| `session:screen` payload `.plain` | **Trusted and already populated** — 14k+ non-empty frames in single recordings. |
| Semantic `parsedInput.questions` (Claude) | **Trusted.** Durable transcript data, decoded by `readAskQuestions`. |
| `vendor/codex-src/.../onboarding/trust_directory.rs` | **Trusted ground truth** for what Codex paints and which keys it accepts. |
| `test/live/composerDetection.live.test.ts` | **Trusted pattern** for driving a real CLI through `node-pty` + `HeadlessTerminal`. |

## D — end state

1. Answering a Claude AskUserQuestion from the feed row succeeds for
   single-select, multi-select, free-text and multi-question calls, or fails
   with a reason that names what was actually wrong.
2. Opening Codex in an untrusted new folder surfaces a trust prompt that can
   be answered from the UI, and **no other screen ever produces one**.

---

## What the corpus already proves

I mined the existing 52 recordings (1.6 GB) before proposing anything. Two
results, both from real data:

### Finding 1 — Codex condition detection false-positives on arbitrary text. CONFIRMED.

`detectCodexTrustDialog` (and `detectCodexApproval` identically) test
`screen.includes(marker)` against the **whole screen, with no anchoring**.

Scanning the corpus for all three required trust markers found **14 frames
with a full match, and every one of them is a screen of this very
conversation** — an assistant discussing the trust dialog. Same for the
approval titles: 28 frames each for three different titles, all matching the
same frames, because those frames contained a Python list literal holding all
three strings. A real overlay can only ever match one.

So: any agent output that quotes these strings — a code review, a plan, a
paste of `trust_directory.rs`, this document — makes Codex report a live
trust dialog. That condition is in `actionKinds`, so it **blocks keystroke
routing** and paints a modal over a session that is not asking anything.

### Finding 2 — zero real trust dialogs were ever recorded. UNRESOLVED.

Despite the user hitting this repeatedly, the corpus contains **no genuine
trust-dialog frame**. Either onboarding paints before the recorder is
attached, or it never reaches `session:screen`. Unresolved, and it matters
for Candidate A below.

### The reported symptom, corrected

> "As soon as it opens we are fucked: the cancel button does nothing, the
> modal never closes, and accept never works."

So detection **fires**. The failure is entirely in the **answer path**. Every
detection-side hypothesis (wrapped markers, narrow widths) is demoted to a
secondary concern; the wrapped-marker case would produce a *missing* modal,
which is not what is reported.

### A previous attempt already shipped for this exact bug

PR **#574** (`fix/codex-trust-dialog-deadlock`, merged as `dc23c509`) targeted
this deadlock across four commits. Reading them is essential because they
define what is already ruled out:

- `1c2f6d8a` — Codex readiness reports `blocked` when a condition owns the
  screen, instead of looking like an unpainted composer.
- `388537bf` — let condition-resolution writes through the delivery
  reservation.
- `3ff03cc9` — **reverted that**, "drop the dead write hole". The revert
  rationale survives in `sessionManager.write`'s comment: the hole read
  `getConditionSnapshot()` off the session, which no session class
  implements, so it was inert in production and only passed because test
  stubs fabricated the method. Had it worked it would have admitted *every*
  write, not just condition keystrokes.
- `3d61bfa9` — extend blocking to the approval modal.

What #574 actually fixed, in its own words: readiness now resolves on the
first tick, so the delivery reservation is held for under a millisecond
instead of 15 seconds. **Mechanically it narrowed a window. It did not remove
the gate.** `sessionManager.write()` still returns `false` for any external
write while `promptDeliveriesInFlight` holds the session, and the
condition-write exemption was deliberately reverted as unsound.

This is the stalled-attempt signature the method warns about: a real fix,
correctly reasoned, that moved the number without changing the substrate.

### Four candidates for the live failure

Each has a distinguishing observation, which is what Stage 1 must capture.

| # | Candidate | Distinguishing observation |
| --- | --- | --- |
| **A** | **Phantom modal.** The dialog was never real — detection fired on prose (Finding 1). Nothing can answer a dialog that does not exist, and detection re-fires every frame while the text is on screen, so the modal never closes. Explains all three symptoms exactly, and is **proven to occur**. | The captured screen at modal-open contains the markers inside prose, not as a rendered dialog. |
| **B** | **Write still gated.** A delivery is in flight, `write()` returns false, keystrokes vanish. #574 shortened but did not close this. | Write log shows `accepted: false` with reason `delivery-in-flight`. |
| **C** | **Silent drop.** `sendInput` returns `Promise<boolean>`; `CodexTrustDialogModal`'s `onSend` is typed `Promise<void>` and discards it. Any refusal is invisible — which is precisely what "does nothing" looks like. | Write log shows a rejected write with no corresponding UI error. |
| **D** | **Sticky condition.** The answer lands, Codex repaints, but the condition persists (stale snapshot, scrollback, or dedupe), so the modal stays up regardless. | Write log shows `accepted: true` and the screen changes, yet `codex.trust-dialog` remains in the snapshot. |

A and C together would produce exactly the reported triple symptom, which is
why I will not pick one before Stage 1 answers it.

### Upstream ground truth for the real dialog

`vendor/codex-src/codex-rs/tui/src/onboarding/trust_directory.rs`:

- Keys: `1`/`y` → trust, `2`/`n` → quit, `Up/k` `Down/j` move the highlight,
  `Enter` confirms **whatever is highlighted**.
- Our accept sends `'\r'`, correct only while the highlight is untouched;
  our reject sends `'2\r'`, where `2` acts immediately and the trailing
  `\r` is a stray Enter delivered to the next screen.
- The question is one `Paragraph` with `.wrap(Wrap { trim: true })`, so the
  44-character required marker wraps at narrow widths — a false-negative
  path, secondary to the reported bug but real.

## Stages

### Stage 1 — Observation: see the screen AND the write

**Produces**
- A raw-PTY channel in the existing recorder (opt-in, capped), written as
  `pty.bytes` beside `events.jsonl`.
- **A write log, `pty.writes.jsonl`** — one line per inbound write attempt:
  the bytes, the origin (condition action / composer / dictation / raw
  terminal), the boolean `write()` returned, and the refusal reason.
- `docs/decomposition/evidence/` — per scenario, the byte stream, a snapshot
  at the decision frame, and the write log.

**Verified by** replaying `pty.bytes` through `HeadlessTerminal.writeForTest`
and getting a grid matching the captured snapshot; and by every UI click in a
scenario appearing as exactly one line in the write log. Both checks are
self-contained and depend on no parser being correct.

**Why separate — and why the write log is the point of this whole plan**

The reported symptom is *"the button does nothing."* Nothing in the system
currently records whether a keystroke was accepted. `sendInput` returns a
boolean that `CodexTrustDialogModal` discards; `write()` returns `false`
silently; no recorder channel captures inbound writes at all. **We are
debugging a write path with zero write observability.** That is how #574
shipped a correct, well-reasoned fix and left the bug alive: it had no way to
see whether keystrokes were landing, so it fixed the mechanism it could
reason about.

This log is the single artifact that separates candidates A/B/C/D, and it is
worth more than any fix I could write today. It renders nothing on screen,
which is exactly why it is the stage that would otherwise be skipped.

Claude's parser also forces this stage: `detectAskUserQuestion` takes a live
xterm `Terminal`, not a string, so recorded `.plain` text cannot drive it.
Codex's parsers take a string and can already be replayed against the corpus.
That asymmetry is why raw bytes are needed and why this cannot merge into a
fix stage.

**Reality check** Extends `SessionRecorderManager`, whose allowlist comment
explicitly excludes `agent-pty-data` today. Raw PTY is high-volume and this
code path produced the #388 OOM, so the channel is off by default,
byte-capped and tombstoned like its siblings. The write log is low-volume
(human keystrokes) and carries no such risk. **The OOM constraint is not
negotiable and is the main risk in this stage.**

Scenarios, at 60 / 80 / 120 columns:
- Codex first launch in a fresh temp dir, then click Accept; repeat with
  Cancel — the actual reported bug
- The same with a prompt delivery deliberately in flight (isolates B)
- Negative control: an agent printing the marker strings as prose, which must
  produce **no** modal (isolates A)
- Claude: single-select; multi-select; free-text; multi-question; a wrapping
  option label; a wrapping question

### Stage 2 — Catalog: what shapes and what outcomes actually occur

**Produces** `docs/decomposition/evidence/catalog.md` — per observed screen
shape: frequency, what the parser extracted, what it got wrong; and per
answer attempt: which candidate the write log proves.

**Verified by** every row citing a recording id and frame index. No citation,
no row.

**Why separate** This is where the four candidates collapse to the one or two
that are real. Implementing against all four builds machinery for failures
that may not exist, and still misses the ones I have not imagined.

**Reality check** Stage 1 output plus the existing 52 recordings.

### Stage 3 — Codex trust dialog

**Produces** an answer path that is observable, plus anchored detection.
Ordered by what the catalog proves, not by my ranking:

- **Answer path (the reported bug).** Surface the `sendInput` boolean to the
  modal so a refused write becomes a visible error instead of a dead button.
  If the catalog shows candidate B, the fix is a *narrow* condition-write
  exemption — narrow in the way #574's reverted hole was not: keyed to an
  action present in the live snapshot for that session, writing only that
  action's bytes, never a general "conditions are active" bypass. The
  `sessionManager.write` comment already prescribes this exact shape.
- **Deterministic keys.** Accept sends `1`, not `\r` (which confirms whatever
  is highlighted). Reject sends `2` with no trailing `\r`.
- **Verified answers.** Reparse after writing — the discipline the Claude
  driver already has. Codex has no resolver at all today
  (`evaluator.resolveAction` exists; no module implements `resolve`).
- **Anchored detection.** Require the `> You are in <path>` line, the numbered
  option rows and the `Press ⏎ to continue` footer in vertical order within
  the viewport, matched on reflowed text. Kills the proven false positive and
  the wrapped-marker false negative together.

**Verified by** Stage 1 captures: the real dialog detects and answers at all
three widths; the negative control produces no condition; the write log shows
every click accepted.

**Why separate** from Stage 4: different provider, different package,
separately shippable — and this one blocks the user today.

**Reality check** Upstream `trust_directory.rs` for keys and layout; Stage 1
captures for what actually paints and what actually lands.

### Stage 4 — Claude AskUserQuestion

**Produces** a parser that reconstructs structure before classifying, and a
payload contract that stops sending semantic indices as screen numbers.

- Reassemble wrapped label continuation lines before matching, so a label is
  compared whole. (Rule to confirm in Stage 2: continuations indent past the
  `N. ` column.)
- Stop sending `q.options.indexOf(option) + 1` as `number` — that is the
  semantic index being matched against the screen's numbering, and the
  driver's label cross-check turns any divergence into `option-not-found`.
- Give `sameQuestion` a fallback when question and header are both null:
  match on the option-label set, which `sameScreenQuestion` already does.

**Verified by** replaying every Stage 1 Claude capture through the driver
with a fake `write` that records keystrokes, asserting the exact key
sequence. No live CLI needed once the bytes are captured.

**Why separate** from Stage 3: independent provider and package.

**Reality check** Stage 1 captures, including the real multi-question picker
already recovered from the corpus (2 chips → `header: null`, 3 options with
wrapping descriptions, `4. Type something`, divider, `5. Chat about this`).

### Stage 5 — Integration

**Produces** agent-code PR: submodule pointer bumps, `CodexTrustDialogModal`
wired to the new verified actions, `AskUserQuestionRow` payload fix.

**Verified by** `tsc` on both projects, full suite, and a manual run of both
scenarios in the real app.

**Why separate** Submodule pointers cannot bump until the package PRs merge.
Lockfile must be resynced in the same commit — `file:` deps embed package
trees and `npm ci` fails in CI before `tsc` ever runs.

---

## What is being isolated

**The hard part is: turning a painted TUI screen into a set of answerable
actions, and proving a keystroke had its intended effect.**

It stays **provider-local** — `packages/*/src/conditions/` — and is
deliberately **not** unified into a shared framework yet. Both providers need
send-then-reparse verification, and the temptation is to build one driver for
both. Refuse until Stage 2 shows their shapes actually converge; the existing
`askUserQuestionDriver.ts` header already argues this, and inventing the
abstraction from two half-understood cases is how the current parser got five
stacked conditionals.

Forbidden, and to stay forbidden:
- The renderer must not compute keystrokes. It sends semantic intent
  (which option, by label); the provider decides which bytes to write.
  `CodexApprovalModal`'s `OPTION_KEYS` positional array is the anti-pattern.
- Parsers must not be reachable from renderer code.
- No consumer may re-derive liveness from its own screen read.

---

## Unknowns

Non-empty on purpose. Every one of these is a thing I could guess at and
should not.

1. **Why no real trust dialog appears in 52 recordings.** Timing, attach
   order, or a channel that never carries it. Blocks knowing whether the bug
   is detection or observation. *Highest priority.*
2. Whether the trust dialog even reaches `HeadlessTerminal` before the
   session is considered started — Codex emits `ready:false` at `start()`
   and `ready:true` once the server is up, and I have not traced what
   onboarding does to that.
3. Whether the wrapped-marker false negative is real at the widths users
   actually run, or only at widths nobody uses.
4. Whether Claude option-label continuation lines are reliably
   distinguishable from description lines by indentation alone.
5. Which of the six Claude hypotheses actually fire. Possibly one root cause,
   possibly five.
6. Whether `resolveCondition`'s refusal while a prompt delivery is in flight
   (`sessionManager.ts:1661`) contributes to the reported AUQ failures.
7. Whether raw-PTY recording can be made safe enough to ship even opt-in.
   If not, Stage 1 needs a different vehicle and the whole plan shifts.

---

## Fixture plan

| Fixture | Produced by | Used by |
| --- | --- | --- |
| `pty.bytes` per scenario | Stage 1 | Stages 3 & 4 tests |
| `.plain` snapshot at decision frame | Stage 1 | Stage 2 catalog, Codex tests |
| Existing 52 recordings | already on disk | Stage 2, Codex negative controls |
| Negative control (prose quoting markers) | Stage 1 | Stage 3 false-positive test |

Fixtures are captured bytes, never hand-written literals. Tests are written
**before** the Stage 3/4 implementations, against those fixtures.

**Test-policy conflict to resolve:** the standing rule is no new test files
in fix PRs. These fixes are worth nothing without recorded fixtures, and both
packages already have a `test:live` tier built for this. Proposal: fixtures
and tests land in the **two submodule PRs only**, nothing new in agent-code.
Needs an explicit ruling before Stage 3.

---

## Sequencing and cost

| Stage | Estimate |
| --- | --- |
| 1 — recorder + captures | 1 day (half of it on the OOM-safety constraint) |
| 2 — catalog | half a day |
| 3 — Codex trust | half a day |
| 4 — Claude AUQ | 1 day |
| 5 — integration | half a day |

Stage 3 can ship on its own once Stages 1–2 are done, and should, because the
false-positive finding is live in production today: any agent that prints
those strings blocks its own pane behind a phantom trust modal.

---

# Outcome — what the experiments settled

Written after implementation. The decomposition above is left as it was so
the reasoning that led here stays legible; this section records which parts
survived contact with a real PTY.

## Method actually used

A throwaway `node-pty` probe spawned real `codex-cli 0.145.0` in a fresh temp
directory, fed bytes into an `@xterm/headless` grid, and reported both the
parsed state and what happened after a keystroke. Run at 120/80/60/50
columns. Scripts were temporary and are not committed; the captures they
produced are what the fixes were built against.

## Hypotheses killed by experiment

- **Wrapped markers break detection.** DISPROVEN. Detection held at every
  width down to 50 columns — the paragraph wraps *after* the opening phrase.
  I would have "fixed" this without the probe.
- **The keystrokes are wrong, so nothing happens.** DISPROVEN as the cause.
  Against a real dialog, `\r`, `1`, `2` and ESC all did exactly what upstream
  documents. The bytes were never the reason clicks did nothing — though two
  of them were wrong for a different reason, see below.

## The actual root cause — none of A/B/C/D

The four candidates all assumed the write reached `sendInput` and was refused
somewhere below it. It was not: **the write was never attempted.**

`TileLeaf.send` — the callback wired to every condition view's `onSend` —
opens with a readiness gate:

```ts
if (!runtime.inputReady || runtime.processStatus !== 'started' || isSessionExited(runtime)) {
  await workspace.ensureSessionLive(sessionId)
}
```

A live provider condition is precisely the state that clears `inputReady`.
Codex reports `blocked` whenever a modal owns the screen (`blockingCondition`,
added by #574); Claude reports not-ready whenever a permission prompt is up.
So every click on the trust modal took the wake path instead of writing a
keystroke — and before #597 that wake adopted the live backend, waited 30s for
a readiness that could not arrive while the unanswered modal held the screen,
then killed the process.

That is the reported triple symptom exactly: accept does nothing, cancel does
nothing, the modal never closes — because the one keystroke that would dismiss
it was never written.

**Condition keystrokes were routed through the composer's send path, gated on
the very flag that conditions clear.** Neither #574 nor #597 could have found
this; both were looking below `sendInput`.

## What shipped

1. `sendConditionKey` in `TileLeaf` — condition views no longer go through the
   composer's readiness gate. A visible condition is proof the backend is alive,
   so there is nothing to wake. A refused write now raises a toast instead of
   being discarded.
2. Structural anchoring for the Codex trust dialog, killing the corpus-proven
   false positive.
3. Deterministic trust keystrokes: accept `1` (not `\r`, which confirms
   whatever is highlighted), decline `2` (not `2\r`, whose Enter leaked into the
   next screen).
4. Three AskUserQuestion answer-matching fixes: option number demoted to a hint,
   wrapped labels rejoined, `sameQuestion` given an option-set fallback.

## Unknowns that remain open

- **Finding 2 is still unexplained.** 52 recordings contain no genuine trust
  dialog. The root cause above explains the symptom without needing it, but the
  observation gap is real and would still hide the next bug of this shape.
- **The write log was not built.** The root cause was found by reading the send
  path once the keystrokes were exonerated, so the instrumentation stage was
  not needed to ship. It remains the right way to see this class of failure and
  is the obvious follow-up.
- The Claude AUQ fixes are verified by construction and the existing suite, not
  against a live multi-question picker — the corpus capture was used as the
  reference shape. A live AUQ probe is the natural next step.
