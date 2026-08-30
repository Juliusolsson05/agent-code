# Composer ownership

> Why `occupied / human-draft` keeps happening, and why every fix so far has been
> a mitigation.

## The admission this document exists to make

Three changes shipped toward this problem today. None of them fix it:

| change | what it actually is |
|---|---|
| `CONFIRM_TIMEOUT_MS` 2s → 5s | tuning — makes the failure rarer |
| rollback after an orphaned write | cleanup — we still make the mess |
| `composer-occupied` reason + Clear command | recovery — helps the user escape a state we should not create |

Each is defensible on its own. Together they are three conditionals bolted onto a
substrate that is wrong, which is the exact shape of a system that gets to 70%
and then stops improving. Continuing in that direction produces more of the
same: the next `occupied` report gets another special case.

## A — what exists and is trusted

- **`promptDeliveriesInFlight`** (`sessionManager.ts:2962`). A real, working
  mutual-exclusion lock. `write()` refuses while a delivery holds it.
- **`writeReserved`** (`sessionManager.ts:2996`). The delivery-owned write path.
- **`parseClaudeComposerState`** + `snapshotComposerAttributes`. Correctly
  classify a rendered composer as `empty | drafted | unpainted`, using cell
  attributes so a dim placeholder is not mistaken for typed text.
- **`gate.eval`** in the lifecycle journal. The only artifact that retains the
  detailed verdict; everything downstream collapses it.

All four work. None of them is the problem.

## The root cause

**Claude's composer is a shared mutable buffer with six writers, one lock that
only one writer takes, and no record of who wrote what.**

The writers:

| writer | path | takes the lock? |
|---|---|---|
| prompt delivery | `writeReserved` | **yes** |
| app composer (`send`) | `sendInput` → `write` | no |
| raw terminal view | `AgentTerminalLeaf` → `sendInput` | no |
| terminal panes | `TerminalLeaf` → `sendInput` | no |
| voice dictation | `useComposerDictation` → `sendInput` | no |
| debug inline terminal | `AgentInlineTerminal` → `sendInput` | no |
| phone client | `RemoteServer` → `write` | no |

The lock is **one-directional**. Delivery excludes everyone else for the
duration of a delivery. Nothing excludes the others the rest of the time, and —
critically — **nothing records that they wrote.**

So when the gate later observes characters in the composer, it has no way to
know where they came from. It reconstructs ownership by *classifying rendered
characters*, which cannot answer the only question that matters: **is this
mine, or is it the user's?**

Every symptom follows from that one gap:

- **`human-draft` is a guess.** It means "there are characters here", not "a
  human typed these". Dictation, the phone, a debug terminal, and our own
  orphaned write all produce the identical verdict.
- **The gate cannot ever time out.** A timeout was tried and removed because it
  destroyed real typing. It had to be removed *because the gate cannot tell
  whose text it is* — with ownership known, a stale write of our own could be
  discarded safely and a human draft never touched.
- **Clearing is unreliable.** We do not know what is in there or how much, so
  the press count for a kill is unknowable and the result must be re-observed
  by screen-scraping.
- **The placeholder problem exists at all.** Distinguishing Claude's own dim
  suggestion from typed text requires cell-attribute forensics — necessary only
  because we are inferring authorship from pixels.

This is the "multiple sources must agree on one output" case: authorship is
currently reconciled **inside each consumer**, from rendering, instead of being
established once at the write boundary.

## D — the end state

Agent Code never infers who owns the composer. It knows, because it recorded it
at the moment of writing. Concretely:

- A blocked send always names an attributable cause.
- A composer holding only Agent-Code-authored bytes is recoverable
  automatically, without asking the user to do anything.
- A composer holding human-authored bytes is never touched — the protection
  that exists today does not regress.
- Screen classification becomes a cross-check, not the source of truth.

## Unknowns — what I do not know and must measure

This list is the reason implementation cannot start yet.

1. **What actually puts text in the composer, and how often.** I have 833
   `occupied` verdicts and no idea what wrote them. I have been *guessing*: I
   attributed the user's report to orphaned writes, and review proved 52 of 57
   refusals had no orphaned write on the session. I do not want to guess twice.
2. **Whether the six writers are the complete set.** Enumerated by grep, which
   finds call sites, not dynamic dispatch or future ones.
