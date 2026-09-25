import { describe, expect, it, vi } from 'vitest'

// The manual "Update now" path, with the process-touching reads replaced:
// a Claude Code install one version behind the cached latest.
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: () => '/usr/local/bin/claude' }))
vi.mock('@main/setup/cliVersion.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@main/setup/cliVersion.js')>()),
  readInstalledVersion: async () => ({ ok: true, version: '2.1.281' }),
}))
vi.mock('@main/setup/setupState.js', () => ({
  loadSetupState: async () => ({ cliUpdateCache: { claude: { latestVersion: '2.1.282' } } }),
  updateCliUpdateCache: async () => undefined,
}))
vi.mock('@main/setup/cliInstallMethod.js', () => ({ detectCliInstallMethod: async () => 'npm' }))

import { CliUpdateOrchestrator } from './cliUpdateOrchestrator.js'

describe('manual Update now while an agent is running (#1243)', () => {
  it('records a deferral the banner can explain, instead of silently vanishing', async () => {
    const orchestrator = new CliUpdateOrchestrator({ list: () => ['running-agent'], getSessionKind: () => 'claude' } as never, { acquireUpdateLease: () => null })
    const snapshot = await orchestrator.updateOnce('claude')
    expect(snapshot.claude).toMatchObject({
      kind: 'deferred', from: '2.1.281', wantedLatest: '2.1.282', reason: 'session-active', requestedByUser: true,
    })
  })
})
