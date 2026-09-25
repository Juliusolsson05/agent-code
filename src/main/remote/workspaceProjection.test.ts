import { describe, expect, it, vi } from 'vitest'

import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import { RemoteWorkspaceProjection } from './workspaceProjection'
import { fakeWorkspaceFileStore } from './workspaceProjection.testSupport'

// The projection is the single join behind every identity fact the phone
// shows (title, agent name, tab, pin, TLDR identity). These unit tests pin
// the join against fixture documents; the durability/notification contract
// with the real WorkspaceFileStore, and the frames downstream, are covered
// by the RemoteServer integration suite.

type FakeStoreOptions = {
  /** Controlled saves: each call pushes a new committed document. */
  saves?: Array<readonly PersistedWindow[]>
}

type FakeStore = ReturnType<typeof fakeStore>

/** Thin adapter onto the shared store fake so both projection test files use
 *  ONE definition of "the store notifies only after bytes reach disk". */
function fakeStore({ saves = [] }: FakeStoreOptions = {}) {
  return fakeWorkspaceFileStore(saves)
}

function asStore(store: FakeStore): WorkspaceFileStore {
  return store.asStore()
}

// Name reader seam: pass-through — call sites hand the projection a
// readAssignments function directly, exactly as index.ts hands it
// readAgentNameAssignments(AGENT_NAMES_FILE).

function doc(sessions: Record<string, unknown>, extra: Record<string, unknown> = {}): PersistedWindow {
  return {
    windowId: 'w1',
    workspace: {
      sessions,
      tabs: [
        {
          id: 'tab1',
          title: 'agent-code',
          root: {
            type: 'split',
            a: { type: 'leaf', sessionId: 's1' },
            b: { type: 'leaf', sessionId: 's2' },
          },
        },
      ],
      pinnedSessionIds: ['s1'],
      ...extra,
    },
  } as unknown as PersistedWindow
}

const SESSIONS = {
  's1': {
    kind: 'claude',
    cwd: '/dev/agent-code',
    title: 'Remote rebuild',
    agentNameId: 'name-1',
    tldrIdentity: 'tldr-s1',
  },
  's2': { kind: 'codex', cwd: '/dev/other' },
}

describe('RemoteWorkspaceProjection', () => {
  it('joins title, tab, pin and TLDR identity from the persisted document', () => {
    const projection = new RemoteWorkspaceProjection(
      asStore(fakeStore({ saves: [[doc(SESSIONS)]] })),
      () => Promise.resolve({}),
    )
    try {
      const s1 = projection.snapshot().get('s1')
      expect(s1).toMatchObject({
        sessionId: 's1',
        title: 'Remote rebuild',
        tabTitle: 'agent-code',
        pinned: true,
        tldrIdentity: 'tldr-s1',
        cwd: '/dev/agent-code',
        kind: 'claude',
      })
      // Unpinned, untitled, tab-less session degrades to nulls — never throws.
      const s2 = projection.snapshot().get('s2')
      expect(s2).toMatchObject({ title: null, pinned: false, tldrIdentity: null, tabTitle: 'agent-code' })
    } finally {
      projection.dispose()
    }
  })

  it('publishes unnamed first and re-notifies when the spoken name lands', async () => {
    const onChange = vi.fn()
    const projection = new RemoteWorkspaceProjection(
      asStore(fakeStore({ saves: [[doc(SESSIONS)]] })),
      async () => ({ 'name-1': 'Apollo' }),
    )
    try {
      projection.onChange(onChange)
      // First tick: identity present, name still pending.
      expect(projection.snapshot().get('s1')?.agentName).toBeNull()
      await vi.waitFor(() => {
        expect(projection.snapshot().get('s1')?.agentName).toBe('Apollo')
      })
      // The name landing is itself a change event (consumers resend their list).
      expect(onChange).toHaveBeenCalled()
    } finally {
      projection.dispose()
    }
  })

  it('re-projects from the CURRENT document when a late name lands', async () => {
    const store = fakeStore({
      saves: [
        [doc(SESSIONS)],
        // While the name resolution is in flight, the renderer renames the
        // session — the late resolution must not resurrect the old title.
        [doc({ ...SESSIONS, s1: { ...SESSIONS['s1'], title: 'Renamed meanwhile' } })],
      ],
    })
    let release!: (value: Record<string, string>) => void
    const projection = new RemoteWorkspaceProjection(asStore(store), () => new Promise<Record<string, string>>(resolve => (release = resolve)))
    try {
      store.commitNext() // rename lands while resolution is pending
      release({ 'name-1': 'Apollo' })
      await vi.waitFor(() => {
        expect(projection.snapshot().get('s1')?.agentName).toBe('Apollo')
      })
      expect(projection.snapshot().get('s1')?.title).toBe('Renamed meanwhile')
    } finally {
      projection.dispose()
    }
  })

  it('stays silent on saves that change nothing', () => {
    const onChange = vi.fn()
    const store = fakeStore({ saves: [[doc(SESSIONS)], [doc(SESSIONS)]] })
    const projection = new RemoteWorkspaceProjection(asStore(store), () => Promise.resolve({}))
    try {
      projection.onChange(onChange)
      onChange.mockClear()
      store.commitNext()
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      projection.dispose()
    }
  })
})
