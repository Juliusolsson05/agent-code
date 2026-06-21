import { useContext, useState } from 'react'

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
// WHY we answer single-select by sending the option's NUMBER to the PTY:
//   Claude's on-screen picker renders the options numbered 1..N (in the
//   same order they appear in `parsedInput.questions[].options`), then an
//   auto-injected free-text entry and a footer that we deliberately
//   ignore. The picker selects AND submits ATOMICALLY when a digit key is
//   pressed — proven live. So to answer the option at 0-based index `i`
//   we write the string `String(i + 1)` to the PTY via the same
//   `sendInput` keystroke path the terminal uses. No cursor tracking, no
//   arrow-key navigation, no separate "submit" keystroke — one digit does
//   the whole thing. That atomicity is the entire reason this PR can ship
//   single-select answering without a screen parser: we never need to
//   read the terminal back to know where the cursor is.
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
//   - multi-select: a digit key TOGGLES rather than submits, so the
//     "number = answer" trick doesn't hold. Rendered read-only with a
//     note; answering is a follow-up PR.
//   - free-text answers: the auto-injected "write your own" option needs
//     a text field + a different submit path. Deferred.
//   - screen parsing: explicitly out of scope for this PR.
//
// WHY the row disappears on its own after answering:
//   An UNRESOLVED block (`!block.resultAt`) means the picker is LIVE and
//   awaiting the user. When the tool_result lands, `resultAt` is set and
//   BlockRow stops routing to this component, so the row unmounts. We
//   never hide ourselves manually — ownership is decided one level up.

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]

// Defensive shapes for the parsed input. `parsedInput` is a
// `Record<string, unknown>` that may be PARTIALLY streamed (foldEvent
// can populate it mid-flight), so every field is narrowed at read time
// rather than trusted. A malformed / half-arrived payload must degrade
// to a "loading" placeholder, never throw.
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

  const handleAnswer = (optionIndex: number) => {
    if (answering) return
    if (!sessionId) return
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
          // multiSelect deferred: a digit key toggles instead of
          // submitting, so the number trick is unsafe here. Render the
          // options read-only and tell the user to use the terminal.
          const readOnly = q.multiSelect
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
                  Multi-select — answer in the terminal for now
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
