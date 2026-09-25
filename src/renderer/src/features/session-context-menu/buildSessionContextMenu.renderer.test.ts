import { describe, expect, it } from 'vitest'

import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { PopupMenuItem } from '@shared/types/popupMenu'

import { controlReference } from './controlReference'
import {
  buildSessionContextMenu,
  parseSessionMenuChoice,
  type SessionMenuRequest,
} from './buildSessionContextMenu'

// Menus built from the REAL catalog over the recorded 24-agent workspace
// (`dispatch-global-d23.json`), not a mocked registry: what these pin is the
// user-visible result of every opted-in command's own `when` for each kind of
// row — which is exactly what a mocked registry would have replaced with the
// test author's belief about it. Session choices, all from the recording:
//   session-23  Claude, detached worktree child, in no lane (the menu's case)
//   session-12  Codex, shown in lane 0
//   session-15  a plain terminal
// Provider ids are added where noted: the recording was scrubbed of them, and
// the commands that need one (reload, rewind, duplicate, copy resume) would
// otherwise all be hidden, hiding the ordinary menu along with them.

const CLAUDE = 'session-23' as SessionId
const CODEX = 'session-12' as SessionId
const TERMINAL = 'session-15' as SessionId
const VIEW = 'extension-view-1' as SessionId

function workspaceState(): WorkspaceState {
  const recorded = loadRecordedDispatchWorkspace().state
  return {
    ...recorded,
    sessions: {
      ...recorded.sessions,
      [CLAUDE]: { ...recorded.sessions[CLAUDE]!, providerSessionId: 'provider-claude' },
      [CODEX]: { ...recorded.sessions[CODEX]!, providerSessionId: 'provider-codex' },
      // No extension view was running when the recording was made; this is
      // the shape sessionOwnership.test.ts uses for one.
      [VIEW]: { cwd: '', kind: 'extension-view', extensionViewId: 'timer.main', projectId: recorded.sessions[CODEX]!.projectId, joinedAt: 1 },
    },
  }
}

function menu(
  sessionId: SessionId,
  options: {
    state?: WorkspaceState
    request?: Partial<SessionMenuRequest>
    colorFlag?: 'red'
    spotlightSessionId?: SessionId
    keybindingOverrides?: Record<string, string[]>
  } = {},
): PopupMenuItem[] {
  const state = options.state ?? workspaceState()
  const ctx = {
    workspace: { state, getRuntime: () => emptyRuntime() } as unknown as Workspace,
    ui: {},
    flags: { commandKeybindingOverrides: options.keybindingOverrides ?? {}, agentViewMode: 'rendered' },
    target: sessionId,
  } as unknown as CommandContext
  return buildSessionContextMenu({
    request: { sessionId, showInLane: { label: 'Lane 2', run: () => {} }, goalLoopLive: false, ...options.request },
    ctx,
    colorFlag: options.colorFlag,
    spotlightSessionId: options.spotlightSessionId ?? null,
  })
}

/** The menu as the user reads it: labels, `—` for separators, submenus inline. */
function labels(items: PopupMenuItem[]): string[] {
  return items.map(item => {
    if (item.type === 'separator') return '—'
    if (item.type === 'submenu') return `${item.label} ▸`
    return item.enabled === false ? `${item.label} (disabled)` : item.label
  })
}

