import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The real WorkspaceFileStore on a real temp directory: the service's whole
// safety story is "every check and mutation happens inside the store's commit
// queue against the committed document", so a hand-rolled store stand-in
// would test the stand-in. Only the window router is scripted, and it keeps
// the router's real rules: claim refuses a second LIVE window, transfer is the
// only handoff, a released session has no holder.
const stateDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path') as typeof import('node:path')
  return mk(j(tmp(), 'sidekick-service-'))
})
vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: stateDir,
  STATE_FILE: `${stateDir}/workspace.json`,
}))

const { WorkspaceFileStore } = await import('@main/storage/workspaceFileStore.js')
const { SidekickService, partitionClosedWindowSessions } = await import('@main/sidekicks/SidekickService.js')
type Router = import('@main/sidekicks/SidekickService.js').SidekickRouter

afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

const A = 'window-a'
const B = 'window-b'
const ID = '00000000-0000-4000-8000-000000000001'

function scriptedRouter() {
  const owners = new Map<string, string>()
  const alive = new Set([A, B])
  // Windows whose renderer reloaded and has not re-claimed: their leases are
  // at an old generation, so `holder` (current leases only) does not see them
  // while `claim` still refuses everyone else — the real router's rule.
  const stale = new Set<string>()
  const sent: Array<{ windowId: string; channel: string; payload: unknown }> = []
  // Every lease move and notice, in order: the take protocol's safety
  // property is an ORDER (lease first, notice second).
  const log: string[] = []
  const router: Router = {
    holder: sessionId => {
      const owner = owners.get(sessionId)
      return owner && alive.has(owner) && !stale.has(owner) ? owner : null
    },
    owner: sessionId => owners.get(sessionId) ?? null,
    claim: (sessionId, windowId) => {
      const owner = owners.get(sessionId)
      if (owner && owner !== windowId && alive.has(owner)) return false
      owners.set(sessionId, windowId)
      return true
    },
    transfer: (sessionId, windowId) => {
      log.push(`transfer ${sessionId} -> ${windowId}`)
      if (owners.has(sessionId)) owners.set(sessionId, windowId)
    },
    release: sessionId => { owners.delete(sessionId) },
    sendToWindow: (windowId, channel, payload) => {
      log.push(`send ${channel} -> ${windowId}`)
      sent.push({ windowId, channel, payload })
      return true
    },
  }
  return { router, owners, alive, stale, sent, log }
}

async function setup() {
  rmSync(join(stateDir, 'workspace.json'), { force: true })
  const store = await WorkspaceFileStore.open()
  const scripted = scriptedRouter()
  const kill = vi.fn(async (_options: unknown) => true)
  const onCommitted = vi.fn()
  const service = new SidekickService({
    store,
    router: scripted.router,
    kill,
    homeDir: '/home/test',
    releasedChannel: 'sidekick:released',
    onCommitted,
    now: () => 1000,
  })
  return { store, service, kill, onCommitted, ...scripted }
}

const META = { kind: 'claude', cwd: '/home/test', sidekickId: ID }

