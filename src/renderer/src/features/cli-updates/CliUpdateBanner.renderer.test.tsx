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
// (retention prunes old logs; the OS shows no dialog). The row says so now,
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
    expect(openLog).toHaveBeenCalledWith('/logs/claude-update.log')
    const alert = screen.queryByRole('alert')
    if (shown) expect(alert).toHaveTextContent("Couldn't open the update log. It may have been cleaned up; the next failed update writes a new one.")
    else expect(alert).toBeNull()
  })
})
