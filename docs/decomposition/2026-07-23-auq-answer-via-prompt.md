# AskUserQuestion — answer via Esc + XML prompt (a deliberate workaround)

Date: 2026-07-23
Branch: `feat/auq-answer-via-prompt`
Status: **decomposition. No implementation until approved.**

## What this is, in one line

Stop keystroke-driving Claude's AskUserQuestion TUI picker for the cases
that don't work (multi-select, multi-question, free-text). Instead dismiss
the picker with **one Esc** and send the user's choices as a normal prompt
containing **structured XML**. Keep the working single-select keystroke
path as-is.

## This is a workaround, and we are saying so

Answering a tool by cancelling it and then describing the answer in prose is
not how the tool is meant to be completed — Claude records the tool as
*declined* and reads our follow-up message. It works (verified live, below),
it is version-proof, and it is honest as long as the feed says so. But the
"right" long-term answer is a native completion path (a real `tool_result`
carrying the selections). **After this ships we file a GitHub issue —
"complete AskUserQuestion natively instead of Esc+prompt" — referencing this
PR as the workaround it replaces.** That issue is the body we refuse to
leave lying around: the tech debt is tracked, not hidden.

## Why keystroke-driving fails (the thing we are giving up on)

A live multi-agent review drove real `claude` v2.1.218 through node-pty and
confirmed, end to end, that three of four flows are broken and cannot be
cheaply fixed because the TUI is a moving target:

- **Multi-select / multi-question never submit.** Both end on a mandatory
  "Review your answers → Ready to submit? [Submit answers] [Cancel]" screen
  that the driver never presses; it has no `to select…to navigate`
  fingerprint so the parser returns null and the driver reports `ok:true`
  while Claude hangs forever. This screen is new in 2.1.218.
