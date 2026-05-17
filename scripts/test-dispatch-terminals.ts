import assert from 'node:assert/strict'

import {
  buildDispatchGroups,
  buildPinnedDispatchRows,
  buildVisibleDispatchRows,
  detachedDispatchSessionIdsForTab,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'
import { readerCommands } from '@renderer/features/reader/commands/readerCommands'
import { copyAssistantCommands } from '@renderer/features/copy-assistant/commands/copyAssistantCommands'
import { copyCodeBlockCommands } from '@renderer/features/copy-code-block/commands/copyCodeBlockCommands'
import type { CommandContext } from '@renderer/features/command-palette/types'
import type { WorkspaceState } from '@renderer/workspace/types'

const baseState: WorkspaceState = {
  activeTabId: 'tab-a',
  dispatchMode: {
    scope: 'project',
    focusedSessionId: 'terminal-grid',
  },
  tabs: [
    {
      id: 'tab-a',
      title: 'Project A',
      focusedSessionId: 'agent-grid',
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: { type: 'leaf', sessionId: 'agent-grid' },
        b: { type: 'leaf', sessionId: 'terminal-grid' },
      },
    },
  ],
  sessions: {
    'agent-grid': {
      cwd: '/repo/agent-grid',
      kind: 'claude',
      providerSessionId: 'provider-agent-grid',
    },
    'terminal-grid': {
      cwd: '/repo/terminal-grid',
      kind: 'terminal',
    },
    'agent-detached': {
      cwd: '/repo/agent-detached',
      kind: 'codex',
      providerSessionId: 'provider-agent-detached',
    },
    'terminal-detached': {
      cwd: '/repo/terminal-detached',
      kind: 'terminal',
    },
    'agent-pinned': {
      cwd: '/repo/agent-pinned',
      kind: 'claude',
      providerSessionId: 'provider-agent-pinned',
    },
    'terminal-pinned': {
      cwd: '/repo/terminal-pinned',
      kind: 'terminal',
    },
  },
  detachedSessions: {
    'agent-detached': {
      sessionId: 'agent-detached',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'Project A',
      projectTabIndex: 0,
      detachedAt: 2,
    },
    'terminal-detached': {
      sessionId: 'terminal-detached',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'Project A',
      projectTabIndex: 0,
      detachedAt: 1,
    },
    'agent-pinned': {
      sessionId: 'agent-pinned',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'Project A',
      projectTabIndex: 0,
      detachedAt: 3,
    },
  },
  buried: [],
  pinnedSessionIds: ['agent-pinned', 'terminal-pinned'],
}

const groups = buildDispatchGroups(baseState)
assert.equal(groups.length, 1)
assert.deepEqual(
  groups[0]?.rows.map(row => [row.sessionId, row.kind, row.placement]),
  [
    ['agent-grid', 'claude', 'grid'],
    ['terminal-grid', 'terminal', 'grid'],
    ['terminal-detached', 'terminal', 'detached'],
    ['agent-detached', 'codex', 'detached'],
  ],
  'Dispatch project groups should include grid and detached terminals in row order',
)

assert.deepEqual(
  detachedDispatchSessionIdsForTab(baseState, 'tab-a'),
  ['terminal-detached', 'agent-detached', 'agent-pinned'],
  'Detached terminal sessions should participate in attach-all ordering',
)

assert.deepEqual(
  buildPinnedDispatchRows(baseState).map(row => row.sessionId),
  ['agent-pinned'],
  'Pinned rows remain agent-only even when a stale terminal id is present',
)

assert.deepEqual(
  buildVisibleDispatchRows(baseState).map(row => row.sessionId),
  ['agent-pinned', 'agent-grid', 'terminal-grid', 'terminal-detached', 'agent-detached'],
  'Visible Dispatch rows should be the keyboard/command order: pins first, then grouped sessions',
)

assert.equal(
  commandTargetSessionIdForState(baseState),
  'terminal-grid',
  'Command targeting should resolve a focused terminal Dispatch row',
)

assert.equal(
  commandTargetSessionIdForState({
    ...baseState,
    dispatchMode: {
      scope: 'project',
      focusedSessionId: 'terminal-detached',
    },
  }),
  'terminal-detached',
  'Command targeting should resolve a focused detached terminal row',
)

const terminalFocusedWorkspace = {
  state: baseState,
  dispatchMode: baseState.dispatchMode,
  activeTab: baseState.tabs[0],
  tileTabs: null,
  getRuntime: () => ({ tailMode: false }),
} as unknown as CommandContext['workspace']

const ctx = {
  workspace: terminalFocusedWorkspace,
  ui: {},
  flags: {},
} as CommandContext

const command = (commands: { id: string; when?: (ctx: CommandContext) => boolean }[], id: string) => {
  const found = commands.find(item => item.id === id)
  assert.ok(found, `missing command ${id}`)
  return found
}

// WHY command guards are tested here:
// Terminal rows intentionally reuse the normal Dispatch command target. That
// is what makes close/focus/attach work, but it also means provider-only
// commands must defend their own transcript/provider assumptions. These checks
// make that split explicit: lifecycle commands can see terminal sessions,
// assistant/transcript commands cannot.
assert.equal(command(paneCommands, 'detach-to-dispatch').when?.(ctx), true)
assert.equal(command(paneCommands, 'toggle-tail').when?.(ctx), false)
assert.equal(command(paneCommands, 'jump-latest-message').when?.(ctx), false)
assert.equal(command(paneCommands, 'copy-last-assistant').when?.(ctx), false)
assert.equal(command(paneCommands, 'linked-agent').when?.(ctx), false)
assert.equal(command(readerCommands, 'toggle-reader-mode').when?.(ctx), false)
assert.equal(command(copyAssistantCommands, 'copy-assistant-message').when?.(ctx), false)
assert.equal(command(copyCodeBlockCommands, 'copy-code-block').when?.(ctx), false)

const detachedTerminalCtx = {
  ...ctx,
  workspace: {
    ...terminalFocusedWorkspace,
    state: {
      ...baseState,
      dispatchMode: {
        scope: 'project',
        focusedSessionId: 'terminal-detached',
      },
    },
    dispatchMode: {
      scope: 'project',
      focusedSessionId: 'terminal-detached',
    },
  } as unknown as CommandContext['workspace'],
} as CommandContext

assert.equal(
  command(paneCommands, 'attach-detached-to-grid').when?.(detachedTerminalCtx),
  true,
  'Detached terminal rows should expose attach-to-grid',
)
