import { useContext, useRef, useState } from 'react'

import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

// Native in-feed renderer for Claude Code's `AskUserQuestion` tool.
//
// WHY this component exists at all:
//   Claude Code's `AskUserQuestion` tool draws a TUI picker (a numbered
//   list of options) and BLOCKS the agent until the user chooses. In
//   Agent Code that picker only ever surfaced as a dead "work ·
//   AskUserQuestion" WorkIndicator — there was no way to actually answer
//   it without dropping into the raw terminal. This row replaces that
//   dead indicator with a real, clickable picker driven entirely by the
//   already-parsed semantic input.
//
// WHY native answering is enabled for EXACTLY ONE shape — a single,
// single-select question — and nothing else:
//   An `AskUserQuestion` call can carry 1–4 questions. Claude's TUI shows
//   them ONE AT A TIME and auto-advances to the next as each is answered;
//   the tool does NOT resolve until ALL of them are answered. We only know
//   how to send an answer SAFELY when the on-screen picker selects AND
//   submits the WHOLE tool ATOMICALLY on a single digit key — and that
//   only happens in the lone `hideSubmitTab` case: ONE question, NOT
//   multi-select. In that case the options are numbered 1..N (in
//   `parsedInput.questions[0].options` order) and pressing a digit commits
//   the choice instantly — proven live. So to answer the option at 0-based
//   index `i` we write `String(i + 1)` to the PTY via the same `sendInput`
//   keystroke path the terminal uses. No cursor tracking, no arrow-key
//   navigation, no separate "submit" keystroke — one digit does it all,
//   and that atomicity is the entire reason this PR can ship answering
//   without a screen parser: we never read the terminal back.
//
//   Everything else is DEFERRED to the screen-parser PR and rendered
//   read-only here, because the number-key trick breaks:
//     - MULTIPLE questions: a digit answers the CURRENTLY-active question
//       on screen (#1), not the one whose option was clicked in the card.
//       Clicking under question #2 would misroute the answer to #1, and
//       the answering latch would then freeze the card while the terminal
//       still waits for the remaining questions. So we gate answerability
//       on the WHOLE CALL (`questions.length === 1`), never per-question.
//     - MULTI-SELECT: a digit TOGGLES rather than submits, so "number =
//       answer" doesn't hold even for a single question.
//
// WHY this is driven by `parsedInput`, not by parsing the screen:
//   The semantic layer (foldEvent.ts) already parses the full tool input
//   on tool_input_finalized/block_completed into
//   `block.parsedInput = { questions: [{ question, header?, multiSelect?,
//   options: [{ label, description?, preview? }] }] }`. That is the
//   source of truth for what the picker shows; rebuilding it from
//   terminal paint would reintroduce exactly the brittle heuristics the
//   semantic path was built to kill.
//
// SCOPE / deferred follow-ups (intentionally NOT handled here):
//   - multi-question calls: answered one-at-a-time by the live TUI;
//     rendered read-only (see the WHY block above). Deferred to the
//     screen-parser PR.
//   - multi-select: a digit key TOGGLES rather than submits, so the
//     "number = answer" trick doesn't hold. Rendered read-only with a
//     note; answering is a follow-up PR.
//   - free-text answers: the auto-injected "write your own" option needs
//     a text field + a different submit path. Deferred.
//   - screen parsing: explicitly out of scope for this PR.
//
// KNOWN small race (deliberately left open here): if the user answers via
// the TERMINAL instead of clicking, this row stays briefly clickable until
// the tool_result lands and `resultAt` unmounts it — a click in that window
// would send a stray digit to whatever prompt comes next. Gating on a
// SINGLE question shrinks the window (a multi-question call is read-only and
// can't be clicked at all); the screen-parser PR closes it fully by reading
// the live picker state back. No code fix now — documented on purpose.
//
// WHY the row disappears on its own after answering / dismissal:
//   Ownership is decided ONE LEVEL UP in BlockRow, which routes to this
//   component only while BOTH hold: the block is unresolved (`!resultAt`)
//   AND there is a LIVE `claude.ask-user-question` screen signal for the
//   session (AskUserQuestionLiveContext is non-null). When the tool_result
//   lands (`resultAt` set) OR the picker leaves the screen (interrupted /
//   answered in the terminal / turn moved on → the screen parser returns
//   null), BlockRow stops routing here and this row unmounts. We never hide
//   ourselves manually. The live-signal half of that gate is the #289 PR-2a
//   stale-render fix: before it, an interrupted unanswered AskUserQuestion
//   ghosted forever because `!resultAt` alone never cleared.

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]

