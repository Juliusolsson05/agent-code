import type { MouseEvent } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import { useCommandBinding, useCommandChordLabel, withChord } from '@renderer/features/command-keybindings/useCommandChord'
import { relativeTime } from '@renderer/lib/relativeTime'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/rowTitle'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useWorkspaceLayoutContext } from '@renderer/workspace/WorkspaceContext'
import { toElectronAccelerator } from '@shared/keybindings'
import type { PopupMenuItem } from '@shared/types/popupMenu'
import { goBackInLane, laneAgentLabel, lanePastEntries } from './laneHistoryModel'

// "↶ A2 ⌥B" in the pane header: the visible way into Lane History.
//
// WHY in the pane header, which belongs to the agent: a lane has no header of
// its own, the strip is chips-only by the owner's call, and the empty-lane
// state only exists when the lane is empty. The header's `trailing` slot is
// the one place on a FILLED lane that already carries small, surface-scoped
// state (TAIL). The chip is lane state, so it is drawn only when the header is
// inside a lane (LaneSlotContext), never in Spotlight or Sidekick.
//
// WHY always visible (when there is a previous agent) and not on hover: the
// index's controls are deliberately always visible because "a hover-revealed
// control is one a mouse-first user has to hunt for" (DispatchAgentList). A
// lane that has only ever held one agent shows nothing, so the chip costs no
// room until it has something to offer.
//
// Click = Lane Back (the same as ⌥B). Right-click (or the context-menu key)
// opens the lane's full history as a NATIVE menu through the generic
// `menu:popup` channel (#1180), which named "the pane header" as one of its
// intended follow-up surfaces. Native, not a React popover, for the reasons
// that plan recorded: it draws over the browser pocket's webview, and it gets
// macOS keyboard behaviour for free.

export const LANE_HISTORY_MENU_OPEN_DIALOG = 'lane-history:dialog'
const MENU_PICK_PREFIX = 'lane-history:pick:'
/** Native menus stay short; the dialog has the rest. */
const MENU_MAX_AGENTS = 10

export function LaneBackChip({ laneIndex }: { laneIndex: number }) {
  // Only the PREVIOUS agent's id: a primitive, so this header re-renders when
  // the answer changes and not on every unrelated workspace write.
  const previous = useAppStore(state => {
    const workspaceState = state.workspaceState as WorkspaceState | undefined
    return workspaceState ? lanePastEntries(workspaceState, laneIndex)[0]?.sessionId ?? null : null
  })
  if (!previous) return null
  return <LaneBackChipButton laneIndex={laneIndex} previous={previous} />
}

function LaneBackChipButton({ laneIndex, previous }: { laneIndex: number; previous: SessionId }) {
  const workspace = useWorkspaceLayoutContext()
  const chord = useCommandChordLabel('lane-back')
  const binding = useCommandBinding('lane-back')
  const label = laneAgentLabel(workspace.state, previous) ?? '…'
  const title = agentTitle(workspace.state, previous)

  const onClick = (event: MouseEvent) => {
    // The header's mousedown already focuses the lane; stopping the click
    // keeps a parent onClick (none today) from treating it as a pane click.
    event.stopPropagation()
    goBackInLane(workspace, laneIndex, { target: previous, chord })
  }

  const onContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    // A pointer right-click opens at the cursor (x/y omitted); the
    // context-menu key opens at the chip, not wherever the mouse rests.
    const fromKeyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0
    void openLaneHistoryMenu(workspace, laneIndex, chord, binding ? toElectronAccelerator(binding) : null,
      fromKeyboard ? { x: Math.round(rect.left), y: Math.round(rect.bottom) } : {})
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={withChord(`Back to ${label} — ${title}`, chord) + '\nRight-click for this lane’s history'}
      aria-label={`Back to ${label}, ${title}`}
      // Same chip vocabulary as the pane label on the left of this row
      // (`rounded-chip border-current/30`), so it reads as header chrome and
      // follows the row through Status Mode's accent fill and the completion
      // outline via `current`.
      className="flex flex-shrink-0 items-center gap-1 rounded-chip border border-current/30 px-1 leading-[14px] text-[10px] font-semibold tabular-nums hover:border-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
    >
      <span aria-hidden="true">↶</span>
      <span>{label}</span>
      {/* The chord is the optional part: dropped first in a narrow header,
          by container query on the header's text group (PaneHeader's
          `@container`), never by pane width. */}
      {chord ? <span className="hidden font-normal opacity-70 @[18rem]:inline">{chord}</span> : null}
    </button>
  )
}

