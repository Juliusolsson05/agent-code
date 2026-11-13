import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import type { HermesConnectionInfo } from '@shared/hermes/types'

import { hermesShellCommands, pickSshConnection } from './hermesShellCommands'

// The focus selector reads Dispatch lanes and takeovers off the full app
// store; which pane is focused is not what these tests are about (that rule
// is pickSshConnection, tested directly below).
vi.mock('@renderer/features/command-palette/commandTarget', () => ({ commandTarget: () => null }))

// Open VPS Terminal / Open Hermes Terminal (#1528). The ssh line itself is
// pinned in src/shared/hermes/ssh.test.ts against the recorded probe; this
// pins the renderer half: which connection, which pane, what gets typed, and
// that an unconfigured server lands the user on the form instead of nowhere.
// Connection values are justified literals (HermesConnectionInfo has no wire
// recording; it is main's own projection).

const originalApi = window.api
afterEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

const conn = (id: string, ssh?: HermesConnectionInfo['ssh']): HermesConnectionInfo => ({
  id, name: id, baseUrl: `https://${id}.example`, createdAt: 0, state: 'ready', identity: null, backend: null, lastError: null, ...(ssh ? { ssh } : {}),
})

function context(options: { focused?: { kind: string; remoteConnectionId?: string }; splitResult?: string | null }) {
  const splitFocused = vi.fn(async () => options.splitResult === undefined ? 'term-1' : options.splitResult)
  const openSettings = vi.fn()
  const ctx = {
    workspace: {
      state: { focusedSessionId: options.focused ? 'focused' : null, sessions: options.focused ? { focused: options.focused } : {} },
      splitFocused,
    },
    ui: { openSettings },
  } as unknown as CommandContext
  return { ctx, splitFocused, openSettings }
}

function bridge(connections: HermesConnectionInfo[], line: { ok: true; command: string; name: string } | { ok: false; error: string }) {
  const value = { hermesList: vi.fn(async () => connections), hermesShellCommand: vi.fn(async () => line), sendInput: vi.fn(async () => true) }
  Object.defineProperty(window, 'api', { configurable: true, value })
  return value
}

const command = (id: string) => hermesShellCommands.find((entry) => entry.id === id)!

describe('Hermes shell commands (#1528)', () => {
  it('opens a terminal and types main\'s ssh line into THAT pane, with Enter', async () => {
    const api = bridge([conn('vps', { destination: 'root@203.0.113.7' })], { ok: true, command: 'ssh -t root@203.0.113.7 docker exec -it hermes bash', name: 'vps' })
    const { ctx, splitFocused } = context({})
    await command('hermes-open-hermes-terminal').run(ctx)
    expect(api.hermesShellCommand).toHaveBeenCalledWith('vps', 'hermes')
    expect(splitFocused).toHaveBeenCalledWith('terminal')
    expect(api.sendInput).toHaveBeenCalledWith('term-1', 'ssh -t root@203.0.113.7 docker exec -it hermes bash\r')
  })

  it('no SSH access anywhere: Settings opens on the form, and no empty terminal is left behind', async () => {
    const api = bridge([conn('vps')], { ok: false, error: 'unused' })
    const { ctx, splitFocused, openSettings } = context({})
    await command('hermes-open-vps-terminal').run(ctx)
    expect(openSettings).toHaveBeenCalledWith('providers')
    expect(splitFocused).not.toHaveBeenCalled()
    expect(api.sendInput).not.toHaveBeenCalled()
  })

  it('Hermes location unknown: same, before any pane opens', async () => {
    bridge([conn('vps', { destination: 'vps' })], { ok: false, error: 'not detected' })
    const { ctx, splitFocused, openSettings } = context({})
    await command('hermes-open-hermes-terminal').run(ctx)
    expect(openSettings).toHaveBeenCalledWith('providers')
    expect(splitFocused).not.toHaveBeenCalled()
  })

  it('a terminal that could not be placed gets nothing typed', async () => {
    const api = bridge([conn('vps', { destination: 'vps' })], { ok: true, command: 'ssh -t vps', name: 'vps' })
    const { ctx } = context({ splitResult: null })
    await command('hermes-open-vps-terminal').run(ctx)
    expect(api.sendInput).not.toHaveBeenCalled()
  })
})

describe('which connection a command uses (plan Ruling 2)', () => {
  const a = conn('a', { destination: 'a' })
  const b = conn('b', { destination: 'b' })
  it('the focused Hermes pane\'s server when it has SSH access', () => {
    expect(pickSshConnection([a, b], 'b')?.id).toBe('b')
  })
  it('otherwise the first server that has SSH access', () => {
    expect(pickSshConnection([conn('plain'), a, b], 'plain')?.id).toBe('a')
    expect(pickSshConnection([a, b], null)?.id).toBe('a')
    expect(pickSshConnection([conn('plain')], null)).toBeNull()
  })
})
