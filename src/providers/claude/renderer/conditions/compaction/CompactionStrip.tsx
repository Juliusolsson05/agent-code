import type { ClaudeCompactionState } from '@shared/types/providerConditions'

// Compaction progress strip. Renders the provider-normalized live status of a
// /compact run — structured proxy lifecycle first, documented screen fallback
// second. 'done' is the
// terminal state the store clears on the next event; if we ever see
// `compaction.phase === 'done'` we render nothing, same as
// the null case.
export function CompactionStrip({
  compaction,
}: {
  compaction: ClaudeCompactionState | null
}) {
  if (!compaction || compaction.phase === 'done') return null
  const isError = compaction.phase === 'error'
  const message = isError
    ? compaction.errorText
    : compaction.statusText
  return (
    <div
      className={`flex-shrink-0 border-t px-5 py-2 font-code text-[12px] leading-[1.6] ${
        isError
          ? 'text-danger border-danger/30 bg-danger/8'
          : 'text-ink border-border bg-surface'
      }`}
    >
      <div className="font-semibold">
        {isError ? 'Compaction failed' : 'Compacting conversation'}
      </div>
      {message && (
        <div className="mt-0.5 whitespace-pre-wrap break-words opacity-90">
          {message}
        </div>
      )}
    </div>
  )
}