describe('buildSessionContextMenu', () => {
  it('gives a Claude agent in no lane the whole D4 menu, grouped', () => {
    expect(labels(menu(CLAUDE))).toEqual([
      'Show in Lane 2', 'Show in Spotlight',
      '—',
      'Set Title…', 'Color Flag ▸', 'Pin Session',
      '—',
      'Reload Agent', 'Switch Provider…', 'Agent MCP Servers…', 'Duplicate Agent',
      'Rewind to Prompt…', 'View Prompts…', 'TLDR History…', 'Goal History…',
      '—',
      'Copy Resume Command', 'Copy Last Response',
      '—',
      'Close Agent',
    ])
  })

  it('offers a Codex agent the same agent actions', () => {
    expect(labels(menu(CODEX))).toEqual(labels(menu(CLAUDE)))
  })

  it('gives a terminal only the open, identity and Close groups', () => {
    // Every agent action's `when` refuses a terminal, and both copy commands
    // need a transcript. Nothing here special-cases terminals.
    expect(labels(menu(TERMINAL))).toEqual([
      'Show in Lane 2', 'Show in Spotlight',
      '—',
      'Set Title…', 'Color Flag ▸', 'Pin Session',
      '—',
      'Close Agent',
    ])
  })

  it('gives an extension view no Pin, since pinning refuses views', () => {
    expect(labels(menu(VIEW))).toEqual([
      'Show in Lane 2', 'Show in Spotlight',
      '—',
      'Set Title…', 'Color Flag ▸',
      '—',
      'Close Agent',
    ])
  })

  it('swaps Pin for Unpin on a pinned agent', () => {
    const state = workspaceState()
    state.pinnedSessionIds = [CLAUDE]
    const items = labels(menu(CLAUDE, { state }))
    expect(items).toContain('Unpin Session')
    expect(items).not.toContain('Pin Session')
  })

  it('drops Show in Lane for a disabled row, and Spotlight when already spotlit', () => {
    const items = labels(menu(CLAUDE, { request: { showInLane: undefined }, spotlightSessionId: CLAUDE }))
    expect(items[0]).toBe('Set Title…')
  })

  it('offers Stop Goal Loop only while the row\'s loop is live', () => {
    expect(labels(menu(CLAUDE))).not.toContain('Stop Goal Loop')
    const live = labels(menu(CLAUDE, { request: { goalLoopLive: true } }))
    expect(live.indexOf('Stop Goal Loop')).toBe(live.indexOf('Goal History…') + 1)
  })

  it('checks the current colour flag, and None when there is none', () => {
    const flagMenu = (items: PopupMenuItem[]) =>
      items.find((item): item is Extract<PopupMenuItem, { type: 'submenu' }> => item.type === 'submenu')!.items
    const checked = (items: PopupMenuItem[]) =>
      items.filter(item => item.type === 'item' && item.checked).map(item => item.type === 'item' && item.id)
    expect(checked(flagMenu(menu(CLAUDE, { colorFlag: 'red' })))).toEqual(['flag:red'])
    expect(checked(flagMenu(menu(CLAUDE)))).toEqual(['flag:none'])
  })

  it('shows the effective shortcut, including a user rebinding', () => {
    const close = (items: PopupMenuItem[]) =>
      items.find(item => item.type === 'item' && item.id === 'command:close-pane') as Extract<PopupMenuItem, { type: 'item' }>
    expect(close(menu(CLAUDE)).accelerator).toBe('Command+W')
    expect(close(menu(CLAUDE, { keybindingOverrides: { 'close-pane': ['Cmd+Shift+K'] } })).accelerator)
      .toBe('Command+Shift+K')
  })

  it('round-trips every item id it emits back to a choice', () => {
    const ids: string[] = []
    const walk = (items: PopupMenuItem[]) => items.forEach(item => {
      if (item.type === 'item') ids.push(item.id)
      if (item.type === 'submenu') walk(item.items)
    })
    walk(menu(CLAUDE, { request: { goalLoopLive: true } }))
    for (const id of ids) {
      const choice = parseSessionMenuChoice(id)
      expect(choice, id).not.toBeNull()
      if (choice?.kind === 'command') {
        expect(builtInCommandCatalog.some(command => command.id === choice.commandId)).toBe(true)
      }
    }
    expect(parseSessionMenuChoice('flag:chartreuse')).toBeNull()
    expect(parseSessionMenuChoice('reload-agent')).toBeNull()
  })
})

it('documents exactly the commands that opted into the menu', () => {
  // The control reference is what agents and the help page read; a command
  // added to (or dropped from) the menu without it would be undocumented.
  const flagged = builtInCommandCatalog.filter(command => command.contextMenu).map(command => command.id)
  expect([...controlReference[0]!.commandIds].sort()).toEqual(flagged.sort())
})
