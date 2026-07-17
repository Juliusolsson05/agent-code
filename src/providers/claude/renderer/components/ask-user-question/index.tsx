import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { AskUserQuestionRow } from '@renderer/features/feed/ui/semantic/AskUserQuestionRow'
import type { ToolResultBlock } from '@shared/types/transcript'

import {
  fromClaudeQuestionResult,
  type ClaudeQuestionModel,
} from '@providers/claude/renderer/adapters/questions'

export function ClaudeLiveQuestionRow({ model }: { model: ClaudeQuestionModel }) {
  // The interaction driver remains renderer infrastructure because it needs
  // SessionFeed and condition contexts. Claude owns admission and supplies the
  // exact provider input; the shared feed no longer knows the tool name.
  return <AskUserQuestionRow input={model.input} />
}

export function ClaudeAnsweredQuestionRow({
  model,
  result,
}: {
  model: ClaudeQuestionModel
  result: ToolResultBlock | null
}) {
  const answer = result ? fromClaudeQuestionResult(result, model) : null
  const answered = answer !== null
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
              ? 'response received — the unrecognized or failed result remains visible below'
              : 'unanswered — the live picker owns the interaction'}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}
