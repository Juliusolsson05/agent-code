import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { AskUserQuestionRow } from './AskUserQuestionRow'
import type { ToolResultBlock } from '@shared/types/transcript'

import {
  fromClaudeQuestionResult,
  type ClaudeQuestionModel,
} from '@providers/claude/renderer/adapters/questions'
import { useAnsweredViaMessageStore } from './answeredViaMessageStore'

export function ClaudeLiveQuestionRow({ model }: { model: ClaudeQuestionModel }) {
  // WHY the interaction driver lives beside Claude admission even though it
  // consumes shared SessionFeed infrastructure: question payload semantics,
  // action names, and terminal navigation all belong to Claude's protocol.
  // Leaving the painter in the shared feed made a provider-specific component
  // look reusable and invited the shell to grow Claude vocabulary again.
  return <AskUserQuestionRow input={model.input} operationId={model.operationId} />
}

export function ClaudeAnsweredQuestionRow({
  model,
  result,
}: {
  model: ClaudeQuestionModel
  result: ToolResultBlock | null
}) {
  // "Answered via message" — the workaround path: the picker was dismissed and
  // the choices were sent as a prompt, so the transcript shows a generic
  // decline. This marker (set by AskUserQuestionRow at send time, keyed by
  // operationId) is the only signal that the decline is actually an answer.
  const viaMessage = useAnsweredViaMessageStore(state => state.byOperationId[model.operationId])
  const answer = result ? fromClaudeQuestionResult(result, model) : null
  const answered = answer !== null

  if (viaMessage && viaMessage.length > 0) {
    return (
      <MarkerRow marker="✓">
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">Question</span>
          {model.questions.map((question, index) => (
            <div key={index} className="mt-0.5">
              <span className="text-[12px]">{question.question}</span>
            </div>
          ))}
          <div className="mt-1 ml-4 border-l border-border/60 pl-3">
            <div className="text-muted text-[10px] uppercase tracking-wider">Answered via message</div>
            {viaMessage.map((line, i) => (
              <div key={i} className="text-[12px]">{line}</div>
            ))}
          </div>
        </div>
      </MarkerRow>
    )
  }

  return (
    <MarkerRow marker={answered ? '✓' : result ? '◌' : '?'}>
      <div className="text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold">Question</span>
        {model.questions.map((question, index) => (
          <div key={index} className="mt-0.5">
            {question.header ? (
              <span className="text-[11px] text-ink-dim border border-border rounded px-1 py-px mr-2">
                {question.header}
              </span>
            ) : null}
            <span className="text-[12px]">{question.question}</span>
            {question.options.length > 0 ? (
              <div className="text-[11px] text-ink-dim mt-0.5">
                {question.options.map(option => option.label).join(' · ')}
              </div>
            ) : null}
          </div>
        ))}
        {answer !== null ? (
          <div className="mt-1 ml-4 border-l border-border/60 pl-3">
            <div className="text-muted text-[10px] uppercase tracking-wider">Answer</div>
            <PagedTextViewer source={answer} isError={result?.is_error === true} />
          </div>
        ) : null}
        {!answered ? (
          <div className="text-[11px] text-ink-dim mt-0.5">
            {result
              // The AskUserQuestion result is now fully absorbed by this row
              // (dispatch.tsx no longer renders a generic result row), so there
              // is nothing "below" to point at. A result with no extractable
              // answer means the question was dismissed — via Esc, an
              // interrupt, or the answer-via-message path before its delivery
              // confirmed (which flips this to the ✓ branch on success).
              ? 'no answer sent'
              // WHY committed history cannot claim the picker is still live:
              // a missing result can also mean a truncated/interrupted replay.
              // The semantic live row owns interaction when it actually exists.
              : 'no answer recorded'}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}
