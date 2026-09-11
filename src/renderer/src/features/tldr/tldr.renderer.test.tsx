import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { TldrPane } from './TldrOverlay'
import { dismissTldr, toggleTldr, useTldrView } from './viewState'
import type { TldrRecord, TldrUpdate } from '@shared/types/tldr'

const harness = vi.hoisted(() => ({ appState: {} as Record<string, unknown> }))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(harness.appState), { getState: () => harness.appState }),
}))
vi.mock('@renderer/features/global-editor/store', () => ({
  useGlobalEditorStore: Object.assign(() => undefined, { getState: () => ({ editorFullscreen: false }) }),
}))

const releaseListeners = new Set<(token: string) => void>()
const listeners = new Set<(update: TldrUpdate) => void>()
const report = (text: string, revision = 1): TldrRecord => ({ text, revision, updatedAt: '2026-09-11T00:00:00.000Z' })
const api = {
  startTldrHold: vi.fn((_code: string, _token: string) => {}),
  stopTldrHold: vi.fn((_token: string) => {}),
  onTldrHoldReleased: vi.fn((listener: (token: string) => void) => { releaseListeners.add(listener); return () => { releaseListeners.delete(listener) } }),
  readTldrs: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, report(`Summary for ${id}.`)]))),
  onTldrChanged: vi.fn((listener: (update: TldrUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
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
function Harness({ model = workspace() }: { model?: Workspace }) {
  useKeybinds(model)
  return <input aria-label="Composer" />
}
function keyDown(target: Document | Element = document, options: Record<string, unknown> = {}) {
  return fireEvent.keyDown(target, { key: 'l', code: 'KeyL', metaKey: true, ...options })
}
beforeEach(() => {
  dismissTldr()
  listeners.clear()
  releaseListeners.clear()
  api.startTldrHold.mockClear()
  api.stopTldrHold.mockClear()
  api.readTldrs.mockClear()
  api.onTldrChanged.mockClear()
  Object.assign(window, { api })
  harness.appState = {
    requestCommandInvocation: vi.fn(), settings: { agentViewMode: 'agent', commandKeybindingOverrides: {} },
    settingsPageOpen: false, globalEditorOpen: false, newAgentPlacementOpen: false,
    dispatchAttachIntent: null, linkedAgentParentId: null, reorderTabsOpen: false, pinAgentsOpen: false,
    closeSettingsPage: vi.fn(), closeBuryPrompt: vi.fn(), closeNewAgentPlacement: vi.fn(),
    closeDispatchAttach: vi.fn(), closeLinkedAgent: vi.fn(), closeReorderTabs: vi.fn(), closePinAgents: vi.fn(),
  }
})
afterEach(() => { cleanup(); dismissTldr() })

describe('TLDR hold input', () => {
  it('handles the native L release and ignores a release token from an earlier gesture', () => {
    render(<Harness />)
    keyDown()
    expect(api.startTldrHold).toHaveBeenCalledTimes(1)
    const first = api.startTldrHold.mock.calls[0]![1]
    fireEvent.blur(window)
    keyDown()
    expect(api.startTldrHold).toHaveBeenCalledTimes(2)
    const second = api.startTldrHold.mock.calls[1]![1]
    act(() => { for (const listener of releaseListeners) listener(first) })
    expect(useTldrView.getState().held).toBe(true)
    act(() => { for (const listener of releaseListeners) listener(second) })
    expect(useTldrView.getState().held).toBe(false)
    expect(releaseListeners.size).toBe(0)
    expect(api.stopTldrHold).toHaveBeenLastCalledWith(second)
  })

  it.each(['KeyL', 'MetaLeft'])('shows on press and hides when %s is released', code => {
    render(<Harness />)
    expect(keyDown(screen.getByLabelText('Composer'))).toBe(false)
    expect(useTldrView.getState().held).toBe(true)
    fireEvent.keyUp(document, { code, key: code === 'KeyL' ? 'l' : 'Meta', metaKey: code === 'KeyL' })
    expect(useTldrView.getState().held).toBe(false)
    expect(harness.appState.requestCommandInvocation).not.toHaveBeenCalled()
  })

  it('survives workspace rerenders, ignores repeats, and clears on blur', () => {
    const view = render(<Harness />)
    keyDown()
    view.rerender(<Harness model={workspace()} />)
    keyDown(document, { repeat: true })
    expect(useTldrView.getState().held).toBe(true)
    fireEvent.blur(window)
    expect(useTldrView.getState().held).toBe(false)
    keyDown(document, { repeat: true })
    expect(useTldrView.getState().held).toBe(false)
  })

  it('uses the effective binding for both press and release', () => {
    harness.appState.settings = { agentViewMode: 'agent', commandKeybindingOverrides: { 'tldr-preview': ['Alt+B'] } }
    render(<Harness />)
    keyDown()
    expect(useTldrView.getState().held).toBe(false)
    keyDown(document, { code: 'KeyB', key: '∫', metaKey: false, altKey: true })
    expect(useTldrView.getState().held).toBe(true)
    fireEvent.keyUp(document, { code: 'AltLeft', key: 'Alt', altKey: false })
    expect(useTldrView.getState().held).toBe(false)
  })

  it('yields Cmd+L to the editor and respects app modals', () => {
    render(<><Harness /><div data-global-editor-input-owner=""><textarea aria-label="Editor" /></div></>)
    expect(keyDown(screen.getByLabelText('Editor'))).toBe(true)
    expect(useTldrView.getState().held).toBe(false)
    const modal = document.createElement('div')
    modal.setAttribute('data-agent-code-interaction-owner', 'app')
    document.body.append(modal)
    keyDown()
    expect(useTldrView.getState().held).toBe(false)
    modal.remove()
  })

  it('supports a latched palette preview and Escape without forwarding input', () => {
    render(<Harness />)
    act(toggleTldr)
    expect(fireEvent.keyDown(screen.getByLabelText('Composer'), { key: 'x', code: 'KeyX' })).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    expect(useTldrView.getState()).toMatchObject({ held: false, latched: false })
  })
})

describe('TLDR pane overlay', () => {
  it('shows each pane’s own entry while leaving the underlying view mounted', async () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    function Content() { useEffect(() => { mounted(); return unmounted }, []); return <input defaultValue="Unsent draft" aria-label="Draft" /> }
    render(<><TldrPane identity="agent-a" enabled><Content /></TldrPane><TldrPane identity="agent-b" enabled><div>Raw terminal</div></TldrPane></>)
    expect(api.readTldrs).not.toHaveBeenCalled()
    const input = screen.getByLabelText('Draft')
    act(toggleTldr)
    await screen.findByText('Summary for agent-a.')
    await screen.findByText('Summary for agent-b.')
    expect(screen.getAllByRole('note')).toHaveLength(2)
    act(dismissTldr)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByLabelText('Draft')).toBe(input)
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('keeps a newer update when an older snapshot arrives later', async () => {
    let resolve!: (records: Record<string, TldrRecord>) => void
    api.readTldrs.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    act(toggleTldr)
    render(<TldrPane identity="agent-a" enabled><div /></TldrPane>)
    act(() => { for (const listener of listeners) listener({ identity: 'agent-a', record: report('New result.', 2) }) })
    await act(async () => { resolve({ 'agent-a': report('Old result.', 1) }) })
    expect(screen.getByText('New result.')).toBeTruthy()
    expect(screen.queryByText('Old result.')).toBeNull()
  })

  it('distinguishes disabled reporting from a missing report and never shows another identity’s text', async () => {
    act(toggleTldr)
    api.readTldrs.mockResolvedValueOnce({})
    const view = render(<><TldrPane identity="a" enabled={false}><div /></TldrPane><TldrPane identity="b" enabled><div /></TldrPane></>)
    expect(screen.getByText('TLDR is off')).toBeTruthy()
    await waitFor(() => expect(api.readTldrs).toHaveBeenCalledWith(['b']))
    expect(screen.getByText('No TLDR yet')).toBeTruthy()
    view.rerender(<TldrPane identity="c" enabled><div /></TldrPane>)
    await screen.findByText('Summary for c.')
    expect(screen.queryByText('Summary for b.')).toBeNull()
  })
})