- **Multi-select over-toggles** an unwanted option when its `[ ]` checkbox
  wraps across two physical lines (parser misses the checkbox → `toggled`
  undefined → the reconciliation loop presses it ON and can't confirm OFF).
- **Free-text always times out**: opening "Type something" leaves a footer
  that still matches the picker fingerprint, so the driver never sees the
  field open.

Every one of these is "read a screenshot of text, guess the layout, type a
key, re-read to confirm" — screen-scraping a UI built for human eyes and
fingers, re-broken by each Claude release. We are not going to keep chasing
it per version.

## Live proof the workaround works (already done)

Driven through node-pty against real `claude` v2.1.218:

- **multi-select**: Esc → picker gone, "User declined to answer questions",
  composer ready → sent `<answers>…</answers>` → Claude: *"Got it — I'll run
  unit and smoke checks (skipping integration)."*
- **multi-question (2 questions)**: Esc → sent per-question XML → Claude:
  *"You selected Postgres and Canary deployment."* Correct attribution.
- **single-select**: unchanged, already works via the keystroke driver.

---

## A — what exists and is trusted

| Artifact | Where | Trust |
| --- | --- | --- |
| Full semantic answer model | `readAskQuestions` / `AskQuestion`, `AskUserQuestionRow.tsx` | **Trusted.** `answer*` fields carry the FULL untruncated question/header/label; `q.answerQuestion ?? q.question` etc. is what to serialize. |
| Esc primitive from the row | `feed.sendInput(sessionId, '\x1b')` | **Trusted, already used** in `AskUserQuestionRow.forwardTerminalNavigation` (`:332`). Not gated during a picker (no delivery in flight). |
| Prompt delivery | `feed.deliverPrompt` → `deliverPromptToAgent` → `deliverClaudePrompt` | **Trusted and hardened** (paste-absorb → Enter → durable JSONL acceptance). Already the desktop composer's own submit path. |
| Single-select keystroke resolver | `claude.askUserQuestion.answer` → `driveSingle` | **Trusted for single-select** (both reviewers confirmed live). Kept. |
| Live PTY + proxy capture | node-pty harness; `~/.config/agent-code/proxy/` | **Trusted evidence source.** |

## D — end state (observable)

1. Answering ANY AskUserQuestion from the feed row completes against live
   Claude: single-select via keystroke (as today); multi-select /
   multi-question / free-text via Esc + XML prompt.
2. The feed shows the plan-B answer **honestly** — "answered via message"
   with the choices — never a false green ✓-with-blank-body, never an
   error-styled "response received" for an answer the user gave.
3. The orphaned plan-A driver code (multi/free-text/multi-question) and the
   stale comments across the AUQ surface are **gone**, not left dangling.
4. A tracking issue exists for the native completion path, linking this PR.

---

## The hard part, isolated

**The genuinely hard/risky part is RENDERING, not sending.** Sending is two
primitives we already own. The risk is that dismissing the picker makes the
feed lie, and the transcript cannot distinguish "user abandoned the
question" from "user answered via message" — the decline `tool_result` is
byte-identical either way.

Two false states to defeat (both found by the rendering investigation):

- **Live plane, right after Esc:** `foldEvent.ts:996` (`turn_stopped`)
  stamps `resultAt` with **no content and no `is_error`**, so
  `ClaudeAnsweredQuestionRow` renders a green **`✓` with an empty body** —
  a false "answered".
- **Committed plane, when the decline result lands (`is_error: true`):** the
  row shows `◌` + *"response received — the unrecognized or failed result
  remains visible below"* + a generic **error row** with the raw decline
  text. Reads as failure/abandonment, not as the answer the user gave.

Honest rendering therefore needs a **correlation marker** we set when WE
perform the Esc+prompt for a given `operationId` — analogous to the existing
`AskUserQuestionConditionContext` / `TaskNotificationsContext` side channels
— fed to `ClaudeAnsweredQuestionRow` so it can render "answered via message
→ <the choices>" for both planes. This marker, and the render branch that
consumes it, is the isolated hard part. It lives in the Claude renderer AUQ
components and nowhere else; nothing outside `ask-user-question/` may
synthesize a plan-B answered state.

---

## Stages

### Stage 1 — Capture the real decline `tool_result` (instrumentation)

**Produces** `docs/decomposition/evidence/auq-decline/` holding, from a real
`claude` session driven live: the exact `tool_result` content + `is_error`
value written when an AUQ picker is **Esc-dismissed**, and the transcript
sequence that follows (decline result → our user message), pulled from the
proxy recording under `~/.config/agent-code/proxy/`.

**Verified by** the captured bytes themselves — an actual recorded
`tool_result`, not a guess.

**Why separate** The rendering branch (Stage 4) hinges on the precise shape
of the decline result, and this repo has already been burned once building
AUQ logic from reasoning without a live capture (the reverted parser work).
We capture first. Nothing renders until we know what the wire says.

**Reality check** Real proxy recording + the node-pty harness that already
reproduced the flow.

### Stage 2 — The send sequence (`TileLeaf`, unmount-safe)

**Produces** a function that, for a session, sends Esc, waits until the AUQ
condition has cleared, then delivers the XML prompt — hoisted to `TileLeaf`
(which owns `runtime` and does NOT unmount when the AUQ block resolves), or
made fully fire-and-forget with bounded retry.

**Verified by** the live harness: multi-select / multi-question / free-text
answered end to end, picker closed, correct choices registered, at 80 cols.

**Why separate** This is where the **race** lives and it must be gotten
right in isolation: if `deliverPrompt` fires before the headless re-parses
the dismissed picker, `awaitReadyForPrompt` returns `blocked` and writes
nothing (safe — no corruption — but the answer is lost). The sequence must
gate delivery on the condition clearing (`liveAskUserQuestion === null`) or
retry on `retry-after-resolve`. And the AUQ row **unmounts the instant Esc
cancels the tool**, so the sequence cannot live in the row.

**Reality check** The send-infra map: `feed.sendInput`/`feed.deliverPrompt`
are already wired; `deliverClaudePrompt`'s readiness gate is the safety net;
Esc must precede the delivery reservation (never reintroduce the reverted
"condition write hole").

### Stage 3 — XML serialization (pure)

**Produces** a pure `answersToXml(answers)` — full labels via
`answerQuestion ?? question`, `answerHeader ?? header`, `answerLabel ??
label`; multi-select as multiple values; free-text as text. Plus the
renderer branch that chooses keystroke (single-select) vs Esc+XML
(everything else), keyed on the same `useImmediateSingle` predicate the row
already computes.

**Verified by** a unit test built from **real captured questions** (Stage 1
+ existing corpus), asserting the exact XML for single/multi/multi-question/
free-text, and that out-of-contract calls (>4 questions, >20 options) fall
back rather than emit malformed XML.

**Why separate** The serialization is the one piece with a stable, testable
contract independent of the live TUI; pinning it deterministically means
Stage 2's live runs only have to prove the transport, not the content.

### Stage 4 — Honest rendering ("answered via message")

**Produces** the correlation marker (set at Stage 2's Esc+prompt, keyed by
`operationId`) and the `ClaudeAnsweredQuestionRow` branch that renders
"answered via message → <choices>" for BOTH the live-plane empty-`✓` case
and the committed-plane `is_error` decline — suppressing the generic error
row for a recognized plan-B decline.

**Verified by** Stage 1's captured decline result replayed through the row
(no false `✓`, no error styling), plus driving the real app once.

**Why separate** This is the isolated hard part (see above) and the only
place the workaround is user-visible. Merging it into the send stage would
scatter "is this a plan-B answer?" across components that would then
disagree.

### Stage 5 — Remove the bodies

**Produces** deletion of everything plan B orphans, and correction of every
stale comment, in one cleanup pass:

Delete (submodule `claude-code-headless`, once no caller sends multi/free-
text through `resolveCondition`):
- `driveMulti`, `focusSubmit`, `optionToggled`, `waitForStableTextEntry`,
  `sanitizeFreeText`, `sameScreenQuestion`, both free-text branches of
  `driveSingle`, the multi-answer loop in `resolveAskUserQuestionAnswer`.
- The now-moot `allowTruncated` gating + the multi-select fail-closed test
  (they gate/test code being deleted).
- Dead `snapshotPlain` ctx field.

Delete / fix (agent-code renderer):
- `isFreeTextOption` heuristic (dead under plan B).
- Stale row header claiming multi-select works (`AskUserQuestionRow.tsx:37-50`).
- `AskOption.preview` parsed-but-never-rendered (decide: render it or drop
  the parse).
- The near-dead `AskUserQuestionConditionContext` terminal-nav plumbing
  (only survives if single-select still needs arrow-forwarding — confirm).

Fix comments (both repos):
- "PR-5 / read-only until PR-5" in `askUserQuestion.ts` (the driver shipped).
- "No desktop call site today" on `deliverPrompt` (`SessionFeed.ts`,
  `preload/api/session.ts`) — false since the composer uses it.
- Orphaned `write()` docstring (`sessionManager.ts:1508`).
- The `askUserQuestionDriver.ts` file header claiming it drives multi/
  free-text/multi-question.

**Verified by** `tsc` on both projects, full suites, and `grep` proving the
deleted symbols have no remaining referents.

**Why separate** Cleanup lands only after Stages 2–4 prove the new path
works; deleting the driver before the replacement is verified would strand
us if a stage revealed the decomposition was wrong.

### Stage 6 — File the native-completion issue

**Produces** a GitHub issue "Complete AskUserQuestion natively instead of
Esc+prompt", describing the workaround, why keystroke-driving was abandoned,
and what a native `tool_result` path would need — **referencing this PR**.

**Verified by** the issue existing and linked from the PR.

**Why separate** It's the explicit hand-off of the acknowledged debt; it
happens after merge so it can cite the merged PR.

---

## Sequencing with the in-flight single-select fix

`claude-code-headless#47` / `agent-code#599` (single-select truncated-label
match) is reviewed and confirmed live-correct. Plan B **keeps** the
single-select keystroke path, so #47 is complementary, not superseded — but
Stage 5 deletes the multi-select driver code that #47's `allowTruncated`
gate guards. Cleanest order: **merge #47/#599 first** (single-select fix
stands alone), then plan B branches from there and Stage 5 removes the
multi-select machinery. This needs an explicit merge go-ahead for #47.

