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
  // Only provider I/O is a contract double. The capability uses the actual
  // store, admission, title normalization and provider delivery result shape.
  const capabilities = agentControlCapabilities(() => ({ restoreStatus: 'fresh', ensureSessionLive: wake }) as unknown as Workspace)
  const invoke = (id: string, input: unknown) => capabilities.find(capability => capability.descriptor.id === id)!.execute(input, context)
  return { deliverPrompt, invoke }
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
  expect(result).toMatchObject({ ok: false, error: { outcome: 'unknown', message: JSON.stringify(failure) } })
  expect(deliverPrompt).toHaveBeenCalledTimes(1)
})

it('uses the existing title policy and does not wake agents for metadata reads or edits', async () => {
  const wake = vi.fn().mockResolvedValue(undefined)
  const { invoke } = setup(wake)
  expect(await invoke('agents.titleSet', { sessionId: 'agent', title: '  Named agent  ' })).toMatchObject({ ok: true, value: { title: 'Named agent' } })
  expect(await invoke('agents.locate', { sessionId: 'agent' })).toMatchObject({ ok: true, value: { title: 'Named agent' } })
  expect(wake).not.toHaveBeenCalled()
})