// Defensive shapes for the parsed input. `parsedInput` is a
// `Record<string, unknown>`. The defensive narrowing here is NOT about
// partial objects: foldEvent.ts populates `parsedInput` only on
// `tool_input_finalized` / `block_completed`, from a fully-parsed object —
// so when it's present it's complete. What we actually guard is the
// NOT-YET-FINALIZED case where `parsedInput` is `undefined` (no finalize
// event has arrived yet), which must degrade to the "Question loading…"
// placeholder rather than throw. Every field is still narrowed at read
// time so an unexpected/malformed payload also degrades gracefully.
type AskOption = {
  label: string
  description?: string
  preview?: string
}

type AskQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// Narrow the loosely-typed `parsedInput` into the questions we know how
// to render. Returns [] when nothing usable has streamed yet so the
// caller can show a compact placeholder instead of an empty card.
function readQuestions(parsedInput: Record<string, unknown> | undefined): AskQuestion[] {
  const questionsRaw = parsedInput?.questions
  if (!Array.isArray(questionsRaw)) return []

  const questions: AskQuestion[] = []
  for (const q of questionsRaw) {
    const rec = asRecord(q)
    if (!rec) continue
    const question = typeof rec.question === 'string' ? rec.question : ''
    const header = typeof rec.header === 'string' ? rec.header : undefined
    const multiSelect = rec.multiSelect === true
    const optionsRaw = Array.isArray(rec.options) ? rec.options : []
    const options: AskOption[] = []
    for (const o of optionsRaw) {
      const orec = asRecord(o)
      if (!orec) continue
      const label = typeof orec.label === 'string' ? orec.label : ''
      if (!label) continue
      options.push({
        label,
        description: typeof orec.description === 'string' ? orec.description : undefined,
        preview: typeof orec.preview === 'string' ? orec.preview : undefined,
      })
    }
    // A question with no parsed options yet isn't answerable; skip it so
    // we keep showing the placeholder rather than an empty option list.
    if (!question && options.length === 0) continue
    questions.push({ question, header, multiSelect, options })
  }
  return questions
}

