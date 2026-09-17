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
  scope?: 'project' | 'global'
  inserted?: boolean
  noTiled?: boolean
} = {}): {
  context: CommandContext
  insertTiledLaneRight: ReturnType<typeof vi.fn>
  enterTiledDispatch: ReturnType<typeof vi.fn>
  showPaneToast: ReturnType<typeof vi.fn>
} {
  const laneIds = options.laneIds ?? ['a', 'b', 'c']
  const focusedLane = options.focusedLane ?? 1
  const liveIds = options.liveIds ?? laneIds.filter((id): id is string => Boolean(id))
  const insertTiledLaneRight = vi.fn().mockReturnValue(options.inserted ?? true)
  const enterTiledDispatch = vi.fn().mockResolvedValue(undefined)
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
      dispatchMode: {
        scope: options.scope ?? 'global',
        // The New Lane entry path (#978): Grid Dispatch not on yet, so there
        // is no `tiled` block to address a lane in.
        ...(options.noTiled ? {} : {
          tiled: {
            lanes: laneIds.map(selectedSessionId => selectedSessionId ? { selectedSessionId } : {}),
            focusedLane,
          },
        }),
      },
      sessions: Object.fromEntries(
        liveIds.map(id => [id, { cwd: `/work/${id}`, kind: 'claude' }]),
      ),
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    },
    insertTiledLaneRight,
    enterTiledDispatch,
    showPaneToast,
  } as unknown as Workspace

  return {
    context: { workspace, ui: {}, flags: {} } as unknown as CommandContext,
    insertTiledLaneRight,
    enterTiledDispatch,
    showPaneToast,
  }
}

describe('New Lane command', () => {
  it('is admitted only for a live tiled coordinate below the lane ceiling', () => {
    expect(newLaneCommand.when?.(commandContext().context)).toBe(true)

    const atCeiling = commandContext({
      laneIds: Array.from({ length: 10 }, (_, index) => `a${index}`),
      focusedLane: 0,
    })
    expect(newLaneCommand.when?.(atCeiling.context)).toBe(false)

    const invalidFocus = commandContext({ laneIds: ['a', 'b'], focusedLane: 2 })
    expect(newLaneCommand.when?.(invalidFocus.context)).toBe(false)

    // #978: without a `tiled` block the command is still admitted — its run
    // enters Grid Dispatch directly instead of being inert. The shape [2] it
    // applies is always legal, so there is no cap to check on this path.
    const classic = commandContext({ noTiled: true })
    classic.context.workspace.state.dispatchMode = { scope: 'global' }
    expect(newLaneCommand.when?.(classic.context)).toBe(true)

    const grid = commandContext({ noTiled: true })
    grid.context.workspace.state.dispatchMode = null
    expect(newLaneCommand.when?.(grid.context)).toBe(true)
  })

  it('enters Grid Dispatch directly when it is not already on', async () => {
    // #978: the user asks for a lane from the normal grid or classic
    // Dispatch. The response is the smallest grid that honors the request —
    // lane 0 seeded with the focused agent (by enterTiledDispatch, #977),
    // lane 1 the new empty lane — not the shape-editor modal.
    const harness = commandContext({ noTiled: true })

    await newLaneCommand.run?.(harness.context)

    expect(harness.enterTiledDispatch).toHaveBeenCalledWith([2])
    // The shape already contains the new lane; inserting again would give the
    // user three lanes for one command.
    expect(harness.insertTiledLaneRight).not.toHaveBeenCalled()
    expect(harness.showPaneToast).not.toHaveBeenCalled()
  })

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

  it('does not send pane feedback to a live session outside project scope', () => {
    // A lane can retain B for one render after project scope moves to A. The
    // session still exists globally, but the layout cannot render it and its
    // healer will replace it; a session-existence check alone would toast a
    // hidden pane that did not originate this visible command.
    const harness = commandContext({
      laneIds: ['a', 'b'],
      focusedLane: 1,
      scope: 'project',
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
