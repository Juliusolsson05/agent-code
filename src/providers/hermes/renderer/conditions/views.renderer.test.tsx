import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { connectionOperation, type HermesConnectionOperation, type HermesRequest } from 'hermes-headless'
import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import { conditionRecord, connectionConditionRecord } from '@providers/hermes/runtime/hermesSession'
import { hermesApprovalView, hermesClarifyView, hermesConnectionView, hermesSecretView } from '@providers/hermes/renderer/conditions/views'
import { HERMES_ANSWER, validateAnswer, validateConnectionAnswer } from '@providers/hermes/runtime/requestAnswers'
import { RendererHostProvider, type RendererHost } from '@renderer/features/rendererHost/RendererHostContext'
import type { ConditionAction, ConditionCustomAction } from '@shared/conditions-core/contract'

// The cards render the condition records HermesSession builds from RECORDED
// requests (hermes-headless research/corpus S5 approval, S6 clarify/secret).
// What a card dispatches is then checked against the runtime's validator, the
// trust boundary that makes a view able to compose an answer but not invent one.

function request(method: string, scenario: string): HermesRequest {
  const frame = inboundFrames(latestRecording(scenario)).find((entry) => entry.method === method)!
  return { id: String(frame.id), method: method as HermesRequest['method'], params: frame.params as Record<string, unknown>, replayed: false }
}

function mount(view: { Component: React.ComponentType<{ state: unknown; actions: ConditionAction[]; dispatch: (action: ConditionAction) => Promise<void>; interactionActive: boolean }> }, req: HermesRequest) {
  const record = conditionRecord(req, 0)
  const dispatch = vi.fn(async (_action: ConditionAction) => undefined)
  const View = view.Component
  render(<View state={record.state} actions={record.actions} dispatch={dispatch} interactionActive />)
  return dispatch
}

