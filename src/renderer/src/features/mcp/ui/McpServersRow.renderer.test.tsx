import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { uniformBuiltInMcpDefaults } from '@mcp/shared/types'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import { useUserMcpStore } from '@renderer/features/mcp/store'
import { useProviderEnablementStore } from '@renderer/features/providers/store'
import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'
import type { UserMcpServerView } from '@shared/userMcp/types'

import { McpServerDialog } from './McpServerDialog'
import { McpServersRow } from './McpServersRow'
import { useAppStore } from '@renderer/app-state/store'

const originalMcp = useUserMcpStore.getState()
const originalProviders = useProviderEnablementStore.getState()
const originalApp = useAppStore.getState()

const TOKEN = 'bpr_live_9f3a1c7d'

function server(overrides: Partial<UserMcpServerView> = {}): UserMcpServerView {
  return {
    id: 'srv-beeper',
    name: 'beeper',
    enabled: true,
    providers: { claude: true, codex: false },
    entry: { type: 'http', url: 'http://localhost:23373/v0/mcp', headers: { Authorization: 'Bearer ${input:beeper-authorization}' } },
    inputs: [{ id: 'beeper-authorization', description: 'Header Authorization' }],
    transport: 'http',
    summary: 'localhost:23373/v0/mcp',
    secrets: { 'beeper-authorization': { set: true, hint: '1c7d' } },
    problems: [],
    support: { claude: { ok: true }, codex: { ok: true } },
    ...overrides,
  }
}

function enable(kinds: string[]) {
  const snapshot = {
    entries: ['claude', 'codex', 'opencode', 'grok'].map(kind => ({ kind, enabled: kinds.includes(kind), installed: true, because: 'detected' })),
  } as unknown as ProviderEnablementSnapshot
  useProviderEnablementStore.getState().setSnapshot(snapshot)
}

const api = {
  userMcpSetProvider: vi.fn(async () => ({ ok: false, error: 'not in this test' })),
  userMcpSetEnabled: vi.fn(async () => ({ ok: false, error: 'not in this test' })),
  userMcpImport: vi.fn(),
  userMcpSave: vi.fn(),
  userMcpDelete: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api: { ...window.api, ...api } })
  useUserMcpStore.setState({ snapshot: { servers: [server()], native: [], claudeManagedPolicy: false } })
  enable(['claude', 'codex'])
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useUserMcpStore.setState(originalMcp, true)
  useProviderEnablementStore.setState(originalProviders, true)
  useAppStore.setState(originalApp, true)
})

describe('Settings → MCP grid', () => {
  it('shows a column only for providers enabled in Settings → Providers', () => {
    render(<McpServersRow settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'beeper for new Claude agents' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /for new Grok agents/ })).toBeNull()
  })

  it('writes a built-in default for ONE provider without touching the others', () => {
    const onChange = vi.fn()
    const settings = { ...DEFAULT_SETTINGS, defaultBuiltInMcpDomains: uniformBuiltInMcpDefaults(['tldr']) }
    render(<McpServersRow settings={settings} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Orchestration for new Codex agents' }))
    const next = onChange.mock.calls[0]![0].defaultBuiltInMcpDomains
    expect(next.codex).toEqual(['tldr', 'orchestration'])
    expect(next.claude).toEqual(['tldr'])
  })

  it('does not offer Workflows as a Claude default, because Claude has workflows natively', () => {
    render(<McpServersRow settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect(screen.queryByRole('checkbox', { name: 'Workflows for new Claude agents' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Workflows for new Codex agents' })).toBeTruthy()
  })

  it('shows an SSE server as Claude-only, with the reason, instead of a Codex checkbox', () => {
    useUserMcpStore.setState({
      snapshot: {
        servers: [server({ name: 'linear', transport: 'sse', support: { claude: { ok: true }, codex: { ok: false, reason: 'Codex does not support SSE servers' } } })],
        native: [],
        claudeManagedPolicy: false,
      },
    })
    render(<McpServersRow settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect(screen.queryByRole('checkbox', { name: 'linear for new Codex agents' })).toBeNull()
    expect(screen.getByLabelText('Codex does not support SSE servers')).toBeTruthy()
  })

  it('writes a user-server provider choice to main, not to renderer Settings', () => {
    const onChange = vi.fn()
    render(<McpServersRow settings={DEFAULT_SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'beeper for new Codex agents' }))
    expect(api.userMcpSetProvider).toHaveBeenCalledWith('srv-beeper', 'codex', true)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('MCP server dialog', () => {
  it('never renders a stored secret, only its hint', () => {
    useAppStore.setState({ mcpServerDialog: { mode: 'edit', serverId: 'srv-beeper' } })
    render(<McpServerDialog />)
    const field = screen.getByLabelText('Secret beeper-authorization')
    expect((field as HTMLInputElement).value).toBe('')
    expect(field.getAttribute('placeholder')).toContain('1c7d')
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('adds every server found in a pasted snippet, with its lifted secrets', async () => {
    api.userMcpImport.mockResolvedValue({
      ok: true,
      format: 'mcpServers',
      candidates: [{
        name: 'beeper',
        entry: { type: 'http', url: 'http://localhost:23373/v0/mcp', headers: { Authorization: 'Bearer ${input:beeper-authorization}' } },
        inputs: [{ id: 'beeper-authorization', description: 'Header Authorization' }],
        pendingSecrets: { 'beeper-authorization': TOKEN },
        problems: [],
      }],
    })
    api.userMcpSave.mockResolvedValue({ ok: true, snapshot: { servers: [], native: [], claudeManagedPolicy: false } })
    useAppStore.setState({ mcpServerDialog: { mode: 'add' } })
    // The paste box debounces before asking main to parse. Driving that timer
    // explicitly keeps the test deterministic under load instead of racing a
    // real 250 ms timer against findBy's polling budget.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<McpServerDialog />)
    fireEvent.change(screen.getByLabelText('MCP server config'), { target: { value: '{"mcpServers":{}}' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    vi.useRealTimers()
    const card = screen.getByLabelText('Server name')
    expect((card as HTMLInputElement).value).toBe('beeper')
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await vi.waitFor(() => expect(api.userMcpSave).toHaveBeenCalledTimes(1))
    expect(api.userMcpSave.mock.calls[0]![0]).toMatchObject({
      name: 'beeper',
      providers: { claude: true, codex: true },
      secrets: { 'beeper-authorization': TOKEN },
    })
    // Closing is the store's job; Radix animates the DOM out asynchronously.
    await vi.waitFor(() => expect(useAppStore.getState().mcpServerDialog).toBeNull())
  })
})
