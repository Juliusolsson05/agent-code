# Answering an OpenCode question, not only rejecting it

Implementation plan for #1025. Written before the code, per the branch
convention.

## A — what exists and is trusted

- `LiveStateProjector.questionFromPayload` sets `metadata: payload` — the
  **whole raw question payload**, which carries `questions[]`, each with
  `question`, `header` and `options[{label, description}]`.
- `opencodeSession.foldQuestion` builds exactly one action, `Reject`, and its
  comment says *"opencode's question payload carries no parsed option list at
  this seam"*. **That is stale and is the reason this shipped reject-only.**
  The options are right there in `state.metadata`, which is how the permission
  view already reads `metadata.command` and `metadata.always`.
- `LiveServerClient.rejectQuestion` → `POST /question/{id}/reject`.
- The recorded fixture
  `packages/opencode-terminal-headless/testing/fixtures/live/question-reject.json`
  holds a real one-question payload with two options.

### Verified against the shipped binary, not the vendored source

The vendored checkout is 1.14.39 and the runtime is 1.18.31, so the repo's rule
is to confirm against the binary. Both agree here:

- `strings` on `out/main/runtime/opencode/darwin-arm64/opencode` contains
  `/question/:requestID/reply` and `/question/:requestID/reject`.
- The handler takes `{ requestID, answers }`, and the schema documents
  `answers` as *"User answers in order of questions (each answer is an array of
  selected labels)"* — positional per question, labels not indices.
- The package's own conditions test already records the resulting event as
  `question.replied` with `answers: [['Yes']]`.

## D — observable end state

1. A question renders its header, text and options, one block per question.
2. Choosing an option answers it; the turn unblocks. Reject still works.
3. A multi-question prompt is answered as ONE set, in question order.
4. A renderer can never post a label OpenCode did not offer.

## The trust boundary, and why the view gains state

Today the runtime owns the action list and the view is dumb — deliberately:
*"the runtime is the single source of truth for which choices exist"*.

A single question fits that perfectly: one action per option, one click, done.

A multi-question prompt does not. `answers` is positional and submitted once,
so the user must choose per question and then submit — which is selection
state, and selection state can only live in the view.

So the split is:

- **State** gains the parsed `questions[]`. The view renders from a typed
  field instead of re-parsing `metadata`, so the parsing rule stays in one
  place.
- **Actions** keep their meaning: one per option when there is exactly one
  question (immediate answer), plus `Reject`. For several questions the view
  composes a `QUESTION_REPLY` payload.
- **The runtime validates** every submitted label against the options it
  actually published, and requires one answer per question, before posting.
  That is what keeps the boundary: the view may *compose* a choice, never
  *invent* one.

## Stages

### Stage 1 — parse the payload once, in the runtime
- **Produces:** `OpencodeQuestionState.questions`, parsed from
  `metadata.questions[]`, plus per-option actions for the single-question case.
- **Verified by:** a runtime test driving `foldQuestion` with the recorded
  fixture payload.
- **Why separate:** it is the only place that may interpret provider JSON, and
  everything below consumes its output rather than the raw payload.
- **Reality check:** `question-reject.json`.

### Stage 2 — reply, with validation
- **Produces:** `LiveServerClient.replyQuestion`, the headless
  `QUESTION_REPLY` action, and the session resolver that validates labels and
  arity before posting.
- **Verified by:** package tests against the recorded stream; a session test
  proving an unknown label is refused.
- **Why separate:** the trust boundary lives here, and it must hold whatever
  the view does.

### Stage 3 — render the blocks
- **Produces:** the question view: header + text + options per question,
  immediate answer for one question, selection + Submit for several.
- **Verified by:** a renderer test driving the real view from the recorded
  fixture.

## Unknowns

- Whether a multi-question prompt occurs in practice. The schema and the
  positional `answers` array say it can; no recording of one exists. The
  multi-question path is therefore built from the SCHEMA, and its test says so
  rather than pretending to be a recording.
- Whether any option set is multi-select (the answer is an array of labels, so
  the wire allows it). Nothing observed emits more than one, so the view picks
  one per question and the wire shape still carries an array.

## Fixture plan

`question-reject.json` is the real recorded payload and drives Stages 1 and 3.
Stage 2's package test uses the same recorded stream. The multi-question case
has no recording and is built as a schema-derived case, labelled as such.
