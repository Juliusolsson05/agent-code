import { memo } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { readAskQuestions } from '@renderer/features/feed/lib/askUserQuestion'

/* ---------- Committed-plane AskUserQuestion row (P2d) ---------- */
//
// The LIVE picker (semantic AskUserQuestionRow) is where answering
// happens; by the time the tool_use commits, the interaction is over.
// Legacy painted the committed twin as raw input JSON (the 06-17
// "Ask user question" bundle) — post-P1 it fell to the generic JsonToolRow,
// readable but shapeless. This row renders the questions the way the
// picker showed them, plus the answer.
//
// The ANSWER is displayed verbatim from the tool_result text on purpose:
// no local transcript contains an AskUserQuestion result to pin a schema
// to (checked 2026-07-07), and guessing a shape here is how renderers rot.
// When a result schema is finally observed in the wild, tighten this into
// per-question answer chips — the fixture that captures it should ride
// that PR.

function resultText(result: ToolResultBlock | null): string | null {
  if (!result) return null
  const content = (result as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const t = content.find(b => asRecord(b)?.type === 'text')
    const text = asRecord(t)?.text
    return typeof text === 'string' ? text : null
  }
  return null
}

export const AskUserQuestionAnsweredRow = memo(function AskUserQuestionAnsweredRow({
  block,
  result,
}: {
  block: ToolUseBlock
  result: ToolResultBlock | null
}) {
  const questions = readAskQuestions(block.input as Record<string, unknown> | undefined)
  const answer = resultText(result)
  const answered = result !== null

  return (
    <MarkerRow marker={answered ? '✓' : '?'}>
      <div className="text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold">Question</span>
        {questions.length === 0 && (
          <div className="text-[12px] text-ink-dim">AskUserQuestion</div>
        )}
        {questions.map((q, i) => (
          <div key={i} className="mt-0.5">
            {q.header && (
              <span className="text-[11px] text-ink-dim border border-edge rounded px-1 py-px mr-2">
                {q.header}
              </span>
            )}
            <span className="text-[12px]">{q.question}</span>
            {q.options.length > 0 && (
              <div className="text-[11px] text-ink-dim mt-0.5">
                {q.options.map(o => o.label).join(' · ')}
              </div>
            )}
          </div>
        ))}
        {answer && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0">
              {answer.length > 600 ? `${answer.slice(0, 600)}…` : answer}
            </pre>
          </MarkerRow>
        )}
        {!answered && (
          <div className="text-[11px] text-ink-dim mt-0.5">
            unanswered — the live picker above owns the interaction
          </div>
        )}
      </div>
    </MarkerRow>
  )
})
