import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@renderer/app-state/hooks'
import { useCommandChordLabel } from '@renderer/features/command-keybindings/useCommandChord'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import { providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/rowTitle'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { leftAgo } from './LaneBackChip'
import { goBackInLane, laneAgentLabel, lanePastEntries, type LanePastEntry } from './laneHistoryModel'

// "Recently here" — the agents this lane held, listed inside the EMPTY lane.
//
// WHY the empty lane: it is the one moment the lane has nothing else to show,
// and the most common way to get there is Clear Lane, after which "put it
// back" is exactly the question. The empty state used to be the words "Empty
// lane" and a hint, with the space below wasted.
//
// Capped at a few rows: this is a shortcut, not the archive. The rest is one
// click away in the Lane History dialog, which the last row opens.
const RECENT_LIMIT = 5

export function LaneRecentList({ laneIndex, workspace }: { laneIndex: number; workspace: Workspace }) {
  // Entries are objects, so compare shallowly: the list re-renders when the
  // lane's history or liveness changes, not on every workspace write.
  const entries = useAppStore(useShallow(state => {
    const ws = state.workspaceState as WorkspaceState | undefined
    return ws ? lanePastEntries(ws, laneIndex) : EMPTY
  }))
  const backChord = useCommandChordLabel('lane-back')
  const shown = entries.slice(0, RECENT_LIMIT)
  const more = entries.length - shown.length
  const list = useListNavigation({
    count: shown.length,
    resetKey: laneIndex,
    idPrefix: `lane-recent-${laneIndex}`,
    // The list is LIVE (an agent can close while it shows). Without keys a row
    // disappearing above the highlight slid it onto the neighbour, and Enter
    // restored an agent the user never highlighted (#1511 review).
    keys: shown.map(entry => entry.sessionId),
    onActivate: index => {
      const entry = shown[index]
      if (entry) void goBackInLane(workspace, laneIndex, { target: entry.sessionId, chord: backChord })
    },
  })
  if (shown.length === 0) return null

  return (
    <div className="mx-auto w-full max-w-[420px] px-4 pb-6">
      <div className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>Recently here</span>
        {backChord ? <span className="normal-case tracking-normal">{backChord} brings back the first</span> : null}
      </div>
      {/* Plain list shape from useListNavigation's header: the LISTBOX holds
          focus (one Tab stop) and carries aria-activedescendant; rows are not
          tab stops. Arrow keys work once the list is focused (Tab or a
          click), which is enough here — ⌥B is the keyboard path that needs
          no focus at all. */}
      <div
        role="listbox"
        tabIndex={0}
        aria-label="Agents recently in this lane"
        aria-activedescendant={list.activeId}
        onKeyDown={event => { list.onKeyDown(event) }}
        className="rounded-slab border border-border bg-canvas py-1 outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
      >
        {shown.map((entry, index) => (
          <RecentRow
            key={entry.sessionId}
            entry={entry}
            workspace={workspace}
            highlighted={index === list.index}
            itemProps={list.getItemProps(index)}
          />
        ))}
      </div>
      {/* OUTSIDE the listbox and a real tab stop: a listbox may only contain
          options, and inside it this was neither announced nor reachable by
          keyboard (#1511 review). */}
      {more > 0 ? (
        <button
          type="button"
          onClick={() => useAppStore.getState().openLaneHistory(laneIndex)}
          className="mt-1 rounded-control px-1 text-[11px] text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {more} more — Lane History…
        </button>
      ) : null}
    </div>
  )
}

const EMPTY: LanePastEntry[] = []

function RecentRow({
  entry,
  workspace,
  highlighted,
  itemProps,
}: {
  entry: LanePastEntry
  workspace: Workspace
  highlighted: boolean
  itemProps: ReturnType<ReturnType<typeof useListNavigation>['getItemProps']>
}) {
  const runtime = useAppStore(useShallow(state => {
    const current = state.workspaceRuntimes[entry.sessionId]
    return { entries: current?.entries, terminalForeground: current?.terminalForeground }
  }))
  const meta = workspace.state.sessions[entry.sessionId as SessionId]
  if (!meta) return null
  const label = laneAgentLabel(workspace.state, entry.sessionId)
  // The index's own title rule (explicit title, else latest prompt, else
  // folder), so the row reads as the agent you saw in the index.
  const title = dispatchRowTitle(
    { agentTitle: meta.title?.trim() || undefined, kind: meta.kind, title: sessionDisplayTitle(meta) },
    runtime.entries,
    runtime.terminalForeground?.cwd,
  )
  return (
    <div
      {...itemProps}
      role="option"
      aria-selected={highlighted}
      className={`flex w-full cursor-default items-center gap-2 border-l-2 px-3 py-1.5 text-left ${
        highlighted ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent hover:bg-row-hover-bg'
      }`}
    >
      <span className="w-7 flex-shrink-0 text-[10px] font-semibold tabular-nums text-muted">{label ?? ''}</span>
      <span aria-hidden="true" className="w-3 flex-shrink-0 text-center text-[11px] text-accent">{providerGlyph(meta.kind ?? DEFAULT_PROVIDER)}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{title}</span>
      <span className="flex-shrink-0 text-[10px] tabular-nums text-muted">{leftAgo(entry.at)}</span>
    </div>
  )
}