describe('SidekickService', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('registers only for the window holding the spawned session, once', async () => {
    const { service, owners, store } = await setup()
    expect(await service.register(A, { id: ID, sessionId: 's1', meta: META })).toEqual({ ok: false, reason: 'this window does not hold the session' })
    owners.set('s1', A)
    expect(await service.register(A, { id: ID, sessionId: 's1', meta: META })).toEqual({ ok: true })
    expect(await service.register(A, { id: ID, sessionId: 's1', meta: META })).toEqual({ ok: false, reason: 'already registered' })
    expect(store.sidekicks().records).toHaveLength(1)
    // Durable: it is in the file main wrote.
    const onDisk = JSON.parse(readFileSync(join(stateDir, 'workspace.json'), 'utf8'))
    expect(onDisk.sidekicks.records[0]).toMatchObject({ id: ID, sessionId: 's1' })
  })

  it('accepts saves only from the holder, and a replacement only when the old session is not held elsewhere', async () => {
    const { service, owners, store } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })

    expect(await service.save(B, { id: ID, sessionId: 's1', meta: { ...META, title: 'stolen' } })).toMatchObject({ ok: false })

    // Reload Agent in A: the replacement s2 is held by A, s1 retired (no holder).
    owners.set('s2', A)
    owners.delete('s1')
    expect(await service.save(A, { id: ID, sessionId: 's2', meta: { ...META, title: 'reloaded' }, draft: 'half a prompt' })).toEqual({ ok: true })
    expect(store.sidekicks().records[0]).toMatchObject({ sessionId: 's2', draft: 'half a prompt' })

    // A replacement whose OLD session another window still holds is refused.
    owners.set('s3', A)
    owners.set('s2', B)
    expect(await service.save(A, { id: ID, sessionId: 's3', meta: META })).toMatchObject({ ok: false })
    expect(store.sidekicks().records[0]!.sessionId).toBe('s2')
  })

  it('attach claims a sidekick nobody holds, and reports one held elsewhere', async () => {
    const { service, owners } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    expect(service.attach(B, ID)).toEqual({ ok: false, reason: 'owned-elsewhere' })
    owners.delete('s1') // A closed and released it
    const attached = service.attach(B, ID)
    expect(attached.ok).toBe(true)
    expect(owners.get('s1')).toBe(B)
    expect(service.view().sidekicks[0]!.liveWindowId).toBe(B)
  })

  it('take moves the lease BEFORE telling the old window, and the old window can no longer write', async () => {
    const { service, owners, sent, log } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })

    const taken = service.take(B, ID)
    expect(taken.ok).toBe(true)
    expect(owners.get('s1')).toBe(B)
    expect(sent).toEqual([{ windowId: A, channel: 'sidekick:released', payload: { sidekickId: ID, sessionId: 's1' } }])
    expect(log).toEqual(['transfer s1 -> window-b', 'send sidekick:released -> window-a'])

    // A's debounced save lands late: refused (I3).
    expect(await service.save(A, { id: ID, sessionId: 's1', meta: { ...META, title: 'late' } })).toMatchObject({ ok: false })
    expect(await service.save(B, { id: ID, sessionId: 's1', meta: { ...META, title: 'new holder' } })).toEqual({ ok: true })
  })

  it('remove kills with the record ownership tuple, releases, drops the record and tells the holder', async () => {
    const { service, owners, kill, sent, store } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: { ...META, kind: 'hermes', remoteConnectionId: 'conn-1' } })
    expect(await service.remove(B, ID)).toEqual({ ok: true })
    expect(kill).toHaveBeenCalledWith({ sessionId: 's1', kind: 'hermes', cwd: '/home/test', caller: 'sidekick.remove' })
    expect(owners.has('s1')).toBe(false)
    expect(store.sidekicks().records).toEqual([])
    expect(sent.at(-1)).toEqual({ windowId: A, channel: 'sidekick:released', payload: { sidekickId: ID, sessionId: 's1' } })
  })

  it('broadcasts a revisioned view on structural changes only', async () => {
    const { service, owners } = await setup()
    const views: number[] = []
    service.on('changed', view => views.push(view.revision))
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    await service.save(A, { id: ID, sessionId: 's1', meta: META })
    await service.save(A, { id: ID, sessionId: 's1', meta: META }) // nothing summary-visible moved
    await service.save(A, { id: ID, sessionId: 's1', meta: { ...META, title: 'renamed' } })
    expect(views).toEqual([1, 2, 3])
  })
})

