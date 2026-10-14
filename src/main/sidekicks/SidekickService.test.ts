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
  const sent: Array<{ windowId: string; channel: string; payload: unknown }> = []
  const router: Router = {
    holder: sessionId => {
      const owner = owners.get(sessionId)
      return owner && alive.has(owner) ? owner : null
    },
    claim: (sessionId, windowId) => {
      const owner = owners.get(sessionId)
      if (owner && owner !== windowId && alive.has(owner)) return false
      owners.set(sessionId, windowId)
      return true
    },
    transfer: (sessionId, windowId) => {
      if (owners.has(sessionId)) owners.set(sessionId, windowId)
    },
    release: sessionId => { owners.delete(sessionId) },
    sendToWindow: (windowId, channel, payload) => {
      sent.push({ windowId, channel, payload })
      return true
    },
  }
  return { router, owners, alive, sent }
}

async function setup() {
  rmSync(join(stateDir, 'workspace.json'), { force: true })
  const store = await WorkspaceFileStore.open()
  const scripted = scriptedRouter()
  const kill = vi.fn(async () => true)
  const service = new SidekickService({
    store,
    router: scripted.router,
    kill,
    homeDir: '/home/test',
    releasedChannel: 'sidekick:released',
    now: () => 1000,
  })
  return { store, service, kill, ...scripted }
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
    const { service, owners, sent } = await setup()
    owners.set('s1', A)
    await service.register(A, { id: ID, sessionId: 's1', meta: META })

    const taken = service.take(B, ID)
    expect(taken.ok).toBe(true)
    expect(owners.get('s1')).toBe(B)
    expect(sent).toEqual([{ windowId: A, channel: 'sidekick:released', payload: { sidekickId: ID, sessionId: 's1' } }])

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

describe('window close carve-out', () => {
  it('releases sidekick leases instead of bequeathing them to the survivor', () => {
    expect(partitionClosedWindowSessions(['lane-1', 'sidekick-1', 'lane-2'], new Set(['sidekick-1']))).toEqual({
      bequeathed: ['lane-1', 'lane-2'],
      sidekicks: ['sidekick-1'],
    })
  })
})
