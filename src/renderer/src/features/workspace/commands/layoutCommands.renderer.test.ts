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
} = {}): {
  context: CommandContext
  insertTiledLaneRight: ReturnType<typeof vi.fn>
  showPaneToast: ReturnType<typeof vi.fn>
} {
  const laneIds = options.laneIds ?? ['a', 'b', 'c']
  const focusedLane = options.focusedLane ?? 1
  const liveIds = options.liveIds ?? laneIds.filter((id): id is string => Boolean(id))
  const insertTiledLaneRight = vi.fn()
  const showPaneToast = vi.fn()
  const workspace = {
    state: {
      dispatchMode: {
        scope: 'global',
        tiled: {
          lanes: laneIds.map(selectedSessionId => selectedSessionId ? { selectedSessionId } : {}),
          focusedLane,
        },
      },
      sessions: Object.fromEntries(
        liveIds.map(id => [id, { cwd: `/work/${id}`, kind: 'claude' }]),
      ),
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
  it('is admitted only for a live tiled coordinate below the lane ceiling', () => {
    expect(newLaneCommand.when?.(commandContext().context)).toBe(true)

    const atCeiling = commandContext({
      laneIds: Array.from({ length: 10 }, (_, index) => `a${index}`),
      focusedLane: 0,
    })
    expect(newLaneCommand.when?.(atCeiling.context)).toBe(false)

    const invalidFocus = commandContext({ laneIds: ['a', 'b'], focusedLane: 2 })
    expect(newLaneCommand.when?.(invalidFocus.context)).toBe(false)

    const classic = commandContext()
    classic.context.workspace.state.dispatchMode = { scope: 'global' }
    expect(newLaneCommand.when?.(classic.context)).toBe(false)
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
