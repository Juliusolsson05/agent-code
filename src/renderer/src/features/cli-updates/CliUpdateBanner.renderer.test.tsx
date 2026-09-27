import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CliUpdateBanner, describeState } from './CliUpdateBanner'
import { dismissKey, useCliUpdateStore } from './store'
import { DEFAULT_CLI_UPDATE_SNAPSHOT } from '@shared/types/cliUpdate'

const deferred = (cli: 'claude' | 'codex') => ({ kind: 'deferred' as const, cli, from: '2.1.281', wantedLatest: '2.1.282', reason: 'session-active' as const, checkedAt: 1 })

describe('CliUpdateBanner deferred state (#1243)', () => {
  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
  ] as const)('shows a deferral of the user\'s own %s click, with a working retry', (cli, label) => {
    const updateNow = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', { configurable: true, value: { ...(window as { api?: object }).api, cliUpdatesUpdateNow: updateNow } })
    useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, [cli]: { ...deferred(cli), requestedByUser: true } } })
    render(<CliUpdateBanner />)
    expect(screen.getByText(`${label} 2.1.282 is ready, but ${label} agents are running. Close them, then choose Update now (now 2.1.281).`)).toBeInTheDocument()
    // Closing the agents does not start the update by itself; the row's
    // action is how the user retries (#1265 review B).
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    expect(updateNow).toHaveBeenCalledWith(cli)
  })

  it('keeps an automatic deferral silent', () => {
    expect(describeState('claude', deferred('claude'))).toBeNull()
  })

  it('re-shows the explanation for a NEW click after the previous one was dismissed (#1265 review A)', () => {
    const first = { ...deferred('claude'), requestedByUser: true as const, checkedAt: 1 }
    const second = { ...first, checkedAt: 2 }
    expect(dismissKey('claude', first)).not.toBe(dismissKey('claude', second))
    // The same click re-emitted keeps its dismissal.
    expect(dismissKey('claude', first)).toBe(dismissKey('claude', { ...first }))
  })
})

// #1250 row 10: View Log did nothing visible when the log could not be opened
// (a log removed by hand or another tool; the OS shows no dialog, and nothing
// prunes this directory automatically). The row says so now,
// in fixed words, and only when main answers that it did not open.
describe('CliUpdateBanner View Log', () => {
  const failed = { kind: 'failed' as const, cli: 'claude' as const, from: '2.1.281', wantedLatest: '2.1.282', installMethod: 'npm' as const, reason: 'command-failed' as const, logPath: '/logs/claude-update.log', finishedAt: 1 }

  it.each([
    [false, true],
    [true, false],
  ])('when opening the log answers %s, the row shows the failure: %s', async (opened, shown) => {
    const openLog = vi.fn(async () => opened)
    Object.defineProperty(window, 'api', { configurable: true, value: { ...(window as { api?: object }).api, cliUpdatesOpenLog: openLog } })
    useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, claude: failed }, dismissed: new Set() })
    render(<CliUpdateBanner />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View Log' })) })
    // The CLI, never a path: main picks the log it wrote (#1423 review a).
    expect(openLog).toHaveBeenCalledWith('claude')
    const alert = screen.queryByRole('alert')
    if (shown) expect(alert).toHaveTextContent("Couldn't open the update log. It may have been cleaned up; the next failed update writes a new one.")
    else expect(alert).toBeNull()
  })

  // #1423 review a and c: a later click clears the alert, and an older,
  // slower answer must not overwrite a newer one. The alert is shown FIRST,
  // so this cannot pass on a banner that never shows one.
  it('clears on a later click, and keeps the latest click\'s answer when an older one arrives last', async () => {
    const answers: Array<(opened: boolean) => void> = []
    const openLog = vi.fn(() => new Promise<boolean>(resolve => { answers.push(resolve) }))
    Object.defineProperty(window, 'api', { configurable: true, value: { ...(window as { api?: object }).api, cliUpdatesOpenLog: openLog } })
    useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, claude: failed }, dismissed: new Set() })
    render(<CliUpdateBanner />)
    const button = screen.getByRole('button', { name: 'View Log' })
    await act(async () => { fireEvent.click(button) })
    await act(async () => { answers[0]!(false) })
    expect(screen.getByRole('alert')).toBeTruthy()
    // A later click clears it at once, before its answer arrives.
    await act(async () => { fireEvent.click(button) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { fireEvent.click(button) })
    await act(async () => { answers[2]!(true) })
    await act(async () => { answers[1]!(false) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // #1423 review c: a REJECTED request (the IPC itself failed) is a failed
  // open too, said the same way, never an unhandled rejection.
  it('says a rejected request the same way', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { ...(window as { api?: object }).api, cliUpdatesOpenLog: vi.fn(async () => { throw new Error('IPC unavailable') }) } })
    useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, claude: failed }, dismissed: new Set() })
    render(<CliUpdateBanner />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View Log' })) })
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't open the update log.")
    expect(document.body.textContent).not.toContain('IPC unavailable')
  })

  // #1423 review a: a new failed run writes a new log; the old "couldn't
  // open" says nothing about it.
  it('clears the alert when a new failure brings a new log', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { ...(window as { api?: object }).api, cliUpdatesOpenLog: vi.fn(async () => false) } })
    useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, claude: failed }, dismissed: new Set() })
    render(<CliUpdateBanner />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'View Log' })) })
    expect(screen.getByRole('alert')).toBeTruthy()
    act(() => { useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, claude: { ...failed, logPath: '/logs/claude-update-2.log', finishedAt: 2 } } }) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// #1425: an update that could not start used to leave an undismissable
