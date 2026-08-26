// One visual contract for explicit agent titles across the structured Agent
// surface and raw agent-terminal surface. Plain shell terminals intentionally
// do not use this component: titles belong to provider agents and the command
// refuses terminal targets at the mutation boundary too.
export function AgentTitleHeader({ title }: { title?: string }) {
  const visibleTitle = title?.trim()
  if (!visibleTitle) return null

  return (
    <div
      data-agent-title-header="true"
      className="min-w-0 border-t border-border/70 bg-canvas px-3 py-1 font-code text-[11px] font-medium text-ink select-none"
      title={visibleTitle}
    >
      <div className="truncate">{visibleTitle}</div>
    </div>
  )
}
