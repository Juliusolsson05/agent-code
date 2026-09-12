import { afterEach, expect, it, vi } from 'vitest'
import { agentControlCapabilities } from './agents'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/hook'

const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => { useAppStore.setState(original, true); window.api = originalApi })
const context = { requestId: 'trial', caller: { kind: 'external' as const, id: 'operator' },
  owner: { kind: 'window' as const, windowId: 'left', generation: 'one' } }
function setup(wake: () => Promise<unknown> = async () => undefined) {
  useAppStore.setState({ workspaceState: {
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'agent' }, focusedSessionId: 'agent' }],
    activeTabId: 'project', sessions: { agent: { cwd: '/trial', kind: 'claude' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: [], dispatchMode: null,
  }, workspaceRuntimes: { agent: { ...emptyRuntime(), draftInput: 'unfinished human draft' } } })
  const deliverPrompt = vi.fn().mockResolvedValue({ ok: true, acceptance: { kind: 'queue', acceptedAt: 1 } })
  window.api = { ...originalApi, deliverPrompt }
  // focusAgentBySessionId is a spy (not just a stub) so the Reader-Mode/
  // terminal refusal test below can prove agents.show never reaches the
  // actual navigation call when it refuses early.
  const focusAgentBySessionId = vi.fn().mockResolvedValue(true)
  // Only provider I/O is a contract double. The capability uses the actual
  // store, admission, title normalization and provider delivery result shape.
  const capabilities = agentControlCapabilities(() => ({ restoreStatus: 'fresh', ensureSessionLive: wake, focusAgentBySessionId }) as unknown as Workspace)
  const invoke = (id: string, input: unknown) => capabilities.find(capability => capability.descriptor.id === id)!.execute(input, context)
  return { deliverPrompt, invoke, focusAgentBySessionId }
}

it('keeps the named prompt target and composer draft, and reports queue acceptance honestly', async () => {
  const { invoke, deliverPrompt } = setup()
  expect(await invoke('agents.prompt', { sessionId: 'agent', prompt: 'next task' })).toMatchObject({
    ok: true, value: { sessionId: 'agent', acceptance: { kind: 'queue' } },
  })
  expect(deliverPrompt).toHaveBeenCalledExactlyOnceWith('agent', 'next task')
  expect(useAppStore.getState().workspaceRuntimes.agent.draftInput).toBe('unfinished human draft')
})

it('revalidates the exact agent after waking and never writes to a replacement', async () => {
  const { invoke, deliverPrompt } = setup(async () => {
    useAppStore.getState().setWorkspaceState(state => ({ ...state, sessions: { replacement: { cwd: '/trial', kind: 'claude' } } }))
  })
  expect(await invoke('agents.prompt', { sessionId: 'agent', prompt: 'next task' })).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(deliverPrompt).not.toHaveBeenCalled()
})

it('does not retry an uncertain provider write and keeps its delivery evidence', async () => {
  const { invoke, deliverPrompt } = setup()
  const failure = { ok: false, stage: 'after-enter', code: 'acceptance-timeout', message: 'No acknowledgement',
    retrySafe: false, disposition: 'do-not-retry', promptWritten: true, enterWritten: true }
  deliverPrompt.mockResolvedValue(failure)
  const result = await invoke('agents.prompt', { sessionId: 'agent', prompt: 'next task' })
  expect(result).toMatchObject({ ok: false, error: { outcome: 'unknown', message: failure.message, details: failure } })
  expect(deliverPrompt).toHaveBeenCalledTimes(1)
})

it('uses the existing title policy and does not wake agents for metadata reads or edits', async () => {
  const wake = vi.fn().mockResolvedValue(undefined)
  const { invoke } = setup(wake)
  expect(await invoke('agents.titleSet', { sessionId: 'agent', title: '  Named agent  ' })).toMatchObject({ ok: true, value: { title: 'Named agent' } })
  expect(await invoke('agents.locate', { sessionId: 'agent' })).toMatchObject({ ok: true, value: { title: 'Named agent' } })
  expect(wake).not.toHaveBeenCalled()
})

// Attachment inputs exercise the actual provider boundary above; unsupported
// providers must reject before wake, rather than silently discard attachments.
it('forwards supported attachment paths without changing the app draft, and rejects unsupported providers before wake', async () => {
  const wake = vi.fn().mockResolvedValue(undefined)
  const { invoke, deliverPrompt } = setup(wake)
  expect(await invoke('agents.prompt', { sessionId: 'agent', prompt: 'inspect image', imagePaths: ['/tmp/operator-image.png'] })).toMatchObject({ ok: true })
  expect(deliverPrompt).toHaveBeenCalledWith('agent', 'inspect image', ['/tmp/operator-image.png'])
  expect(useAppStore.getState().workspaceRuntimes.agent.draftInput).toBe('unfinished human draft')
  useAppStore.getState().setWorkspaceState(state => ({ ...state, sessions: { agent: { cwd: '/trial', kind: 'codex' } } }))
  wake.mockClear(); deliverPrompt.mockClear()
  expect(await invoke('agents.prompt', { sessionId: 'agent', prompt: 'inspect image', imagePaths: ['/tmp/operator-image.png'] })).toMatchObject({ ok: false, error: { outcome: 'not_started' } })
  expect(wake).not.toHaveBeenCalled(); expect(deliverPrompt).not.toHaveBeenCalled()
})

