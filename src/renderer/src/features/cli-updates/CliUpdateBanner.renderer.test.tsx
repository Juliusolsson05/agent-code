import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CliUpdateBanner, describeState } from './CliUpdateBanner'
import { useCliUpdateStore } from './store'
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
})
