import { useContext, useRef, useState } from 'react'

import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'

import {
  AskUserQuestionConditionContext,
  CodeRenderContext,
} from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import type { ConditionCustomAction } from '@shared/types/providerConditions'

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
// WHY answering is split between semantic payload and live screen state:
//   An `AskUserQuestion` call can carry 1–4 questions. Claude's TUI shows
//   them ONE AT A TIME and auto-advances to the next as each is answered;
//   the tool does NOT resolve until ALL of them are answered. The semantic
//   tool input is the right source for what the user is choosing (question
//   text, option labels, descriptions) because it is durable transcript data.
//   The live terminal is the right source for HOW to choose it right now
//   (which question is currently on screen, which number maps to which option,
//   which multi-select boxes are toggled, whether Submit is focused).
//
//   This row therefore dispatches a structured custom action:
//     semantic answer labels/text → main IPC → Claude headless resolver
//   The resolver drives the real TUI one step at a time and reparses after each
//   keystroke. That is why multi-select, free-text, and multi-question are now
//   clickable without the renderer guessing terminal numbers from stale state.
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
// WHY the screen condition gates CLICKABILITY, not rendering:
//   The row renders while the semantic tool block is unresolved. That is
//   transcript-backed and flicker-immune. The screen-derived
//   `claude.ask-user-question` condition is only an answerability signal: when
//   the latest snapshot positively lacks the picker, controls disable so a late
//   click cannot send a stray digit to the next prompt. Unknown/transient state
//   stays clickable to avoid turning parser flicker into UI flicker.
//
// WHY the row disappears on its own after answering:
//   An UNRESOLVED block (`!block.resultAt`) means the picker is LIVE and
//   awaiting the user. When the tool_result lands, `resultAt` is set and
//   BlockRow stops routing to this component, so the row unmounts. We
//   never hide ourselves manually — ownership is decided one level up.

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
  const liveAskUserQuestion = useContext(AskUserQuestionConditionContext)

  // Local "answering" latch. Once the user clicks an option we send the
  // digit and immediately disable every option, both to give feedback
  // ("Answering…") and to GUARD AGAINST DOUBLE-SUBMIT — a second digit
  // would be interpreted by whatever prompt comes next, not the picker.
  // The latch lives only until the block gains `resultAt` and this row
  // unmounts; we never need to clear it.
  const [answering, setAnswering] = useState(false)
  const [selectedByQuestion, setSelectedByQuestion] =
    useState<Record<number, string[]>>({})
  const [textByQuestion, setTextByQuestion] = useState<Record<number, string>>({})

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
  const pickerKnownGone = liveAskUserQuestion === null

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

  const buildAction = (
    answers: Array<{
      question: string
      header?: string
      multiSelect?: boolean
      selectedLabels?: string[]
      text?: string
    }>,
  ): ConditionCustomAction => ({
    kind: 'custom',
    id: 'answer-ask-user-question',
    label: 'Answer',
    name: 'claude.askUserQuestion.answer',
    payload: { answers },
  })

  const dispatchAnswer = (action: ConditionCustomAction) => {
    // Synchronous latch FIRST — before the state check — so a same-tick
    // second click can't slip a second digit through (see `submittedRef`).
    if (submittedRef.current) return
    if (answering) return
    if (!sessionId) return
    if (pickerKnownGone) return
    submittedRef.current = true
    setAnswering(true)
    void window.api.resolveCondition(sessionId, action).then(result => {
      if (!result.ok) {
        // Let the user try again when the structured driver reports a bounded
        // failure. The old single-keystroke path latched forever because there
        // was no meaningful recovery signal; the driver can now say "timeout" or
        // "option not found" without corrupting the terminal, so keeping the row
        // interactive is the safer failure mode.
        submittedRef.current = false
        setAnswering(false)
      }
    })
  }

  const handleSingleOption = (questionIndex: number, option: AskOption) => {
    const q = questions[questionIndex]
    if (!q) return
    dispatchAnswer(
      buildAction([
        {
          question: q.question,
          header: q.header,
          multiSelect: q.multiSelect,
          selectedLabels: [option.label],
        },
      ]),
    )
  }

  const toggleOption = (questionIndex: number, label: string) => {
    setSelectedByQuestion(prev => {
      const current = prev[questionIndex] ?? []
      const next = current.includes(label)
        ? current.filter(item => item !== label)
        : [...current, label]
      return { ...prev, [questionIndex]: next }
    })
  }

  const submitStructuredAnswers = () => {
    const answers = questions.map((q, qi) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect,
      selectedLabels: selectedByQuestion[qi] ?? [],
      text: textByQuestion[qi]?.trim() || undefined,
    }))
    dispatchAnswer(buildAction(answers))
  }

  const structuredReady = questions.every((q, qi) => {
    const selected = selectedByQuestion[qi] ?? []
    const text = textByQuestion[qi]?.trim() ?? ''
    if (q.multiSelect) return selected.length > 0 || text.length > 0
    return questions.length === 1 || selected.length > 0 || text.length > 0
  })
  const useImmediateSingle = questions.length === 1 && !questions[0].multiSelect

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-3">
        {questions.map((q, qi) => {
          const selected = selectedByQuestion[qi] ?? []
          const controlsDisabled = answering || pickerKnownGone
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
                {q.options.map((opt, oi) => {
                  const isSelected = selected.includes(opt.label)
                  const immediate = useImmediateSingle
                  return (
                    <button
                      key={oi}
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() =>
                        immediate
                          ? handleSingleOption(qi, opt)
                          : q.multiSelect
                            ? toggleOption(qi, opt.label)
                            : setSelectedByQuestion(prev => ({
                                ...prev,
                                [qi]: [opt.label],
                              }))
                      }
                      className={`
                        group flex w-full items-baseline gap-2 rounded border px-2.5 py-1.5
                        text-left text-[13px] leading-[1.55] transition-colors
                        ${
                          isSelected
                            ? 'border-accent bg-surface-hi'
                            : 'border-border'
                        }
                        ${
                          controlsDisabled
                            ? 'cursor-default opacity-60'
                            : 'cursor-pointer hover:border-accent hover:bg-surface-hi'
                        }
                      `}
                    >
                      <span className="flex-shrink-0 text-muted tabular-nums group-hover:text-accent">
                        {q.multiSelect ? (isSelected ? '[x]' : '[ ]') : `${oi + 1}.`}
                      </span>
                      <span className="flex flex-col gap-0.5">
                        <span className="text-ink">{opt.label}</span>
                        {opt.description ? (
                          <span className="text-[12px] text-muted">{opt.description}</span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
                {!useImmediateSingle ? (
                  <input
                    value={textByQuestion[qi] ?? ''}
                    disabled={controlsDisabled}
                    onChange={event =>
                      setTextByQuestion(prev => ({
                        ...prev,
                        [qi]: event.target.value,
                      }))
                    }
                    placeholder="Type something"
                    className="mt-1 rounded border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-60"
                  />
                ) : null}
              </div>
            </div>
          )
        })}
        {!useImmediateSingle ? (
          <button
            type="button"
            disabled={!structuredReady || answering || pickerKnownGone}
            onClick={submitStructuredAnswers}
            className={`
              self-start rounded border border-border px-3 py-1.5 text-[13px] transition-colors
              ${
                !structuredReady || answering || pickerKnownGone
                  ? 'cursor-default opacity-60'
                  : 'cursor-pointer hover:border-accent hover:bg-surface-hi'
              }
            `}
          >
            {answering ? 'Answering…' : 'Submit'}
          </button>
        ) : answering ? (
          <div className="text-[11px] text-muted italic">Answering…</div>
        ) : null}
        {pickerKnownGone ? (
          <div className="text-[11px] text-muted italic">
            The terminal picker is no longer active.
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}
