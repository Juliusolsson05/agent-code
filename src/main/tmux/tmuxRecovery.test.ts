import { describe, expect, it, vi } from 'vitest'

import { reconcileWorkspace } from '@main/tmux/tmuxRecovery.js'

// Exercise the entry point used by startup, through the real canonical decoder
// and real reconciliation. A decoder-only test missed #898: restoration could
// understand windows perfectly while startup fed an empty set to cleanup.
// Only the tmux process boundary is fake; no test may address the user's server.
function registryWith(...names: string[]) {
  return {
    isAvailable: () => true,
    listManagedSessions: vi.fn(async () => names.map(name => ({ name, createdAt: 1 }))),
    killSession: vi.fn(async (_name: string) => {}),
  }
}

const terminal = (tmuxName: string) => ({ kind: 'terminal', tmuxName })
const windowWith = (windowId: string, sessions: unknown) => ({ windowId, workspace: { sessions } })
const readJson = (value: unknown) => async () => JSON.stringify(value)

describe('startup workspace inventory and tmux cleanup', () => {
  it('recovers every window, including parked terminals, and only cleans a proven orphan', async () => {
    const registry = registryWith('agentcode-left', 'agentcode-right', 'agentcode-parked', 'agentcode-orphan')
    const report = await reconcileWorkspace(registry, readJson({
      version: 2,
      windows: [
        windowWith('left', { left: terminal('agentcode-left'), dead: terminal('agentcode-dead') }),
        {
          windowId: 'right',
          // The resource projection must use all saved metadata. It must not
          // infer ownership from visible leaves and kill a buried/detached shell.
          workspace: {
            sessions: {
              right: terminal('agentcode-right'), parked: terminal('agentcode-parked'),
              directPty: { kind: 'terminal' }, legacyAgent: { cwd: '/repo' },
              claude: { kind: 'claude' }, codex: { kind: 'codex' }, opencode: { kind: 'opencode' },
            },
            tabs: [], buried: [{ sessionId: 'parked' }],
          },
        },
      ],
    }))
    expect(report.recoverable).toEqual([
      { sessionId: 'left', tmuxName: 'agentcode-left' },
      { sessionId: 'right', tmuxName: 'agentcode-right' },
      { sessionId: 'parked', tmuxName: 'agentcode-parked' },
    ])
    expect(report.lost).toEqual(['dead'])
    expect(report.inventory).toBe('complete')
    expect(report.inventoryIssues).toEqual({})
    expect(report.preserved).toEqual([])
    expect(registry.killSession.mock.calls).toEqual([['agentcode-orphan']])
  })

  it('retains the legacy single-window recovery contract', async () => {
    const registry = registryWith('agentcode-saved', 'agentcode-orphan')
    const report = await reconcileWorkspace(registry, readJson({
      workspace: { sessions: { saved: terminal('agentcode-saved') } },
    }))
    expect(report.recoverable).toEqual([{ sessionId: 'saved', tmuxName: 'agentcode-saved' }])
    expect(registry.killSession.mock.calls).toEqual([['agentcode-orphan']])
  })

  it.each([
    { version: 2, windows: [] },
    { version: 2, windows: [windowWith('empty', {})] },
    { workspace: { sessions: {} } },
  ])('permits cleanup with an explicitly complete empty inventory: %j', async value => {
    const registry = registryWith('agentcode-orphan')
    const report = await reconcileWorkspace(registry, readJson(value))
    expect(report.inventory).toBe('complete')
    expect(registry.killSession.mock.calls).toEqual([['agentcode-orphan']])
  })

  it.each([
    ['missing windows', { version: 2 }],
    ['invalid windows', { version: 2, windows: {} }],
    ['discarded window', { version: 2, windows: [windowWith('good', { saved: terminal('agentcode-saved') }), null] }],
    ['duplicate window id', { version: 2, windows: [windowWith('dup', { saved: terminal('agentcode-saved') }), windowWith('dup', { hidden: terminal('agentcode-hidden') })] }],
    ['missing workspace', { version: 2, windows: [{ windowId: 'broken' }] }],
    ['missing sessions', { version: 2, windows: [{ windowId: 'broken', workspace: {} }] }],
    ['invalid sessions', { version: 2, windows: [windowWith('broken', [])] }],
    ['invalid session row', { workspace: { sessions: { broken: null } } }],
    ['unknown session kind', { workspace: { sessions: { broken: { kind: 'future' } } } }],
    ['invalid terminal name', { workspace: { sessions: { broken: { kind: 'terminal', tmuxName: 42 } } } }],
    ['empty terminal name', { workspace: { sessions: { broken: terminal('') } } }],
    ['name on unexpected kind', { workspace: { sessions: { broken: { kind: 'claude', tmuxName: 'agentcode-hidden' } } } }],
  ])('preserves unmatched managed sessions after partial recovery: %s', async (_label, value) => {
    const registry = registryWith('agentcode-saved', 'agentcode-hidden')
    const report = await reconcileWorkspace(registry, readJson(value))
    expect(report.inventory).toBe('incomplete')
    expect(report.orphans).toEqual([])
    expect(report.preserved).toContain('agentcode-hidden')
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it.each([
    '', '   ', '{"version":2,"windows":[', 'null', '[]',
    JSON.stringify({ version: 99, windows: [] }),
  ])('preserves managed sessions when the file is unreadable: %j', async text => {
    const registry = registryWith('agentcode-preserve')
    const report = await reconcileWorkspace(registry, async () => text)
    expect(report).toMatchObject({
      inventory: 'unknown', inventoryIssues: { workspace_unreadable: 1 },
      orphans: [], preserved: ['agentcode-preserve'],
    })
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it.each(['ENOENT', 'EACCES', 'EIO'])('does not turn a %s read failure into empty inventory', async code => {
    const registry = registryWith('agentcode-preserve')
    const read = async () => { throw Object.assign(new Error('fixture read failure'), { code }) }
    const report = await reconcileWorkspace(registry, read)
    expect(report).toMatchObject({ inventory: 'unknown', orphans: [], preserved: ['agentcode-preserve'] })
    expect(report.inventoryIssues).toEqual({ [code === 'ENOENT' ? 'workspace_missing' : 'workspace_read_failed']: 1 })
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('recovers known references while reporting discarded windows and invalid rows as bounded counts', async () => {
    const registry = registryWith('agentcode-saved', 'agentcode-hidden')
    const report = await reconcileWorkspace(registry, readJson({
      version: 2, windows: [
        windowWith('good', { saved: terminal('agentcode-saved'), dead: terminal('agentcode-dead'), invalid: null }),
        null, { windowId: 'bad' }, windowWith('good', { hidden: terminal('agentcode-hidden') }),
      ],
    }))
    expect(report).toEqual({
      inventory: 'incomplete', inventoryIssues: { discarded_windows: 3, invalid_session_metadata: 1 },
      recoverable: [{ sessionId: 'saved', tmuxName: 'agentcode-saved' }],
      lost: ['dead'], orphans: [], preserved: ['agentcode-hidden'],
    })
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('does not weaken inventory for repaired geometry or minted window identity', async () => {
    const registry = registryWith('agentcode-saved', 'agentcode-orphan')
    const report = await reconcileWorkspace(registry, readJson({
      version: 2, windows: [{ bounds: { width: -1 }, workspace: { sessions: { saved: terminal('agentcode-saved') } } }],
    }))
    expect(report.inventory).toBe('complete')
    expect(report.recoverable).toEqual([{ sessionId: 'saved', tmuxName: 'agentcode-saved' }])
    expect(registry.killSession.mock.calls).toEqual([['agentcode-orphan']])
  })

  it('deduplicates an identical saved reference across distinct window slices', async () => {
    const registry = registryWith('agentcode-saved')
    const report = await reconcileWorkspace(registry, readJson({
      version: 2, windows: ['a', 'b'].map(id => windowWith(id, { saved: terminal('agentcode-saved') })),
    }))
    expect(report.inventory).toBe('complete')
    expect(report.recoverable).toEqual([{ sessionId: 'saved', tmuxName: 'agentcode-saved' }])
  })

  it.each([
    [windowWith('a', { same: terminal('agentcode-a') }), windowWith('b', { same: terminal('agentcode-b') })],
    [windowWith('a', { first: terminal('agentcode-a') }), windowWith('b', { second: terminal('agentcode-a') })],
  ])('withholds cleanup when saved session/name ownership conflicts across windows: %j', async (first, second) => {
    const registry = registryWith('agentcode-a', 'agentcode-b', 'agentcode-preserve')
    const report = await reconcileWorkspace(registry, readJson({ version: 2, windows: [first, second] }))
    expect(report.inventoryIssues).toEqual({ conflicting_terminal_reference: 1 })
    expect(report.preserved).toContain('agentcode-preserve')
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('reports known terminals as unavailable without calling an unavailable registry', async () => {
    const registry = { ...registryWith(), isAvailable: () => false }
    const report = await reconcileWorkspace(registry, readJson({ workspace: { sessions: { saved: terminal('agentcode-saved') } } }))
    expect(report).toMatchObject({ recoverable: [], lost: ['saved'], orphans: [], preserved: [] })
    expect(registry.listManagedSessions).not.toHaveBeenCalled()
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it.each(['list', 'kill'])('keeps a registry %s failure distinct from workspace uncertainty', async operation => {
    const registry = registryWith('agentcode-orphan')
    const error = new Error('fixture registry failure')
    if (operation === 'list') registry.listManagedSessions.mockRejectedValue(error)
    else registry.killSession.mockRejectedValue(error)
    await expect(reconcileWorkspace(registry, readJson({ version: 2, windows: [] }))).rejects.toBe(error)
  })
})