function agentTitle(state: WorkspaceState, sessionId: SessionId): string {
  const meta = state.sessions[sessionId]
  if (!meta) return ''
  // The same rule the index uses for an untitled agent's title fallback is
  // not available here without runtime entries; the explicit title or folder
  // is enough next to the label, which is the real identifier.
  return dispatchRowTitle({ agentTitle: meta.title?.trim() || undefined, kind: meta.kind, title: sessionDisplayTitle(meta) })
}

/**
 * The native menu: Back to the previous agent first (with the chord shown as
 * a display-only accelerator), then the rest of the history, then the full
 * dialog. Exported for tests and for the empty-lane surface.
 */
export function laneHistoryMenuItems(
  state: WorkspaceState,
  laneIndex: number,
  accelerator: string | null,
  now: number = Date.now(),
): PopupMenuItem[] {
  const entries = lanePastEntries(state, laneIndex)
  const items: PopupMenuItem[] = entries.slice(0, MENU_MAX_AGENTS).map((entry, index) => {
    const label = laneAgentLabel(state, entry.sessionId) ?? '…'
    const text = `${index === 0 ? 'Back to ' : ''}${label}  ${truncate(agentTitle(state, entry.sessionId), 40)}  ·  ${leftAgo(entry.at, now)}`
    return {
      type: 'item',
      id: `${MENU_PICK_PREFIX}${entry.sessionId}`,
      label: text,
      ...(index === 0 && accelerator ? { accelerator } : {}),
    }
  })
  items.push({ type: 'separator' }, { type: 'item', id: LANE_HISTORY_MENU_OPEN_DIALOG, label: 'Lane History…' })
  return items
}

async function openLaneHistoryMenu(
  workspace: Workspace,
  laneIndex: number,
  chord: string | null,
  accelerator: string | null,
  at: { x?: number; y?: number },
): Promise<void> {
  const store = useAppStore.getState()
  const state = store.workspaceState as WorkspaceState
  let picked: string | null
  try {
    picked = await window.api.showPopupMenu({ items: laneHistoryMenuItems(state, laneIndex, accelerator), ...at })
  } catch (error) {
    // A rejected invoke is a template bug (main validates and throws); say so
    // in the console rather than leaving a right-click that did nothing.
    // eslint-disable-next-line no-console
    console.warn('[lane-history] popup failed', error)
    return
  }
  if (!picked) return
  if (picked === LANE_HISTORY_MENU_OPEN_DIALOG) {
    useAppStore.getState().openLaneHistory(laneIndex)
    return
  }
  if (!picked.startsWith(MENU_PICK_PREFIX)) return
  const target = picked.slice(MENU_PICK_PREFIX.length) as SessionId
  // The menu is modal but the workspace is not frozen behind it. goBackInLane
  // re-reads the LIVE state and re-checks that the target still exists and is
  // not already the occupant (the #1185 "re-check on resolve" rule).
  goBackInLane(workspace, laneIndex, { target, chord })
}

/**
 * "left 5m ago". The verb is the point: the first dialog showed a bare "5m
 * ago" beside a "Now" row, which reads as when each agent was OPENED.
 */
export function leftAgo(at: number, now: number = Date.now()): string {
  // relativeTime reads the clock itself; shift `at` so a caller-supplied
  // `now` (tests, one render tick for a whole list) gives a stable answer.
  const text = relativeTime(at + (Date.now() - now))
  return text === 'just now' ? 'left just now' : `left ${text}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