## Unknowns

1. **Exact Esc-decline `tool_result` shape** — content + `is_error`. Stage 1
   resolves it. Everything in Stage 4 depends on it. *Highest priority.*
2. **Correlation mechanism** — inject a marker at Esc+prompt time, or
   correlate the immediately-following user message to the `operationId`?
   The marker is cleaner (survives the row unmount, no heuristic), but needs
   a side channel that reaches `ClaudeAnsweredQuestionRow`.
3. **Race handling choice** — observe-then-deliver (gate on condition
   cleared) vs bounded-retry on `retry-after-resolve`. Stage 2 picks based
   on which is simpler to make unmount-safe.
4. Whether single-select still needs `AskUserQuestionConditionContext`
   terminal-nav forwarding, or it can go entirely.
5. Remote/mobile: `deliverPrompt` + `sendInput` are already remote-exposed,
   so the phone gets plan B for free — but the "answered via message"
   rendering must also work in the remote feed. Confirm in Stage 4.

## Fixture plan

| Fixture | From | Used by |
| --- | --- | --- |
| Esc-decline `tool_result` + transcript sequence | Stage 1 proxy capture | Stage 4 rendering tests |
| Real AUQ questions (single/multi/multi-q/free-text) | live harness + corpus | Stage 3 XML tests |
| node-pty end-to-end drive | live harness | Stage 2 transport verification |

All fixtures are captured, never hand-authored. Tests are written before
Stages 3–4 implementations, against those fixtures.