describe('Hermes condition cards', () => {
  it('approval: shows the redacted command and answers with one of Hermes\' offered choices', () => {
    const req = request('approval', 'S5')
    const dispatch = mount(hermesApprovalView as never, req)
    expect(screen.getByText(/rm -r \/tmp\/hh-approval-probe-dir-does-not-exist/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    const action = dispatch.mock.calls[0]![0] as ConditionCustomAction
    expect(validateAnswer(req, (action.payload as { result: unknown }).result)).toEqual({ choice: 'once' })
  })

  it('clarify with several questions: composes one answer set Hermes will accept', () => {
    const req = request('clarify', 'S6')
    const dispatch = mount(hermesClarifyView as never, req)
    // Recorded: q0 single choice ("red (Recommended)", "blue"), q1 multi
    // ("a (Recommended)", "b", "c"), q2 free text. The expected answers are
    // what Hermes' own client sent in that recording: bare labels.
    fireEvent.click(screen.getByRole('button', { name: 'blue' }))
    fireEvent.click(screen.getByRole('button', { name: 'a (Recommended)' }))
    fireEvent.click(screen.getByRole('button', { name: 'c' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nothing else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    const action = dispatch.mock.calls[0]![0] as ConditionCustomAction
    expect(action.name).toBe(HERMES_ANSWER)
    expect(validateAnswer(req, (action.payload as { result: unknown }).result)).toEqual({
      answers: { q0: 'blue', q1: 'a, c', q2: 'nothing else' },
    })
  })

  it('secret: masks the input, sends the typed value once and clears it', () => {
    const req = request('secret', 'S6')
    const dispatch = mount(hermesSecretView as never, req)
    // Named after the variable Hermes will store it in (recorded env_var).
    const input = screen.getByLabelText('Hermes needs HH_TEST_TOKEN', { selector: 'input' }) as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'typed-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const action = dispatch.mock.calls[0]![0] as ConditionCustomAction
    expect(validateAnswer(req, (action.payload as { result: unknown }).result)).toEqual({ value: 'typed-secret' })
    expect(input.value).toBe('')
  })

  it('clarify: a NEW question never inherits the previous one\'s choices', () => {
    // Mechanical mutation of S6: the same questions under a new request id,
    // as when Hermes asks again after a timeout.
    const req = request('clarify', 'S6')
    const record = conditionRecord(req, 0)
    const View = hermesClarifyView.Component as React.ComponentType<{ state: unknown; actions: ConditionAction[]; dispatch: (action: ConditionAction) => Promise<void>; interactionActive: boolean }>
    const dispatch = vi.fn(async (_action: ConditionAction) => undefined)
    const { rerender } = render(<View state={record.state} actions={record.actions} dispatch={dispatch} interactionActive />)
    fireEvent.click(screen.getByRole('button', { name: 'blue' }))
    expect(screen.getByRole('button', { name: 'blue' }).getAttribute('aria-pressed')).toBe('true')
    const next = conditionRecord({ ...req, id: `${req.id}-again` }, 0)
    rerender(<View state={next.state} actions={next.actions} dispatch={dispatch} interactionActive />)
    expect(screen.getByRole('button', { name: 'blue' }).getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// The manage_connections card (#1514), built from the RECORDED S26 request
// (v0.22.0: install n8n-official, which needs N8N_MCP_SERVER_URL) through the
// package's parser and the runtime's record builder, then checked against
// the runtime's validator like the request cards above.
// ---------------------------------------------------------------------------

function recordedConnection(): HermesConnectionOperation {
  const frame = inboundFrames(latestRecording('S26', { release: 'v0.22.0' })).find((entry) => (entry.params as { type?: string } | undefined)?.type === 'connection.request')!
  return connectionOperation((frame.params as { payload: unknown }).payload)!
}

function mountConnection(operation: HermesConnectionOperation, host?: Partial<RendererHost>) {
  const record = connectionConditionRecord(operation)
  const dispatch = vi.fn(async (_action: ConditionAction) => undefined)
  const View = (hermesConnectionView as never as { Component: React.ComponentType<{ state: unknown; actions: ConditionAction[]; dispatch: typeof dispatch; interactionActive: boolean }> }).Component
  const view = <View state={record.state} actions={record.actions} dispatch={dispatch} interactionActive />
  render(host ? <RendererHostProvider host={host as RendererHost}>{view}</RendererHostProvider> : view)
  return dispatch
}

describe('Hermes connection card (recorded S26)', () => {
  it('says what Hermes wants, asks for the value it needs, and sends an answer Hermes will accept', () => {
    const operation = recordedConnection()
    const dispatch = mountConnection(operation)
    expect(screen.getByText('Install the n8n-official MCP server')).toBeTruthy()
    expect(screen.getByText(/The reply is paused until you answer/)).toBeTruthy()
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    // The required value is empty: nothing to send yet, and the card says why.
    expect(connect.disabled).toBe(true)
    expect(screen.getByText('Fill in the required field to connect.')).toBeTruthy()
    // The visible prompt is the accessible name (review B F8).
    const field = screen.getByLabelText(/MCP Server URL \(n8n Settings/) as HTMLInputElement
    // Not a secret (recorded secret:false): shown as typed, and required.
    expect(field.type).toBe('text')
    expect(field.required).toBe(true)
    fireEvent.change(field, { target: { value: 'https://n8n.example/mcp-server/http' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const action = dispatch.mock.calls[0]![0] as ConditionCustomAction
    expect(validateConnectionAnswer(operation, (action.payload as { answer: unknown }).answer)).toEqual({
      targets: [{ name: 'n8n-official', status: 'approved', env: { N8N_MCP_SERVER_URL: 'https://n8n.example/mcp-server/http' } }],
    })
  })

  it('masks a secret value and never pre-fills it from Hermes\' default', () => {
    // Mechanical mutation of the recorded field into a secret with a default.
    const recorded = recordedConnection()
    const target = recorded.targets[0]!
    mountConnection({ ...recorded, targets: [{ ...target, requiredEnv: [{ ...target.requiredEnv[0]!, secret: true, default: 'leaked-default' }] }] })
    const field = screen.getByLabelText(/MCP Server URL/) as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.value).toBe('')
  })

  it('Skip and Continue without it are one click each', () => {
    const operation = recordedConnection()
    const dispatch = mountConnection(operation)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue without it' }))
    const [skip, carryOn] = dispatch.mock.calls.map((call) => (call[0] as ConditionCustomAction).payload as { answer: unknown })
    expect(validateConnectionAnswer(operation, skip!.answer)).toEqual({ targets: [{ name: 'n8n-official', status: 'skipped' }] })
    expect(validateConnectionAnswer(operation, carryOn!.answer)).toEqual({ targets: [], settledBy: 'continue' })
  })

  // Mechanical mutation of the recording into the hosted-connector shape
  // (Hermes' Target.snapshot: kind connector, action connect, connect_url).
  // Not recordable locally: the link is minted by Nous' tool gateway for a
  // real account.
  function hosted(url = 'https://connect.example/oauth/start?attempt=1'): HermesConnectionOperation {
    const recorded = recordedConnection()
    return { ...recorded, targets: [{ ...recorded.targets[0]!, name: 'github', kind: 'connector', action: 'connect', instructions: null, requiredEnv: [], connectUrl: url }] }
  }

  it('a hosted account opens its sign-in link in the system browser, and shows the link', async () => {
    const openExternalUrl = vi.fn(async () => 'opened' as const)
    mountConnection(hosted(), { openExternalUrl })
    expect(screen.getByText('Connect your github account')).toBeTruthy()
    // No approve button: Hermes ignores an approval on a hosted row; the browser leg connects it.
    expect(screen.queryByRole('button', { name: /^(Connect|Install|Try again)$/ })).toBeNull()
    expect(screen.getByText('https://connect.example/oauth/start?attempt=1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in' }))
    expect(openExternalUrl).toHaveBeenCalledWith({ url: 'https://connect.example/oauth/start?attempt=1', sessionId: '', modifierHeld: true })
  })

  it('says so when the browser could not be opened, so the link can be copied', async () => {
    mountConnection(hosted(), { openExternalUrl: vi.fn(async () => 'blocked' as const) })
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in' }))
    expect(await screen.findByText('The sign-in link could not be opened. Copy it below.')).toBeTruthy()
  })

  it('never offers a non-http(s) link (the phone hands it to window.open)', () => {
    const openExternalUrl = vi.fn(async () => 'opened' as const)
    mountConnection(hosted('javascript:alert(1)'), { openExternalUrl })
    expect(screen.queryByRole('button', { name: 'Open sign-in' })).toBeNull()
  })

  it('a catalog plugin shows its tier and scan, and one that failed the scan cannot be installed from here', () => {
    // Mechanical mutation into a catalog plugin row (connectors_operation.py fields).
    const recorded = recordedConnection()
    const plugin = (status: string): HermesConnectionOperation => ({
      ...recorded,
      targets: [{ ...recorded.targets[0]!, name: 'acme-tools', kind: 'plugin', action: 'install', instructions: null, requiredEnv: [], catalog: { display: null, description: 'Acme helpers', tier: 'community', repo: 'acme/tools', sha: 'abc1234def', scan: { status, summary: '2 critical findings' } } }],
    })
    mountConnection(plugin('failed'))
    expect(screen.getByText('community · acme/tools@abc1234')).toBeTruthy()
    expect(screen.getByText('Security scan failed: 2 critical findings')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    cleanup()
    mountConnection(plugin('passed'))
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })
})
