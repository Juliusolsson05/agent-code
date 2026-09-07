import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deliverTextToSession } from '@renderer/features/session-text-delivery/deliverTextToSession'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'

// The dispatch matrix (#830): composer draft for rendered agent panes,
// bracketed paste without Enter for every focused PTY (plain terminals
// and agent panes in terminal view share window.api.sendInput).
// window.api is stubbed because the real bridge only exists in the
// packaged app.

const sendInput = vi.fn(async () => {})
const ensureSessionLive = vi.fn(async () => {})
const setDraftInput = vi.fn()

function makeRuntime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return { draftInput: '', processStatus: 'started', ...overrides } as unknown as SessionRuntime
}

type SessionFixture = { kind: string; override?: 'agent' | 'terminal' }

function makeWorkspace(
  sessions: Record<string, SessionFixture>,
  runtimes: Record<string, SessionRuntime>,
): Workspace {
  return {
    state: {
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([id, s]) => [
          id,
          { id, kind: s.kind, agentViewModeOverride: s.override },
        ]),
      ),
    },
    getRuntime: (id: SessionId) => runtimes[id],
    setDraftInput,
    ensureSessionLive,
  } as unknown as Workspace
}

beforeEach(() => {
  sendInput.mockClear()
  ensureSessionLive.mockClear()
  setDraftInput.mockClear()
  ;(globalThis as { window?: unknown }).window = { api: { sendInput } }
})

describe('deliverTextToSession', () => {
  it('appends to the composer draft for a rendered agent pane', async () => {
    const workspace = makeWorkspace(
      { a: { kind: 'claude', override: 'agent' } },
      { a: makeRuntime({ draftInput: 'existing' }) },
    )
    const result = await deliverTextToSession(workspace, 'a', 'new text', { insertMode: 'append' })
    expect(result).toEqual({ delivered: true, surface: 'composer' })
    expect(setDraftInput).toHaveBeenCalledWith('a', 'existing\n\nnew text')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('honors replace insert mode on the composer path', async () => {
    const workspace = makeWorkspace(
      { a: { kind: 'claude', override: 'agent' } },
      { a: makeRuntime({ draftInput: 'existing' }) },
    )
    await deliverTextToSession(workspace, 'a', 'replacement', { insertMode: 'replace' })
    expect(setDraftInput).toHaveBeenCalledWith('a', 'replacement')
  })

  it('bracket-pastes without Enter into a plain terminal pane', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime() })
    const result = await deliverTextToSession(workspace, 't', 'line1\nline2')
    expect(result).toEqual({ delivered: true, surface: 'pty' })
    expect(sendInput).toHaveBeenCalledWith('t', '\x1b[200~line1\nline2\x1b[201~')
    expect(sendInput.mock.calls[0][1].endsWith('\r')).toBe(false)
  })

  it('bracket-pastes into an agent pane in terminal view', async () => {
    const workspace = makeWorkspace(
      { a: { kind: 'claude', override: 'terminal' } },
      { a: makeRuntime() },
    )
    const result = await deliverTextToSession(workspace, 'a', 'key')
    expect(result).toEqual({ delivered: true, surface: 'pty' })
    expect(sendInput).toHaveBeenCalledWith('a', '\x1b[200~key\x1b[201~')
  })

  it('wakes a sleeping backend before writing to a PTY', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime({ processStatus: 'stopped' }) })
    await deliverTextToSession(workspace, 't', 'x')
    expect(ensureSessionLive).toHaveBeenCalledWith('t', 'session-text-delivery', { awaitInputReady: false })
    expect(sendInput).toHaveBeenCalled()
  })

  it('does not wake an already-started backend', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime() })
    await deliverTextToSession(workspace, 't', 'x')
    expect(ensureSessionLive).not.toHaveBeenCalled()
  })

  it('reports no-session for an unknown target', async () => {
    const workspace = makeWorkspace({}, {})
    const result = await deliverTextToSession(workspace, 'gone' as SessionId, 'x')
    expect(result).toEqual({ delivered: false, reason: 'no-session' })
  })
})
