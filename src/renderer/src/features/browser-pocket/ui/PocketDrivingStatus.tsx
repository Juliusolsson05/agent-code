import { usePocketLive } from '../state/pocketLiveStore'

/**
 * "Who is driving" line at the foot of an open pocket (spec §4.8). Static
 * styling only: Antigravity's animated "agent control" glow was reported to
 * cost input latency, and this sits beside a live terminal.
 */
export function PocketDrivingStatus({ pocketId }: { pocketId: string }) {
  const live = usePocketLive(pocketId)
  if (live.driving === 'agent') {
    return (
      <div className="flex h-6 flex-shrink-0 items-center gap-2 border-t border-accent/40 bg-surface px-2 text-[11px] text-ink-dim">
        <span className="text-accent">●</span>
        <span className="min-w-0 flex-1 truncate">Agent is driving{live.drivingAction ? ` — ${live.drivingAction}` : ''}</span>
        <button type="button" className="rounded-control border border-border px-1.5 hover:border-border-hi hover:text-ink" onClick={() => void window.api.takeOverPocket({ pocketId })}>Take over</button>
      </div>
    )
  }
  if (live.driving === 'user-paused') {
    return (
      <div className="flex h-6 flex-shrink-0 items-center gap-2 border-t border-border bg-surface px-2 text-[11px] text-ink-dim">
        <span className="text-warning">⏸</span>
        <span className="min-w-0 flex-1 truncate">You have control. The agent's browser actions are paused.</span>
        <button type="button" className="rounded-control border border-border px-1.5 hover:border-border-hi hover:text-ink" onClick={() => void window.api.resumePocketAgent({ pocketId })}>Let agent continue</button>
      </div>
    )
  }
  return null
}
