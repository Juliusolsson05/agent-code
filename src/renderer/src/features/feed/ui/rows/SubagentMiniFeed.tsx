import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import type { SubAgentState } from '@renderer/workspace/workspaceState'

// The drill-in view for one subagent: its tool-call timeline + a live
// current-activity line. Deliberately compact — this is "what is it doing",
// not the subagent's full prose (see the design spec's tool-timeline scope
// decision). The data is the capped SubAgentState.toolCalls the main-process
// watcher derives from the subagent's transcript; `droppedToolCalls` reports
// how many older calls were trimmed so the count never silently lies.
export function SubagentMiniFeed({ sa }: { sa: SubAgentState }) {
  return (
    <div className="ml-4 mt-1 border-l border-line/60 pl-3">
      {sa.droppedToolCalls > 0 && (
        <div className="text-[11px] text-muted mb-1">
          … +{sa.droppedToolCalls} earlier{' '}
          {sa.droppedToolCalls === 1 ? 'call' : 'calls'}
        </div>
      )}
      {sa.toolCalls.map((t, i) => (
        <MarkerRow key={i} marker={t.status === 'done' ? '⏺' : '◐'} tone="muted">
          <div className="text-[12px] leading-[1.55]">
            <span className="text-accent">{t.name}</span>
            {t.headline && (
              <span className="font-code text-ink-dim ml-2 break-all">
                {t.headline}
              </span>
            )}
          </div>
        </MarkerRow>
      ))}
      {sa.currentActivity && (
        <MarkerRow marker="◐" tone="muted">
          <span className="text-[12px] text-ink-dim">{sa.currentActivity}…</span>
        </MarkerRow>
      )}
      {sa.toolCalls.length === 0 && !sa.currentActivity && (
        <div className="text-[11px] text-muted">no activity yet…</div>
      )}
    </div>
  )
}