describe('SidekickService replacement, removal and stale leases (review round 1)', () => {
  it('C2: take moves the spawned successor, not the retired session, before any save', async () => {
    const { service, owners, sent } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    // Provider switch in A: session:spawn claims s2 for A naming s1 as the
    // predecessor, and the renderer's debounced save has not run yet.
    owners.set('s2', A)
    service.noteSpawnClaimed('s1', 's2', { kind: 'opencode', providerRuntime: 'server', cwd: '/home/test' })
    owners.delete('s1')

    const taken = service.take(B, ID)
    expect(taken.ok).toBe(true)
    expect(owners.get('s2')).toBe(B)
    expect(taken.ok && taken.record).toMatchObject({ sessionId: 's2', meta: { kind: 'opencode', providerRuntime: 'server' } })
    expect(sent.at(-1)).toEqual({ windowId: A, channel: 'sidekick:released', payload: { sidekickId: ID, sessionId: 's2' } })
    expect(service.view().sidekicks[0]).toMatchObject({ sessionId: 's2', kind: 'opencode', liveWindowId: B })
  })

  it('C2: a failed successor spawn leaves the predecessor current', async () => {
    const { service, owners } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    service.noteSpawnClaimed('s1', 's2', { kind: 'claude', cwd: '/home/test' })
    service.noteSpawnFailed('s2')
    expect(service.view().sidekicks[0]!.sessionId).toBe('s1')
  })

  it('C2: the saved successor becomes durable and stops being tracked', async () => {
    const { service, owners, store } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    owners.set('s2', A)
    service.noteSpawnClaimed('s1', 's2', { kind: 'claude', cwd: '/home/test' })
    owners.delete('s1')
    expect(await service.save(A, { id: ID, sessionId: 's2', meta: { ...META, title: 'after' } })).toEqual({ ok: true })
    expect(store.sidekicks().records[0]!.sessionId).toBe('s2')
    // A later reload chains from the durable s2.
    service.noteSpawnClaimed('s2', 's3', { kind: 'claude', cwd: '/home/test' })
    expect(service.view().sidekicks[0]!.sessionId).toBe('s3')
  })

  it('C3: remove kills the unsaved successor with its own tuple, refuses saves while running, and kills a late successor', async () => {
    const { service, owners, kill, store } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: { ...META, kind: 'opencode', providerRuntime: 'tui' } })
    owners.set('s2', A)
    service.noteSpawnClaimed('s1', 's2', { kind: 'opencode', providerRuntime: 'server', cwd: '/home/test' })

    let finishKill!: () => void
    kill.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishKill = () => resolve(true) }))
    const removing = service.remove(B, ID)
    // While the first kill is in flight: a save is refused, and a replacement
    // spawned from s2 is killed at once rather than outliving the record.
    expect(await service.save(A, { id: ID, sessionId: 's2', meta: META })).toEqual({ ok: false, reason: 'being removed' })
    service.noteSpawnClaimed('s2', 's3', { kind: 'opencode', providerRuntime: 'server', cwd: '/home/test' })
    finishKill()
    expect(await removing).toEqual({ ok: true })

    const killed = kill.mock.calls.map(([options]) => options)
    expect(killed).toContainEqual({ sessionId: 's2', kind: 'opencode', cwd: '/home/test', providerRuntime: 'server', caller: 'sidekick.remove' })
    expect(killed).toContainEqual({ sessionId: 's1', kind: 'opencode', cwd: '/home/test', providerRuntime: 'tui', caller: 'sidekick.remove' })
    expect(killed).toContainEqual({ sessionId: 's3', kind: 'opencode', cwd: '/home/test', providerRuntime: 'server', caller: 'sidekick.remove' })
    expect(store.sidekicks().records).toEqual([])
    expect(owners.has('s1') || owners.has('s2')).toBe(false)
  })

  it('C5: attach transfers a STALE lease (the holder reloaded) and tells that window', async () => {
    const { service, owners, stale, sent } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    stale.add(A)
    expect(service.attach(B, ID).ok).toBe(true)
    expect(owners.get('s1')).toBe(B)
    expect(sent.at(-1)).toEqual({ windowId: A, channel: 'sidekick:released', payload: { sidekickId: ID, sessionId: 's1' } })
  })

  it('C5: the reloaded holder itself re-attaches its own stale lease', async () => {
    const { service, owners, stale, sent } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    stale.add(A)
    // The scripted claim refreshes A's own lease (the real router re-claims
    // for the same window at the new generation).
    expect(service.attach(A, ID).ok).toBe(true)
    stale.delete(A)
    expect(owners.get('s1')).toBe(A)
    expect(sent).toEqual([])
  })

  it('C4: every committed index change asks for durable-ownership acknowledgement', async () => {
    const { service, owners, onCommitted } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })
    expect(onCommitted).toHaveBeenCalledTimes(1)
    await service.save(A, { id: ID, sessionId: 's1', meta: META })
    expect(onCommitted).toHaveBeenCalledTimes(2)
    await service.save(B, { id: ID, sessionId: 's1', meta: META }) // refused: no commit
    expect(onCommitted).toHaveBeenCalledTimes(2)
    await service.remove(A, ID)
    expect(onCommitted).toHaveBeenCalledTimes(3)
  })
})

describe('window close carve-out', () => {
  it('releases sidekick leases instead of bequeathing them to the survivor', () => {
    expect(partitionClosedWindowSessions(['lane-1', 'sidekick-1', 'lane-2'], new Set(['sidekick-1']))).toEqual({
      bequeathed: ['lane-1', 'lane-2'],
      sidekicks: ['sidekick-1'],
    })
  })
})