3. **Whether dictation and the phone client can write while Claude is mid-turn**,
   and what that does to the gate.
4. **Whether an orphan survives a session reload/replace**, and whether the
   composer is re-observed after rehydrate.
5. **What proportion of `occupied` episodes are legitimate** — a user genuinely
   mid-sentence, where blocking is exactly right. If that is most of them, the
   whole fix is a UX problem and not an ownership problem, and this document is
   wrong.

## Stages

### Stage 1 — Composer write journal *(instrumentation; produces nothing visible)*

- **Produces** — a per-session append-only record of every byte written to the
  PTY: timestamp, origin (`delivery` | `app-composer` | `raw-terminal` |
  `dictation` | `remote` | `debug`), byte length, and whether it contained a
  submit. Written at the single choke point every writer already passes
  through (`SessionManager.write` / `writeReserved`), so it cannot miss a
  writer by construction.
- **Verified by** — replaying a session by hand: type in the app composer, type
  in the raw terminal, dictate, send from the phone. Each must appear with the
  correct origin, and the totals must reconcile against `gate.eval` transitions
  in the same run. No later stage is needed to check it.
- **Why separate** — this is the stage that answers every question in
  *Unknowns*. Merged into an implementation, it stops being a measurement and
  becomes a justification for whatever was already built. It also has to exist
  *before* the fix, because afterwards the fix is the substrate and the data can
  no longer contradict it.
- **Reality check** — it *is* the reality check. It is the corpus everything
  else is built from.

### Stage 2 — Attribution catalog *(analysis; produces nothing visible)*

- **Produces** — a written enumeration, from Stage 1 data, of every observed
  cause of a non-empty composer, with frequencies: orphaned delivery, human
  typing in the app, human typing raw, dictation, remote, placeholder
  misclassification, provider-initiated content. Ranked.
- **Verified by** — every `occupied` episode in the recorded window maps to
  exactly one catalog entry. Any episode that maps to none means the catalog is
  incomplete and Stage 3 must not start.
- **Why separate** — this is where "the fix" is chosen. Choosing before the
  catalog exists is what produced today's three patches: I fixed the cause I had
  a recording of, which turned out to be at most 5 of 57 cases.
- **Reality check** — built only from Stage 1 records. No imagined causes.

### Stage 3 — Authorship at the write boundary

- **Produces** — writes carry an origin, and the session records the authorship
  of the current composer content. The gate consumes that instead of inferring
  it. Shape to be decided by Stage 2 — the catalog determines whether this needs
  full content tracking or only a monotonic "last non-delivery write" marker.
- **Verified by** — fixtures replayed from Stage 1 recordings: a composer whose
  content is entirely delivery-authored is recoverable; one with any
  human-authored write is not, and stays blocked.
- **Why separate** — this is the substrate change. Attempting it while
  authorship is still guessed from pixels means building on the thing that is
  wrong.
- **Reality check** — Stage 1 recordings as fixtures.

### Stage 4 — Retire the mitigations that are no longer load-bearing

- **Produces** — a smaller diff than today's. With authorship known, the
  rollback's bounded kill loop may be unnecessary or may become trivially
  correct; the `composer-occupied` reason stays, but "clear it yourself" may
  stop being the primary remedy.
- **Verified by** — the mitigation's own tests either still pass unchanged, or
  are deleted along with the code, deliberately.
- **Why separate** — deleting scaffolding is a decision, not a side effect.
- **Reality check** — same fixtures.

## What is being isolated

Composer authorship. It belongs in **one** place at the write boundary in
`SessionManager`, with a single consumer — the provider gate. Forbidden from
importing it: renderer components, the screen parser, and anything in
`promptDelivery` other than through the session API. If two places decide who
owns the composer, they will disagree, and the disagreement will look like a
rendering bug while being an ownership bug.

## Fixture plan

Stage 1's journal is the fixture source. Tests are written against replayed
real write sequences — not literals typed into a test file. A fixture that was
imagined would encode the same misunderstanding that produced today's patches.

## Status

**Stages 1 and 2 are not written. No Stage 3 code may be written until they
are, and until this document is approved.**

Today's three mitigations stay in place meanwhile: they reduce harm and none of
them block this work. They are explicitly not the fix.
