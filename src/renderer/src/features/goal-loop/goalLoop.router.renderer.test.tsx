import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalLoopState } from '@shared/types/goalLoop'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { GoalLoopPane } from './GoalLoopPane'
import { dismissGoalLoop, toggleGoalLoop } from './viewState'

// The latched overlay claims app interaction ownership, so the router's
// ownership branch admits nothing (goal-loop-preview is not in
// SURFACE_OWNER_FLAGS — its latch lives in a feature store, not uiShell).
// Without the dedicated gate in useKeybinds, the overlay is a mouse-only trap
// that kills every app shortcut while latched. These tests drive the REAL
// keyboard router, mirroring tldr.renderer.test.tsx's harness.

const harness = vi.hoisted(() => ({ appState: {} as Record<string, unknown> }))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(harness.appState), { getState: () => harness.appState }),
}))
vi.mock('@renderer/features/global-editor/store', () => ({
  useGlobalEditorStore: Object.assign(() => undefined, { getState: () => ({ editorFullscreen: false }) }),
}))

const loop = (): GoalLoopState => ({
  sessionId: 'a', goal: 'Migrate tests.', loopPrompt: 'Keep migrating.', phase: 'active',
  pauseReason: null, endReason: null, completionSummary: null, maxContinuations: 25,
  continuationsDelivered: 3, consecutiveDeliveryFailures: 0,
  startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
})
const api = {
  readGoalLoops: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, loop()]))),
  controlGoalLoop: vi.fn(async () => loop()),
  onGoalLoopChanged: vi.fn((_listener: () => void) => () => {}),
}

function workspace(): Workspace {
  const runtime = emptyRuntime()
  const tab = { id: 'tab', title: 'Project', focusedSessionId: 'a', root: { type: 'leaf', sessionId: 'a' } }
  return {
    state: { activeTabId: 'tab', tabs: [tab], sessions: { a: { kind: 'claude', cwd: '/project' } }, detachedSessions: {}, buried: [], pinnedSessionIds: [] },
    activeTab: tab, dispatchMode: null, tileTabs: null, spotlight: null, readerMode: null,
    runtimes: { a: runtime }, getRuntime: () => runtime,
  } as unknown as Workspace
}
function Harness({ model }: { model: Workspace }) {
  useKeybinds(model)
  // A composer-like focus target, as in the tldr router harness.
  return <input aria-label="Composer" />
}
function keyDown(options: Record<string, unknown>) {
  return fireEvent.keyDown(document.activeElement ?? document.body, options)
}

beforeEach(() => {
  vi.clearAllMocks()
  dismissGoalLoop()
  Object.assign(window, { api })
  harness.appState = {
    requestCommandInvocation: vi.fn(), settings: { agentViewMode: 'agent', commandKeybindingOverrides: {} },
    settingsPageOpen: false, globalEditorOpen: false, newAgentPlacementOpen: false,
    dispatchAttachIntent: null, linkedAgentParentId: null, reorderTabsOpen: false, pinAgentsOpen: false,
    closeSettingsPage: vi.fn(), closeBuryPrompt: vi.fn(), closeNewAgentPlacement: vi.fn(),
    closeDispatchAttach: vi.fn(), closeLinkedAgent: vi.fn(), closeReorderTabs: vi.fn(), closePinAgents: vi.fn(),
    installedExtensions: [],
  }
})
afterEach(() => { cleanup(); dismissGoalLoop() })

describe('goal loop overlay keyboard dismissal', () => {
  it('Escape dismisses the latched overlay through the router gate', async () => {
    toggleGoalLoop()
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    keyDown({ key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('the Cmd+Shift+Y toggle chord dismisses the latched overlay', async () => {
    toggleGoalLoop()
    render(<><Harness model={workspace()} /><GoalLoopPane sessionId="a" /></>)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    keyDown({ key: 'y', code: 'KeyY', metaKey: true, shiftKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
