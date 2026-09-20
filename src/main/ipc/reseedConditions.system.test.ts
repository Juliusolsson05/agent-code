import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #895. A permission or question pending when a window closes disappeared from
// the adopting window: every path that takes over a session — adoption, a cold
// restore, waking a parked agent — rebuilds its runtime from `emptyRuntime()`,
// and providers publish conditions only when they CHANGE. The OpenCode
// Terminal package and claude-code-headless both deduplicate, so an agent
// already sitting on a prompt emits nothing to a renderer that just started
// watching it. Dispatch lost ACTION/QUESTION and orchestration summaries
// stopped naming the blocker, while the raw TUI still showed it.
//
// Main already cached the snapshot and no renderer path read it.
//
// WHY the fix re-emits on the ordinary EVENT channel rather than answering an
// invoke (#1083 review): conditions carry no revision, so a reply raced
// against live events cannot be ordered against them. The first attempt put
// the snapshot on `SessionBackendSnapshot` and compared `ts` — and 1 ms
// `Date.now()` ties are genuinely unordered, so a prompt answered in the same
// millisecond it appeared could be restored onto the user's screen. On this
// channel there is nothing to order: main updates its cache before forwarding,
// so the cache is never older than what the renderer has folded.

const { sent, lease, windowId } = vi.hoisted(() => ({
  sent: [] as Array<{ sessionId: string; channel: string; payload: unknown }>,
  lease: { current: null as { windowId: string; revision: number } | null },
  windowId: { current: 'window-one' as string | null },
}))

vi.mock('@main/window/windowRegistry.js', () => ({
  captureSessionWindowLease: () => lease.current,
  isSessionWindowLeaseCurrent: () => true,
  isSessionWindowLeaseAvailable: () => true,
  sendToSessionWindow: (sessionId: string, channel: string, payload: unknown) => {
    sent.push({ sessionId, channel, payload })
    return 'delivered'
  },
  windowIdFor: () => windowId.current,
  releaseSession: vi.fn(),
  registerSessionOwnership: vi.fn(),
}))

const handlers = new Map<string, (evt: unknown, ...args: never[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (evt: unknown, ...args: never[]) => unknown) => { handlers.set(channel, handler) } },
  app: { getPath: () => '/tmp' },
}))

const { registerSessionIpc } = await import('@main/ipc/session.js')

const blocked = {
  provider: 'claude' as const,
  ts: 4_000,
  conditions: {
    'claude.permission-prompt': { kind: 'claude.permission-prompt', state: { visible: true, title: 'Allow Bash?' }, actions: [] },
  },
}

function manager(snapshots: Record<string, unknown>) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
  emitter.getConditionsSnapshot = (sessionId: string) => snapshots[sessionId] ?? null
  return emitter
}

const reseed = (ids: unknown) => handlers.get('session:reseed-conditions')!({ sender: {} }, ids as never) as number

beforeEach(() => {
  sent.length = 0
  lease.current = { windowId: 'window-one', revision: 1 }
  windowId.current = 'window-one'
  handlers.clear()
})

describe('session:reseed-conditions (#895)', () => {
  it('re-emits a cached snapshot on the same channel a live change uses', () => {
    registerSessionIpc(manager({ blocked: blocked }) as never, { flushSession: vi.fn() } as never)
    expect(reseed(['blocked'])).toBe(1)
    // The ordinary channel, so the renderer's one fold applies the projection,
    // the unread mark and the debug log — exactly as for a live change. A
    // second producer is what the review of the first attempt refused.
    expect(sent).toEqual([{ sessionId: 'blocked', channel: 'session:conditions', payload: { sessionId: 'blocked', snapshot: blocked } }])
  })

  it('sends nothing for a session that has never had a condition', () => {
    // No cached snapshot means no condition has ever been live. An empty
    // snapshot would be a CLAIM that everything is clear, which is a different
    // statement and would clobber whatever the renderer already holds.
    registerSessionIpc(manager({}) as never, { flushSession: vi.fn() } as never)
    expect(reseed(['quiet'])).toBe(0)
    expect(sent).toEqual([])
  })

  it('refuses a session this window does not own', () => {
    registerSessionIpc(manager({ blocked: blocked }) as never, { flushSession: vi.fn() } as never)
    lease.current = { windowId: 'another-window', revision: 1 }
    expect(reseed(['blocked'])).toBe(0)
    expect(sent).toEqual([])
  })

  it('refuses an unowned session and a malformed request without throwing', () => {
    registerSessionIpc(manager({ blocked: blocked }) as never, { flushSession: vi.fn() } as never)
    lease.current = null
    expect(reseed(['blocked'])).toBe(0)
    lease.current = { windowId: 'window-one', revision: 1 }
    expect(reseed('not-an-array')).toBe(0)
    expect(reseed([null, '', 7])).toBe(0)
    expect(sent).toEqual([])
  })
})
