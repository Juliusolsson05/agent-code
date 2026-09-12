import {
  useAgentName,
  useAgentNameRowReserved,
} from '@renderer/workspace/agentNames/useAgentName'
import type { SessionId } from '@renderer/workspace/types'

// One visual contract for explicit titles and spoken names across every pane
// surface: the structured Agent view, the raw agent terminal, and (since #865)
// plain shell terminals, which render PaneHeader and therefore this row too.
//
// WHY the component subscribes rather than taking `agentName` as a prop: both
// call sites sit on the hot pane-render path and already thread a dozen props;
// see useAgentName for why a primitive subscription is cheaper than widening
// them.
//
// WHY this row's HEIGHT is constant from first paint rather than appearing
// with the name:
//
// A name arrives over IPC well after the pane mounts. Keying the row's
// existence on the name meant every named agent pane grew ~23px mid-life on
// every window load, which shrank the terminal box, triggered a refit, and
// sent a second PTY resize as a SIGWINCH into a live, mid-output TUI. Ink and
// the Claude Code TUI erase a line count computed for the frame before that
// resize, so the redraw lands on the wrong region and leaves garbled
// fragments behind permanently. Reserving the space removes the layout change,
// so there is no second resize to race. See agentNameRowIsReserved.
export function AgentTitleHeader({ sessionId, title }: { sessionId: SessionId; title?: string }) {
  const agentName = useAgentName(sessionId)
  const reserveNameRow = useAgentNameRowReserved(sessionId)
  const visibleTitle = title?.trim()
  // WHY the guard checks all three: this row used to exist only for a title, so
  // an untitled agent rendered nothing. With names on, that would hide the only
  // address a voice operator can use while the operator can still reach it —
  // and the reservation keeps the row's box stable while the name is in flight.
  if (!visibleTitle && !agentName && !reserveNameRow) return null

  return (
    <div
      data-agent-title-header="true"
      className="flex min-w-0 items-center gap-2 border-t border-border/70 bg-canvas px-3 py-1 font-code text-[11px] font-medium text-ink select-none"
      title={[agentName, visibleTitle].filter(Boolean).join(' — ')}
    >
      {agentName ? (
        // Fixed width contribution, never truncated: the name is the thing a
        // user says out loud, so it must survive a narrow Tiled Dispatch lane
        // even when the title does not.
        <span
          data-agent-name-badge="true"
          className="flex-shrink-0 rounded-chip border border-border px-1 leading-[14px] text-[10px] font-semibold tracking-wide text-ink"
        >
          {agentName}
        </span>
      ) : reserveNameRow ? (
        // The placeholder carries the badge's exact box (border + px-1 +
        // leading-[14px]) so the row's height cannot change when the real name
        // replaces it. `invisible` rather than omitting it: an empty flex row
        // collapses to its padding and would resize the terminal anyway.
        // aria-hidden and no data-agent-name-badge, so nothing reads or
        // queries it as a name.
        <span
          aria-hidden="true"
          data-agent-name-placeholder="true"
          className="invisible flex-shrink-0 rounded-chip border border-border px-1 leading-[14px] text-[10px] font-semibold tracking-wide"
        >
          &nbsp;
        </span>
      ) : null}
      {visibleTitle && <div className="truncate">{visibleTitle}</div>}
    </div>
  )
}
