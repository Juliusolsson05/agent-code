import { describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import type { Workspace } from '@renderer/workspace/workspaceStore'

const newLaneCommand = layoutCommands.find(command => command.id === 'new-tiled-lane')
if (!newLaneCommand) throw new Error('New Lane command is missing')

function commandContext(options: {
  laneIds?: Array<string | undefined>
  focusedLane?: number
  liveIds?: string[]
  inserted?: boolean
} = {}): {
  context: CommandContext
  insertTiledLaneRight: ReturnType<typeof vi.fn>
  showPaneToast: ReturnType<typeof vi.fn>
} {
  const laneIds = options.laneIds ?? ['a', 'b', 'c']
  const focusedLane = options.focusedLane ?? 1
  const liveIds = options.liveIds ?? laneIds.filter((id): id is string => Boolean(id))
  const insertTiledLaneRight = vi.fn().mockReturnValue(options.inserted ?? true)
  const showPaneToast = vi.fn()
  const tabs = liveIds.map(id => ({
    id: `tab-${id}`,
    title: `project-${id}`,
    root: { type: 'leaf' as const, sessionId: id },
    focusedSessionId: id,
  }))
  const workspace = {
    state: {
      tabs,
      activeTabId: tabs[0]?.id ?? '',
      stage: {
        lanes: laneIds.map(selectedSessionId => selectedSessionId ? { selectedSessionId } : {}),
        focusedLane,
      },
      sessions: Object.fromEntries(
        liveIds.map(id => [id, { cwd: `/work/${id}`, kind: 'claude' }]),
      ),
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    },
    insertTiledLaneRight,
    showPaneToast,
  } as unknown as Workspace

  return {
    context: { workspace, ui: {}, flags: {} } as unknown as CommandContext,
    insertTiledLaneRight,
    showPaneToast,
  }
}

describe('New Lane command', () => {
  it('is admitted for a live lane coordinate below the lane ceiling', () => {
    expect(newLaneCommand.when?.(commandContext().context)).toBe(true)

    const atCeiling = commandContext({
      laneIds: Array.from({ length: 10 }, (_, index) => `a${index}`),
      focusedLane: 0,
    })
    expect(newLaneCommand.when?.(atCeiling.context)).toBe(false)

    const invalidFocus = commandContext({ laneIds: ['a', 'b'], focusedLane: 2 })
    expect(newLaneCommand.when?.(invalidFocus.context)).toBe(false)

    // The smallest stage there is — a fresh install's single empty lane — must
    // admit the command: growing from one lane is its most common use.
    const fresh = commandContext({ laneIds: [undefined], focusedLane: 0 })
    expect(newLaneCommand.when?.(fresh.context)).toBe(true)
  })

  // Two #978 cases lived here until #992: "always admitted when Grid Dispatch
  // is off" and "enters Grid Dispatch directly when it is not already on"
  // (asserting enterTiledDispatch([2]) and no insert). New Lane had an ENTRY
  // path because a workspace could exist without lanes. The stage is a
  // required field now, so the command only ever inserts and the harness no
  // longer has a lane-less mode to build.

  it('inserts beside the captured focus and confirms in the originating pane', () => {
    const harness = commandContext({ laneIds: ['a', 'b', 'c'], focusedLane: 1 })

    newLaneCommand.run(harness.context)

    expect(harness.insertTiledLaneRight).toHaveBeenCalledWith(1)
    expect(harness.showPaneToast).toHaveBeenCalledWith('b', 'New lane created')
  })

  it('still inserts from an empty lane without inventing a pane-toast target', () => {
    const harness = commandContext({ laneIds: ['a', undefined], focusedLane: 1 })

    newLaneCommand.run(harness.context)

    expect(harness.insertTiledLaneRight).toHaveBeenCalledWith(1)
    expect(harness.showPaneToast).not.toHaveBeenCalled()
  })

  it('does not send pane feedback for a lane whose agent is gone', () => {
    // The focused lane still NAMES 'b', but 'b' is not a live session: the
    // window between a kill from Agent Activity and the clear path blanking
    // the lane. The lane renders empty, so there is no pane this visible
    // command originated from and nothing may be toasted.
    //
    // This case was about PROJECT SCOPE until #992 — a live session the
    // project-scoped index did not list. With no scope, "gone" is the one
    // remaining way a named lane fails to resolve; the property under test
    // (feedback follows the strict visual resolver, not mere presence of an
    // id) is the same.
    const harness = commandContext({
      laneIds: ['a', 'b'],
      focusedLane: 1,
      liveIds: ['a'],
    })

    newLaneCommand.run(harness.context)

    expect(harness.insertTiledLaneRight).toHaveBeenCalledWith(1)
    expect(harness.showPaneToast).not.toHaveBeenCalled()
  })

  it('does not claim success when the reducer refuses a stale invocation', () => {
    const harness = commandContext({ inserted: false })

    newLaneCommand.run(harness.context)

    expect(harness.insertTiledLaneRight).toHaveBeenCalledWith(1)
    expect(harness.showPaneToast).not.toHaveBeenCalled()
  })

  it('re-checks the ceiling in run so non-palette invocation remains inert', () => {
    const harness = commandContext({
      laneIds: Array.from({ length: 10 }, (_, index) => `a${index}`),
      focusedLane: 0,
    })

    newLaneCommand.run(harness.context)

    expect(harness.insertTiledLaneRight).not.toHaveBeenCalled()
    expect(harness.showPaneToast).not.toHaveBeenCalled()
  })
})
