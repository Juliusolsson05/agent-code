import { describe, expect, it, vi } from 'vitest'

const installedVersion = vi.hoisted(() => ({ current: '2.1.281' }))

// The manual "Update now" path, with the process-touching reads replaced:
// a Claude Code install one version behind the cached latest.
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: (cli: string) => `/usr/local/bin/${cli}` }))
vi.mock('@main/setup/cliVersion.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@main/setup/cliVersion.js')>()),
  readInstalledVersion: async () => ({ ok: true, version: installedVersion.current }),
}))
vi.mock('@main/setup/setupState.js', () => ({
  loadSetupState: async () => ({ cliUpdateCache: { claude: { latestVersion: '2.1.282' }, codex: { latestVersion: '2.1.282' } } }),
  updateCliUpdateCache: async () => undefined,
}))
vi.mock('@main/setup/cliInstallMethod.js', () => ({ detectCliInstallMethod: async () => 'npm' }))

import { CliUpdateOrchestrator } from './cliUpdateOrchestrator.js'

describe('manual Update now while an agent is running (#1243)', () => {
  it.each(['claude', 'codex'] as const)('records a %s deferral the banner can explain, instead of silently vanishing', async cli => {
    const orchestrator = new CliUpdateOrchestrator({ list: () => ['running-agent'], getSessionKind: () => cli } as never, { acquireUpdateLease: () => null })
    const snapshot = await orchestrator.updateOnce(cli)
    expect(snapshot[cli]).toMatchObject({
      kind: 'deferred', from: '2.1.281', wantedLatest: '2.1.282', reason: 'session-active', requestedByUser: true,
    })
  })

  it('answers a click on an already-current CLI with up-to-date instead of leaving the stale offer (#1265 review A)', async () => {
    installedVersion.current = '2.1.282'
    try {
      const orchestrator = new CliUpdateOrchestrator({ list: () => [], getSessionKind: () => 'claude' } as never, { acquireUpdateLease: () => () => undefined })
      const snapshot = await orchestrator.updateOnce('claude')
      expect(snapshot.claude).toMatchObject({ kind: 'up-to-date', installed: '2.1.282', latest: '2.1.282' })
    } finally {
      installedVersion.current = '2.1.281'
    }
  })
})
