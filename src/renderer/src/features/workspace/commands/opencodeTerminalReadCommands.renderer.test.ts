import { describe, expect, it } from 'vitest'

import { readerCommands } from '@renderer/features/reader/commands/readerCommands'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import type { SessionKind } from '@shared/types/providerKind'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// #971: the transcript READ commands must be offered on an OpenCode Terminal
// pane, because #882's Stage 6 loads its committed history into
// `runtime.entries` like every other agent. The pane still renders the native
// TUI — these commands never mount anything on the pane (Reader is a
// full-screen overlay, View Prompts a modal, Copy Last Response a clipboard
// read), which is why they carry no `renderedViewPolicy` and the flip of
// `sessionHasTranscript` is the whole change. Feed-mounted commands staying
// hidden is asserted in agentDisplayMode.test.ts and
// opencodeTerminalHistory.renderer.test.tsx.

function contextWithSession(kind: SessionKind, providerRuntime?: 'terminal'): CommandContext {
  const meta: Record<string, unknown> = { cwd: '/projects/app', kind }
  if (providerRuntime) meta.providerRuntime = providerRuntime
  return {
    workspace: {
      state: {
        activeTabId: 'tab',
        stage: oneLaneStage('agent'),   pinnedSessionIds: [],
        sessions: { agent: { ...meta, projectId: 'tab', joinedAt: 0 }},
        tabs: [{
          id: 'tab',
        }],
      },
    } as unknown as Workspace,
    ui: {},
    flags: {},
  } as unknown as CommandContext
}

function commandIn(commands: CommandDef[], id: string): CommandDef {
  const command = commands.find(candidate => candidate.id === id)
  if (!command) throw new Error(`command ${id} is missing`)
  return command
}

const READ_COMMANDS = [
  { source: readerCommands, id: 'toggle-reader-mode' },
  { source: sessionCommands, id: 'view-prompts' },
  { source: paneCommands, id: 'copy-last-assistant' },
] as const

describe('transcript read commands on an OpenCode Terminal pane', () => {
  it.each(READ_COMMANDS)('$id is offered', ({ source, id }) => {
    const when = commandIn(source, id).when
    if (!when) throw new Error(`${id} lost its when guard`)
    expect(when(contextWithSession('opencode', 'terminal'))).toBe(true)
  })

  it('offers none of them on a plain terminal pane', () => {
    for (const { source, id } of READ_COMMANDS) {
      const when = commandIn(source, id).when
      if (!when) throw new Error(`${id} lost its when guard`)
      expect(when(contextWithSession('terminal')), id).toBe(false)
    }
  })

  it('still hides rewind-to-prompt, whose draft has no TUI composer to land in (#896)', () => {
    const when = commandIn(sessionCommands, 'rewind-to-prompt').when
    if (!when) throw new Error('rewind-to-prompt lost its when guard')
    expect(when(contextWithSession('opencode', 'terminal'))).toBe(false)
  })
})
