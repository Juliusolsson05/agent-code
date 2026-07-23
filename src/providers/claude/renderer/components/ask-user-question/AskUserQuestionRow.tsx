import { useContext, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import {
  AskUserQuestionConditionContext,
  CodeRenderContext,
} from '@renderer/features/feed/context'
import { useSessionFeed } from '@renderer/features/sessionFeed/SessionFeedContext'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import type { ConditionCustomAction } from '@shared/types/providerConditions'
import {
  readAskQuestions,
  type AskOption,
} from '@providers/claude/renderer/adapters/questions'
import { answersToPrompt, answerSummaryLines } from '@providers/claude/renderer/components/ask-user-question/answerPrompt'
import { deliverAnswersViaPrompt } from '@providers/claude/renderer/components/ask-user-question/deliverAnswersViaPrompt'
import { useAnsweredViaMessageStore } from '@providers/claude/renderer/components/ask-user-question/answeredViaMessageStore'

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
//   This row answers by TWO paths (see the workaround decomposition,
//   docs/decomposition/2026-07-23-auq-answer-via-prompt.md):
//   - Immediate SINGLE-SELECT single-question → a structured custom action
//     (`dispatchAnswer` → `resolveCondition`) that the Claude headless resolver
//     replays as one keystroke. This is the one case the keystroke driver
//     completes reliably.
//   - Everything else (multi-select, free-text, multi-question) → `answerViaMessage`:
//     dismiss the picker with Esc and send the choices as a structured prompt.
//     Keystroke-driving those was defeated by Claude's "Submit answers" review
//     screen, wrapped checkboxes, and the free-text field, and re-broke every
//     release. The prompt path is version-proof.
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
// WHY the screen condition does not gate rendering or submission:
//   The transcript block is durable evidence that Claude asked a question,
//   while screen parsing is a racing observation that may arrive before or
//   after this component. The provider's structured resolver reparses the live
//   terminal immediately before writing and refuses ambiguous input. We retain
//   the condition only for forwarding terminal-navigation keys; using it as a
//   second liveness authority made valid questions intermittently unclickable.
//
// WHY the row disappears on its own after answering:
//   An UNRESOLVED block (`!block.resultAt`) means the picker is LIVE and
//   awaiting the user. When the tool_result lands, `resultAt` is set and
//   BlockRow stops routing to this component, so the row unmounts. We
//   never hide ourselves manually — ownership is decided one level up.

// Defensive shapes for the parsed input. `parsedInput` is a
// `Record<string, unknown>`. The defensive narrowing here is NOT about
// partial objects: foldEvent.ts populates `parsedInput` only on
// `tool_input_finalized` / `block_completed`, from a fully-parsed object —
// so when it's present it's complete. What we actually guard is the
// NOT-YET-FINALIZED case where `parsedInput` is `undefined` (no finalize
// event has arrived yet), which must degrade to the "Question loading…"
// placeholder rather than throw. Every field is still narrowed at read
// time so an unexpected/malformed payload also degrades gracefully.

function isFreeTextOption(option: AskOption): boolean {
  const label = option.label.trim().toLowerCase()
  return label === 'type something' || label === 'other'
}


export function AskUserQuestionRow({
  input,
  operationId,
}: {
  input: Record<string, unknown> | undefined
  operationId: string
}) {
  // sessionId is obtained the SAME way every other feed row gets it: via
  // CodeRenderContext, which Feed.tsx wraps the entire render-item list
  // in (`<CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>`).
  // SemanticStreamingTurn → SemanticLiveBlockRow → this row all render
  // inside that provider, so the context value is the live session, not
  // the empty default.
  const { sessionId } = useContext(CodeRenderContext)
  const liveAskUserQuestion = useContext(AskUserQuestionConditionContext)
  // Session input goes through the injected SessionFeed (not window.api):
  // this row is shared with the remote client, where the preload bridge
  // does not exist. See src/shared/sessionFeed/SessionFeed.ts.
  const feed = useSessionFeed()
  const { showToast } = useGlobalToast()
  const markAnsweredViaMessage = useAnsweredViaMessageStore(state => state.mark)

  // Local "answering" latch. Once the user submits an answer we disable every
  // control, both to give feedback ("Answering…") and to guard against
  // double-submit while the headless driver is writing to the real terminal.
  // Unlike the old raw-keystroke path, the structured resolver can return a
  // bounded failure, so this latch is cleared on failed/ rejected IPC and the
  // user can retry without remounting the row.
  const [answering, setAnswering] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [selectedByQuestion, setSelectedByQuestion] =
    useState<Record<number, number[]>>({})
  const [textByQuestion, setTextByQuestion] = useState<Record<number, string>>({})

  // Synchronous double-submit guard. `answering` (React state) only drives
  // the VISUAL disabled/"Answering…" affordance — but `disabled` doesn't
  // take effect until the next render, so two clicks dispatched in the SAME
  // tick (e.g. a fast double-click) both pass the `if (answering)` check and
  // fire two resolver calls. The second call could interleave keystrokes with
  // the first in the provider TUI. A ref is read+written SYNCHRONOUSLY at the
  // top of the handler, before any IPC, so the second call in the same tick sees
  // `true` and bails. It is reset only for structured/rejected failures.
  const submittedRef = useRef(false)
  // Tracks whether this row is still mounted, so the detached answer-via-message
  // callback only touches state (latch/error reset) when there is a row to
  // touch — on the happy path Esc has already unmounted it.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const questions = readAskQuestions(input)

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
      selectedOptions?: Array<{
        label: string
        number?: number
      }>
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
    // WHY this does NOT gate on the screen condition anymore:
    // transcript rows and screen conditions are two independent streams. The
    // semantic AUQ block can mount before the parser has detected the terminal
    // picker, which made a real live question intermittently unclickable. The
    // headless resolver is now the safety boundary: it reparses the current xterm
    // before writing anything and returns a structured failure if the picker is
    // absent or ambiguous. That removes the stray-keystroke race without making
    // the renderer guess about liveness from a racing snapshot.
    submittedRef.current = true
    setAnswering(true)
    setResolveError(null)
    void feed
      .resolveCondition(sessionId, action)
      .then(result => {
        if (!result.ok) {
          // Let the user try again when the structured driver reports a bounded
          // failure. The old single-keystroke path latched forever because there
          // was no meaningful recovery signal; the driver can now say "timeout" or
          // "option not found" without corrupting the terminal, so keeping the row
          // interactive is the safer failure mode.
          submittedRef.current = false
          setAnswering(false)
          // WHY failedAtStep is optional: transport-level refusals can explain
          // the failure without entering the multi-step TUI driver. Appending
          // an absent step produced the user-facing nonsense “at undefined”.
          setResolveError(
            result.failedAtStep === undefined
              ? result.reason
              : `${result.reason} at ${result.failedAtStep}`,
          )
        }
      })
      .catch(() => {
        submittedRef.current = false
        setAnswering(false)
        setResolveError('resolver IPC failed')
      })
  }

  const handleSingleOption = (questionIndex: number, option: AskOption) => {
    const q = questions[questionIndex]
    if (!q) return
    dispatchAnswer(
      buildAction([
        {
          question: q.answerQuestion ?? q.question,
          header: q.answerHeader ?? q.header,
          multiSelect: q.multiSelect,
          selectedOptions: [{
            label: option.answerLabel ?? option.label,
            number: q.options.indexOf(option) + 1,
          }],
          selectedLabels: [option.answerLabel ?? option.label],
        },
      ]),
    )
  }

  const toggleOption = (questionIndex: number, number: number) => {
    const q = questions[questionIndex]
    if (!q) return
    setResolveError(null)
    if (!q.multiSelect) {
      setSelectedByQuestion(prev => ({ ...prev, [questionIndex]: [number] }))
      setTextByQuestion(prev => {
        if (!prev[questionIndex]) return prev
        const next = { ...prev }
        delete next[questionIndex]
        return next
      })
      return
    }
    setSelectedByQuestion(prev => {
      const current = prev[questionIndex] ?? []
      const next = current.includes(number)
        ? current.filter(item => item !== number)
        : [...current, number]
      return { ...prev, [questionIndex]: next }
    })
  }

  const activateCustomText = (questionIndex: number) => {
    setResolveError(null)
    const q = questions[questionIndex]
    if (!q?.multiSelect) {
      setSelectedByQuestion(prev => {
        if (!prev[questionIndex]?.length) return prev
        const next = { ...prev }
        delete next[questionIndex]
        return next
      })
    }
    setTextByQuestion(prev => ({
      ...prev,
      [questionIndex]: prev[questionIndex] ?? '',
    }))
  }

  const updateCustomText = (questionIndex: number, value: string) => {
    setResolveError(null)
    const q = questions[questionIndex]
    if (!q?.multiSelect) {
      setSelectedByQuestion(prev => {
        if (!prev[questionIndex]?.length) return prev
        const next = { ...prev }
        delete next[questionIndex]
        return next
      })
    }
    setTextByQuestion(prev => ({
      ...prev,
      [questionIndex]: value,
    }))
  }

  const submitStructuredAnswers = () => {
    const answers = questions.map((q, qi) => ({
      question: q.answerQuestion ?? q.question,
      header: q.answerHeader ?? q.header,
      multiSelect: q.multiSelect,
      selectedOptions: (selectedByQuestion[qi] ?? []).map(number => ({
        label: q.options[number - 1]?.answerLabel ?? q.options[number - 1]?.label ?? '',
        number,
      })),
      selectedLabels: (selectedByQuestion[qi] ?? [])
        .map(number => q.options[number - 1]?.answerLabel ?? q.options[number - 1]?.label)
        .filter((label): label is string => Boolean(label)),
      text: textByQuestion[qi]?.trim() || undefined,
    }))
    answerViaMessage(answers)
  }

  // The "answer via message" path (the workaround): dismiss the picker with Esc
  // and send the choices as a structured prompt, instead of keystroke-driving
  // the TUI. Used for everything the keystroke driver can't reliably complete —
  // multi-select, multi-question, and free-text. Single-select stays on
  // `dispatchAnswer` (the driver's one robust case). See
  // docs/decomposition/2026-07-23-auq-answer-via-prompt.md.
  const answerViaMessage = (answers: Parameters<typeof buildAction>[0]) => {
    if (submittedRef.current) return
    if (answering) return
    if (!sessionId) return
    const prompt = answersToPrompt(answers)
    if (!prompt) {
      setResolveError('Select an option or type an answer first.')
      return
    }
    submittedRef.current = true
    setAnswering(true)
    setResolveError(null)
    const summary = answerSummaryLines(answers)
    // Detached: on success Esc has already unmounted this row, so the sequence
    // must not assume it is still mounted. Two outcomes, both handled without a
    // false claim:
    //   ok   → NOW record the "answered via message" marker. Recording it
    //          before delivery (an earlier cut did) painted a permanent green
    //          "✓ answered" even when the prompt never reached Claude — the
    //          exact dishonest render this path exists to avoid. Until this
    //          fires, the answered row honestly shows "no answer sent".
    //   !ok  → toast the reason (app-level, survives unmount) and, IF the row
    //          is still mounted (e.g. Esc itself failed so nothing unmounted),
    //          release the latch so the user can retry.
    void deliverAnswersViaPrompt(feed, sessionId, prompt).then(outcome => {
      if (outcome.ok) {
        markAnsweredViaMessage(operationId, summary)
        return
      }
      showToast(`Could not send your answer: ${outcome.reason}`)
      if (mountedRef.current) {
        submittedRef.current = false
        setAnswering(false)
        setResolveError(outcome.reason)
      }
    })
  }

  const structuredReady = questions.every((q, qi) => {
    const selected = selectedByQuestion[qi] ?? []
    const text = textByQuestion[qi]?.trim() ?? ''
    if (q.multiSelect) return selected.length > 0 || text.length > 0
    return questions.length === 1 || selected.length > 0 || text.length > 0
  })
  const useImmediateSingle =
    questions.length === 1 &&
    !questions[0].multiSelect &&
    (textByQuestion[0]?.trim() ?? '').length === 0 &&
    (selectedByQuestion[0]?.length ?? 0) === 0

  const forwardTerminalNavigation = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!sessionId || !liveAskUserQuestion) return
    const target = event.target
    // The composer-level key bridge only runs while the textarea has focus.
    // Once the user clicks a native AUQ button, focus moves into this row and
    // plain ArrowUp/ArrowDown would otherwise scroll the feed instead of moving
    // Claude's own cursor. Bridge only terminal-navigation keys here, and skip
    // editable controls so local free-text editing keeps normal caret behavior.
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) return

    const seq =
      event.key === 'ArrowUp'
        ? '\x1b[A'
        : event.key === 'ArrowDown'
          ? '\x1b[B'
          : event.key === 'Escape'
            ? '\x1b'
            : null
    if (!seq) return
    event.preventDefault()
    event.stopPropagation()
    void feed.sendInput(sessionId, seq)
  }

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-3" onKeyDownCapture={forwardTerminalNavigation}>
        {questions.map((q, qi) => {
          const selected = selectedByQuestion[qi] ?? []
          const controlsDisabled = answering
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
                  const optionNumber = oi + 1
                  const freeTextOption = isFreeTextOption(opt)
                  const isSelected = selected.includes(optionNumber)
                  const immediate = useImmediateSingle && !freeTextOption
                  return (
                    <button
                      key={oi}
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() =>
                        immediate
                          ? handleSingleOption(qi, opt)
                          : freeTextOption
                            ? activateCustomText(qi)
                            : toggleOption(qi, optionNumber)
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
                        {q.multiSelect ? (isSelected ? '[x]' : '[ ]') : isSelected ? '(*)' : `${oi + 1}.`}
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
                {/* WHY this is unconditional: `useImmediateSingle` can only be
                    true for a non-multi question, so the old
                    `!useImmediateSingle || !q.multiSelect` guard was a
                    tautology. Keeping the input explicit also makes the
                    typed-text → option → Submit transition reviewable. */}
                <div className="mt-1 flex flex-col gap-1">
                  {!q.multiSelect && (
                    <div className="text-[10px] uppercase tracking-[0.12em] text-muted">
                      or custom answer
                    </div>
                  )}
                  <input
                    value={textByQuestion[qi] ?? ''}
                    disabled={controlsDisabled}
                    onFocus={() => activateCustomText(qi)}
                    onChange={event => updateCustomText(qi, event.target.value)}
                    placeholder="Type something"
                    className="rounded border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-60"
                  />
                </div>
              </div>
            </div>
          )
        })}
        {!useImmediateSingle ? (
          <button
            type="button"
            disabled={!structuredReady || answering}
            onClick={submitStructuredAnswers}
            className={`
              self-start rounded border border-border px-3 py-1.5 text-[13px] transition-colors
              ${
                !structuredReady || answering
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
        {resolveError ? (
          <div className="border border-danger-border bg-danger-soft px-2 py-1 text-[11px] text-danger">
            Answer failed: {resolveError}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}
