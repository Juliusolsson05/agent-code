import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeTerminalPaste, registerTerminalPasteTarget } from '@renderer/workspace/terminal/textPasteTarget'

import { deliverTextToSession } from '@renderer/features/session-text-delivery/deliverTextToSession'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'

// The dispatch matrix (#830): composer draft for rendered agent panes,
// bracketed paste without Enter for every focused PTY (plain terminals
// and agent panes in terminal view share window.api.sendInput).
// window.api is stubbed because the real bridge only exists in the
// packaged app.

// Typed boolean: main's sendInput resolves false when the write is dropped
// (missing backend / reserved) — the helper must react to that.
const sendInput = vi.fn(async (_id: string, _data: string) => true)
const ensureSessionLive = vi.fn(async () => {})
const setDraftInput = vi.fn()
const registrations: (() => void)[] = []
afterEach(() => { registrations.splice(0).forEach(dispose => dispose()) })

function makeRuntime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return { draftInput: '', processStatus: 'started', ...overrides } as unknown as SessionRuntime
}

type SessionFixture = { kind: string; override?: 'agent' | 'terminal' }

function makeWorkspace(
  sessions: Record<string, SessionFixture>,
  runtimes: Record<string, SessionRuntime>,
): Workspace {
  for (const id of Object.keys(sessions)) {
    registrations.push(registerTerminalPasteTarget(id, {
      isActive: () => true,
      paste: text => sendInput(id, encodeTerminalPaste(text, true)),
    }))
  }
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
  sendInput.mockReset().mockResolvedValue(true)
  ensureSessionLive.mockClear()
  setDraftInput.mockClear()
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
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime({ processStatus: 'exited' }) })
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

  it('reports a refused write without retrying into a potentially changed process', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime() })
    sendInput.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const result = await deliverTextToSession(workspace, 't', 'x')
    expect(result).toEqual({ delivered: false, reason: 'write-rejected' })
    expect(sendInput).toHaveBeenCalledTimes(1)
    expect(ensureSessionLive).not.toHaveBeenCalled()
  })

  it('surfaces write-rejected when the write is dropped', async () => {
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime() })
    sendInput.mockResolvedValue(false)
    const result = await deliverTextToSession(workspace, 't', 'x')
    expect(result).toEqual({ delivered: false, reason: 'write-rejected' })
  })

  it('normalizes a legacy session without kind like TileTree does', async () => {
    // Legacy persisted sessions can lack `kind`; undefined must not read
    // as "rendered" (review finding). With a terminal override the text
    // must reach the PTY.
    const workspace = makeWorkspace(
      { a: { kind: undefined as unknown as string, override: 'terminal' } },
      { a: makeRuntime() },
    )
    const result = await deliverTextToSession(workspace, 'a', 'x')
    expect(result).toEqual({ delivered: true, surface: 'pty' })
  })

  it('cancels a pending wake when the picker closes or the vault locks', async () => {
    let finishWake!: () => void
    let valid = true
    ensureSessionLive.mockImplementationOnce(() => new Promise<void>(resolve => { finishWake = resolve }))
    const workspace = makeWorkspace({ t: { kind: 'terminal' } }, { t: makeRuntime({ processStatus: 'idle' }) })
    const pending = deliverTextToSession(workspace, 't', 'credential', { isCurrent: () => valid })
    valid = false
    finishWake()
    expect(await pending).toEqual({ delivered: false, reason: 'cancelled' })
    expect(sendInput).not.toHaveBeenCalled()
  })
})
