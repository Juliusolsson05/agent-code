// ActivityIndicator — spinner with status text at the bottom of the feed.
// Shows when CC is working but the streaming row isn't active yet.

import { MarkerRow } from './MarkerRow'

export function ActivityIndicator({ status }: { status: string }) {
  return (
    <MarkerRow marker="⏺">
      <div className="flex items-center gap-2 text-muted text-[12px] py-0.5">
        <span className="streaming-dot inline-block w-1.5 h-1.5 rounded-full bg-accent" />
        <span>{status}</span>
      </div>
    </MarkerRow>
  )
}
