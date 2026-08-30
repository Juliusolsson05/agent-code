import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { WorkspaceState } from '@renderer/workspace/types'
import { asRecord } from '@shared/lib/asRecord'

const appState = vi.hoisted(() => ({
  dispatchListRatio: 0.25,
  openNewAgentForProject: vi.fn(),
  setDispatchListRatio: vi.fn(),
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))

vi.mock('@renderer/features/shared/SplitHandle', () => ({
  SplitHandle: () => null,
}))

vi.mock('@renderer/features/shared/useResizableSplitter', () => ({
  useResizableSplitter: () => ({
    dragging: false,
    onMouseDown: vi.fn(),
    cursorLock: null,
  }),
}))

vi.mock('@renderer/workspace/dispatch/DispatchAgentList', () => ({
  DispatchAgentList: () => null,
  DispatchEmpty: ({ message }: { message: string }) => <div>{message}</div>,
}))

vi.mock('@renderer/workspace/dispatch/DispatchMiniList', () => ({
  // The mini-list is only the lane selector. Its store-backed chip rendering
  // is orthogonal to whether the selected row's canonical label reaches the
  // adjacent agent pane, so keeping it out prevents selector UI plumbing from
  // masking the pane-label failure this recorded workspace exists to expose.
  DispatchMiniList: () => null,
}))

vi.mock('@providers/registry.renderer', () => ({
  // WHY mock the provider leaf, not renderWorkspaceLeaf: the contract under
  // test is the label that crosses the shared leaf-render boundary. Mocking
  // renderWorkspaceLeaf itself would erase the exact recomputation bug and
  // merely assert how DispatchLayout called a spy.
  getRendererProvider: () => ({
    TileLeaf: ({
      sessionId,
      paneLabel,
    }: {
      sessionId: string
      paneLabel: string | null
    }) => (
      <div
        data-testid="recorded-provider-leaf"
        data-session-id={sessionId}
        data-pane-label={paneLabel ?? ''}
      >
        {paneLabel}
      </div>
    ),
  }),
}))

type DispatchRecording = {
  state: WorkspaceState
  observed: {
    targetSessionId: string
    targetVisibleLabel: string
    targetLocalLabel: string
  }
}

function loadDispatchRecording(): DispatchRecording {
  const path = resolve(
    process.cwd(),
    'testing/fixtures/worktree-context/dispatch-global-d23.json',
  )
  const fixture = asRecord(JSON.parse(readFileSync(path, 'utf8')))
  const metadata = asRecord(fixture?.$fixture)
  const observed = asRecord(metadata?.observed)
  const state = asRecord(fixture?.state)
  if (!observed || !state) throw new Error('dispatch-global-d23 fixture is malformed')
  return {
    state: state as unknown as WorkspaceState,
    observed: observed as DispatchRecording['observed'],
  }
}

function workspaceFor(state: WorkspaceState): Workspace {
  return {
    state,
    activeTab: state.tabs.find(tab => tab.id === state.activeTabId) ?? null,
    runtimes: {},
    getRuntime: (sessionId: string) => ({
      projectDir: state.sessions[sessionId]?.cwd ?? null,
    }),
    focusDispatchSession: vi.fn(),
    focusSessionInTab: vi.fn(),
    selectGridRelatedSession: vi.fn(),
    setTiledFocusedLane: vi.fn(),
    selectTiledLaneSession: vi.fn(),
  } as unknown as Workspace
}

function renderedPaneFor(container: HTMLElement, sessionId: string): HTMLElement {
  const pane = container.querySelector<HTMLElement>(
    `[data-testid="recorded-provider-leaf"][data-session-id="${sessionId}"]`,
  )
  if (!pane) throw new Error(`recorded pane ${sessionId} did not render`)
  return pane
}

function assertRecordedCoordinate(state: WorkspaceState, recording: DispatchRecording): void {
  const target = buildVisibleDispatchRows(state).find(
    row => row.sessionId === recording.observed.targetSessionId,
  )
  if (!target) throw new Error('recorded D23 row is missing')
  expect(target.label).toBe(recording.observed.targetVisibleLabel)
  expect(paneLabelForSession(state, target.tabId, target.sessionId))
    .toBe(recording.observed.targetLocalLabel)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('recorded Dispatch pane-label ownership', () => {
  it('[dispatch-global-d23] Classic Dispatch repeats the selected visible D23 label', () => {
    const recording = loadDispatchRecording()
    const state = structuredClone(recording.state)
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: recording.observed.targetSessionId,
    }
    assertRecordedCoordinate(state, recording)

    const { container } = render(
      <DispatchLayout
        workspace={workspaceFor(state)}
        agentViewMode="agent"
        showStatusMode
        showWorktreeBadges={false}
      />,
    )

    expect(renderedPaneFor(container, recording.observed.targetSessionId))
      .toHaveAttribute('data-pane-label', recording.observed.targetVisibleLabel)
  })

  it('[dispatch-global-d23] Tiled Dispatch repeats the selected visible D23 label', () => {
    const recording = loadDispatchRecording()
    const state = structuredClone(recording.state)
    const tiled = state.dispatchMode?.tiled
    if (!tiled || tiled.lanes.length === 0) {
      throw new Error('recorded Dispatch fixture lost its tiled lanes')
    }
    state.dispatchMode = {
      ...state.dispatchMode,
      scope: 'global',
      focusedSessionId: recording.observed.targetSessionId,
      tiled: {
        ...tiled,
        focusedLane: 0,
        lanes: tiled.lanes.map((lane, index) => index === 0
          ? { selectedSessionId: recording.observed.targetSessionId }
          : lane),
      },
    }
    assertRecordedCoordinate(state, recording)

    const { container } = render(
      <DispatchLayout
        workspace={workspaceFor(state)}
        agentViewMode="agent"
        showStatusMode
        showWorktreeBadges={false}
      />,
    )

    expect(renderedPaneFor(container, recording.observed.targetSessionId))
      .toHaveAttribute('data-pane-label', recording.observed.targetVisibleLabel)
  })
})
