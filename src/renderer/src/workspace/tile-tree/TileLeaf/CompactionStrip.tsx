// Compaction progress strip. Renders the live status of a /compact
// run — either the running status text (CC's own progress message
// reflected from the TUI) or an error message. 'done' is the
// terminal state the store clears on the next event; if we ever see
// `pendingCompaction.phase === 'done'` we render nothing, same as
// the null case.
export function CompactionStrip({
  pendingCompaction,
}: {
  pendingCompaction:
    | {
        phase: 'running' | 'error' | 'done'
        statusText?: string
        errorText?: string
      }
    | null
}) {
  if (!pendingCompaction || pendingCompaction.phase === 'done') return null
  const isError = pendingCompaction.phase === 'error'
  const message = isError
    ? pendingCompaction.errorText
    : pendingCompaction.statusText
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