it('finds an agent by its spoken name from the window-local index too, not only from agents.search', async () => {
  // WHY this belongs next to the global-search coverage in
  // agentNames.renderer.test.ts: an operator reaches for whichever of the two
  // find-an-agent tools its client exposes, and the only intended difference
  // between them is window scope. agents.list omitted agentName from its
  // free-text haystack, so "search for apoll" recovered a partially heard name
  // globally and found nothing in the window that actually holds the agent.
  const { invoke } = setup()
  useAppStore.getState().setWorkspaceState(state => ({
    ...state, sessions: { agent: { ...state.sessions.agent, agentNameId: 'identity-one' } },
  }))
  useAppStore.setState({ workspaceAgentNames: { 'identity-one': 'Apollo' },
    settings: { ...useAppStore.getState().settings, agentNamesEnabled: true } })

  expect(await invoke('agents.list', { query: 'apoll' })).toMatchObject({
    ok: true, value: { total: 1, items: [{ sessionId: 'agent', agentName: 'Apollo' }] },
  })
  // Substring over the whole haystack, never an address: the exact-name rule
  // stays in agents.search, and an unrelated name still matches nothing.
  expect(await invoke('agents.list', { query: 'jasper' })).toMatchObject({ ok: true, value: { total: 0 } })

  // With the setting off there is no name to match, exactly as agents.search
  // reports — the observation is the single gate for both.
  useAppStore.setState({ settings: { ...useAppStore.getState().settings, agentNamesEnabled: false } })
  expect(await invoke('agents.list', { query: 'apoll' })).toMatchObject({ ok: true, value: { total: 0 } })
})

it('treats a terminal as a session for metadata and navigation, but never as a prompt target (#865)', async () => {
  const { invoke, deliverPrompt } = setup()
  useAppStore.getState().setWorkspaceState(state => ({
    ...state,
    sessions: { ...state.sessions, shell: { cwd: '/trial', kind: 'terminal' } },
    tabs: [{ ...state.tabs[0], root: { type: 'split', direction: 'vertical', ratio: 0.5,
      a: { type: 'leaf', sessionId: 'agent' }, b: { type: 'leaf', sessionId: 'shell' } } }],
  }))

  expect(await invoke('agents.titleSet', { sessionId: 'shell', title: 'dev server' }))
    .toMatchObject({ ok: true, value: { title: 'dev server' } })
  expect(await invoke('agents.locate', { sessionId: 'shell' }))
    .toMatchObject({ ok: true, value: { provider: 'terminal', title: 'dev server' } })
  expect(await invoke('agents.list', { query: 'dev server' }))
    .toMatchObject({ ok: true, value: { items: [expect.objectContaining({ sessionId: 'shell' })] } })

  // The refusal carries the route an operator should take instead, and it
  // happens before any wake or provider write.
  const refused = await invoke('agents.prompt', { sessionId: 'shell', prompt: 'ls' })
  expect(refused).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(JSON.stringify(refused)).toContain('terminals.input')
  expect(deliverPrompt).not.toHaveBeenCalled()
})

// Reader Mode is agent-only (Design D2): it renders a provider-registered
// transcript view, which a terminal has none of. requireSession stopped
// refusing terminals in the #865 work above, which made this capability the
// thing actually standing between an operator's "show" request and pointing
// Reader Mode at a session it can't render — so the refusal, and the fact
// that it happens before any navigation call, are both load-bearing here.
it('refuses to show a terminal while Reader Mode owns the screen, before any navigation (#865)', async () => {
  const { invoke, focusAgentBySessionId } = setup()
  useAppStore.getState().setWorkspaceState(state => ({
    ...state,
    sessions: { ...state.sessions, shell: { cwd: '/trial', kind: 'terminal' } },
    tabs: [{ ...state.tabs[0], root: { type: 'split', direction: 'vertical', ratio: 0.5,
      a: { type: 'leaf', sessionId: 'agent' }, b: { type: 'leaf', sessionId: 'shell' } } }],
  }))
  useAppStore.setState({ workspaceReaderMode: { tabId: 'project', focusedSessionId: 'agent' } })

  const result = await invoke('agents.show', { sessionId: 'shell' })
  expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(focusAgentBySessionId).not.toHaveBeenCalled()
})
