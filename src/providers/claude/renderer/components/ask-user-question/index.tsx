import { useContext } from 'react'

import { LiveUnresolvedQuestionsContext } from '@renderer/features/feed/context'
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
  const answeredViaMessage = viaMessage !== undefined && viaMessage.length > 0
  const liveUnresolved = useContext(LiveUnresolvedQuestionsContext)
  const answer = result ? fromClaudeQuestionResult(result, model) : null
  const answered = answer !== null

  // WHY the committed card can be the live picker (#738): the ledger gives
  // this tool_use to the committed row as soon as the JSONL entry lands —
  // which Claude Code writes BEFORE it runs the picker — so the live-plane
  // twin (ClaudeLiveQuestionRow) is rejected and, without this, the user saw
  // "no answer recorded" for a question the TUI was still waiting on. The
  // semantic plane knows whether the block is still unresolved in the current
  // turn; that, plus no durable result and no answer-via-message, is the
  // proof that the picker is real. A reload has no semantic evidence and
  // falls through to the honest view-only card below.
  if (result === null && !answeredViaMessage && liveUnresolved.has(model.operationId)) {
    return <AskUserQuestionRow input={model.input} operationId={model.operationId} />
  }

  if (answeredViaMessage) {
    // The summary lines already read "question → choices", so we do NOT repeat
    // the question list above them — that was doubling the question text.
    return (
      <MarkerRow marker="✓">
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">Answered via message</span>
          <div className="mt-1 ml-4 border-l border-border/60 pl-3">
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
              <span className="text-[11px] text-ink-dim border border-border rounded-chip px-1 py-px mr-2">
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