// "Updating…" row forever (main), and a rejected Update now request was dropped
// by `void` (renderer). The first is now its own failed state; the second is
// said on the row that was clicked.
describe('CliUpdateBanner: an update that could not start', () => {
  const couldNotStart = { kind: 'failed' as const, cli: 'claude' as const, from: '2.1.281', wantedLatest: '2.1.282', installMethod: 'npm' as const, reason: 'could-not-start' as const, logPath: null, finishedAt: 5 }

  it('says so in fixed words, offers a retry instead of a log, and can be dismissed', async () => {
    const updateNow = vi.fn(async () => DEFAULT_CLI_UPDATE_SNAPSHOT)
    Object.defineProperty(window, 'api', { configurable: true, value: { ...(window as { api?: object }).api, cliUpdatesUpdateNow: updateNow } })
    useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, claude: couldNotStart }, dismissed: new Set() })
    render(<CliUpdateBanner />)
    expect(screen.getByText("Couldn't start the Claude Code update: Agent Code couldn't create its update log. Still at 2.1.281.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View Log' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update now' })) })
    expect(updateNow).toHaveBeenCalledWith('claude')
    expect(describeState('claude', couldNotStart)?.undismissable).not.toBe(true)
  })

  it('keys each attempt separately, so a dismissed failure does not hide the next click\'s', () => {
    expect(dismissKey('claude', couldNotStart)).not.toBe(dismissKey('claude', { ...couldNotStart, finishedAt: 6 }))
  })

  it.each([
    ['the offer', { kind: 'notify' as const, cli: 'claude' as const, installed: '2.1.281', latest: '2.1.282', severity: 'patch' as const, installMethod: 'npm' as const, checkedAt: 1 }, 'Update Now'],
    ['a deferral of the user\'s click', { ...deferred('claude'), requestedByUser: true as const }, 'Update now'],
  ] as const)('says a rejected Update now request on %s instead of dropping it', async (_name, state, label) => {
    const updateNow = vi.fn(async () => { throw new Error('Error invoking remote method \'cli-updates:update-now\': EACCES /state') })
    Object.defineProperty(window, 'api', { configurable: true, value: { ...(window as { api?: object }).api, cliUpdatesUpdateNow: updateNow } })
    useCliUpdateStore.setState({ snapshot: { ...DEFAULT_CLI_UPDATE_SNAPSHOT, claude: state }, dismissed: new Set() })
    render(<CliUpdateBanner />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
    // Fixed words; the IPC/OS text never reaches the screen (q22).
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start the update. Try again.")
    expect(screen.getByRole('alert').textContent).not.toContain('EACCES')
  })
})