export function AskUserQuestionRow({ block }: { block: SemanticLiveBlock }) {
  // sessionId is obtained the SAME way every other feed row gets it: via
  // CodeRenderContext, which Feed.tsx wraps the entire render-item list
  // in (`<CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>`).
  // SemanticStreamingTurn → SemanticLiveBlockRow → this row all render
  // inside that provider, so the context value is the live session, not
  // the empty default.
  const { sessionId } = useContext(CodeRenderContext)

  // Local "answering" latch. Once the user clicks an option we send the
  // digit and immediately disable every option, both to give feedback
  // ("Answering…") and to GUARD AGAINST DOUBLE-SUBMIT — a second digit
  // would be interpreted by whatever prompt comes next, not the picker.
  // The latch lives only until the block gains `resultAt` and this row
  // unmounts; we never need to clear it.
  const [answering, setAnswering] = useState(false)

  // Synchronous double-submit guard. `answering` (React state) only drives
  // the VISUAL disabled/"Answering…" affordance — but `disabled` doesn't
  // take effect until the next render, so two clicks dispatched in the SAME
  // tick (e.g. a fast double-click) both pass the `if (answering)` check and
  // fire two `sendInput` digits. The second digit lands on whatever prompt
  // follows the picker → corruption. A ref is read+written SYNCHRONOUSLY at
  // the top of the handler, before any await/sendInput, so the second call
  // in the same tick sees `true` and bails. It only ever latches true once
  // (the row unmounts on `resultAt`), so there's nothing to reset.
  const submittedRef = useRef(false)

  const questions = readQuestions(block.parsedInput)

  if (questions.length === 0) {
    // Input hasn't finished streaming (or arrived malformed). Show a
    // compact placeholder rather than a broken/empty picker.
    return (
      <MarkerRow marker="⏺">
        <div className="text-[13px] leading-[1.65] text-muted italic">
          Question loading…
        </div>
      </MarkerRow>
    )
  }

  // Answerability is a property of the WHOLE CALL, never of an individual
  // question. The number-key answer trick is only safe when Claude's picker
  // selects+submits the entire tool atomically on one digit — which happens
  // ONLY for a single, single-select question (the `hideSubmitTab` case).
  // Any multi-question call (digit answers the live on-screen question, not
  // the clicked one → misrouted) or any multi-select question (digit toggles
  // instead of submitting) is rendered fully read-only. Computed once so the
  // gate can't drift between questions.
  const answerable = questions.length === 1 && !questions[0].multiSelect

  const handleAnswer = (optionIndex: number) => {
    // Synchronous latch FIRST — before the state check — so a same-tick
    // second click can't slip a second digit through (see `submittedRef`).
    if (submittedRef.current) return
    if (answering) return
    if (!sessionId) return
    submittedRef.current = true
    // Atomic select+submit: the on-screen options are numbered 1..N in
    // parsedInput order, and Claude's picker commits the choice the
    // instant a digit is pressed. So the answer for the option at
    // 0-based `optionIndex` is the keystroke `String(optionIndex + 1)`.
    setAnswering(true)
    void window.api.sendInput(sessionId, String(optionIndex + 1))
  }

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-3">
        {questions.map((q, qi) => {
          // readOnly is driven by the WHOLE-CALL `answerable` gate, not by
          // this question alone: a multi-question call makes EVERY question
          // read-only (even single-select ones), because the digit would hit
          // the live on-screen question rather than the clicked one. Only the
          // lone single-select question is clickable.
          const readOnly = !answerable
          return (
            <div key={qi} className="flex flex-col gap-1.5">
              {q.header ? (
                <span className="self-start text-[10px] uppercase tracking-wider text-muted bg-surface-hi rounded px-1.5 py-0.5">
                  {q.header}
                </span>
              ) : null}
              {q.question ? (
                <div className="text-[13px] leading-[1.65] text-ink font-semibold">
                  {q.question}
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                {q.options.map((opt, oi) => (
                  <button
                    key={oi}
                    type="button"
                    disabled={readOnly || answering}
                    onClick={() => handleAnswer(oi)}
                    className={`
                      group flex w-full items-baseline gap-2 rounded border border-border
                      px-2.5 py-1.5 text-left text-[13px] leading-[1.55] transition-colors
                      ${
                        readOnly
                          ? 'cursor-default opacity-80'
                          : answering
                            ? 'cursor-default opacity-60'
                            : 'cursor-pointer hover:border-accent hover:bg-surface-hi'
                      }
                    `}
                  >
                    {/* The number is the load-bearing affordance: it
                        mirrors the on-screen 1..N ordering AND is the
                        exact keystroke we send. */}
                    <span className="flex-shrink-0 text-muted tabular-nums group-hover:text-accent">
                      {oi + 1}.
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-ink">{opt.label}</span>
                      {opt.description ? (
                        <span className="text-[12px] text-muted">{opt.description}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
              {readOnly ? (
                <div className="text-[11px] text-muted italic">
                  {questions.length > 1
                    ? 'This question set is answered one-at-a-time — use the terminal for now'
                    : 'Multi-select — answer in the terminal for now'}
                </div>
              ) : answering ? (
                <div className="text-[11px] text-muted italic">Answering…</div>
              ) : null}
            </div>
          )
        })}
      </div>
    </MarkerRow>
  )
}
