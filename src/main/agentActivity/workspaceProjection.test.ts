import { describe, expect, it } from 'vitest'

import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import { projectWorkspace } from './workspaceProjection.js'

// Main reads the renderer's workspace document to answer "which project does
// this session belong to" for Agent Analytics (#964). The unified layout (#992)
// changed how the document SAYS that: a v3 file has no tile tree and no
// detached/buried buckets at all — membership is `sessions[id].projectId`, and
// projects are listed under `projects`, not `tabs`.
//
// WHY this file exists separately from AgentActivityRecorder.test.ts, which
// keeps its v2 fixture on purpose: the recorder suite proves attribution still
// works for a window that has not saved since the upgrade. Nothing proved it
// works for a window that HAS — and the failure is silent. A projection that
// only understood v2 would not throw on a v3 document; it would find no `tabs`,
// attribute every session to `tabId: null`, and Agent Analytics would quietly
// file a whole fleet's working time under "Unknown project" from the first
// autosave onward.

function windowOf(workspace: unknown): PersistedWindow {
  return { windowId: 'window-1', workspace } as PersistedWindow
}

describe('projectWorkspace — v3 documents (#992)', () => {
  it('attributes every session through its own row, parked or on screen', () => {
    const projection = projectWorkspace([windowOf({
      projects: [{ id: 'p-app', title: 'app' }, { id: 'p-svc', title: 'service' }],
      activeProjectId: 'p-app',
      // The lane shows one of three sessions. Placement must not depend on it:
      // a parked agent still belongs to its project and still accrues time.
      stage: { lanes: [{ selectedSessionId: 'shown' }], rows: [{ length: 1 }], focusedLane: 0 },
      sessions: {
        shown: { cwd: '/x/app', kind: 'codex', projectId: 'p-app', joinedAt: 0, title: 'Reviewer' },
        parked: { cwd: '/x/app', kind: 'claude', projectId: 'p-app', joinedAt: 1, agentNameId: 'name-7' },
        worker: { cwd: '/x/svc', kind: 'claude', projectId: 'p-svc', joinedAt: 0, orchestrationParentId: 'shown' },
      },
      pinnedSessionIds: [],
    })])

    // Exact match on purpose: this pins the whole projected shape. It
    // includes `tldrIdentity` and `pinned`, which main's remote read model
    // (30424f13) added while #992 was in flight. They merged cleanly into the
    // projection, but this exact expectation predated them.
    expect(projection.sessions.get('shown')).toEqual({
      sessionId: 'shown', kind: 'codex', cwd: '/x/app', title: 'Reviewer',
      agentNameId: null, tldrIdentity: null, pinned: false, orchestration: false, tabId: 'p-app', tabTitle: 'app',
    })
    expect(projection.sessions.get('parked')).toMatchObject({ tabId: 'p-app', tabTitle: 'app', agentNameId: 'name-7' })
    expect(projection.sessions.get('worker')).toMatchObject({ tabId: 'p-svc', tabTitle: 'service', orchestration: true })
    expect([...projection.openTabTitles].sort()).toEqual(['app', 'service'])
  })

  it('leaves a row whose project does not exist unattributed instead of guessing', () => {
    // Mirrors the renderer's ownership rule: a ghost never falls back to the
    // active project. Filing a stranger's agent under whichever project
    // happened to be open would put its hours on the wrong line of a report
    // people read to decide where time went.
    const projection = projectWorkspace([windowOf({
      projects: [{ id: 'p-app', title: 'app' }],
      activeProjectId: 'p-app',
      sessions: {
        ghost: { cwd: '/gone', kind: 'claude', projectId: 'p-deleted', joinedAt: 0 },
        unfiled: { cwd: '/x', kind: 'claude' },
      },
    })])

    expect(projection.sessions.get('ghost')).toMatchObject({ tabId: null, tabTitle: null })
    expect(projection.sessions.get('unfiled')).toMatchObject({ tabId: null, tabTitle: null })
  })
})

describe('projectWorkspace — hybrid documents', () => {
  it('lets the row win over a v2 structure that disagrees', () => {
    // The intermediate builds of #992 wrote BOTH shapes. Where they disagree
    // the row is newer by construction (it is written by every v3 action; the
    // v2 structures were only carried along), which is the same precedence
    // migrateWorkspaceToStage applies. Main re-states the rule rather than
    // importing it, so this is the pin that keeps the two from drifting.
    const projection = projectWorkspace([windowOf({
      projects: [{ id: 'p-new', title: 'new home' }, { id: 'tab-old', title: 'old home' }],
      tabs: [{ id: 'tab-old', title: 'old home', focusedSessionId: 'moved', root: { type: 'leaf', sessionId: 'moved' } }],
      sessions: { moved: { cwd: '/x', kind: 'claude', projectId: 'p-new', joinedAt: 3 } },
    })])

    expect(projection.sessions.get('moved')).toMatchObject({ tabId: 'p-new', tabTitle: 'new home' })
  })

  it('falls back to the v2 structure when the row names a project that is gone', () => {
    const projection = projectWorkspace([windowOf({
      tabs: [{ id: 'tab-old', title: 'old home', focusedSessionId: 'kept', root: { type: 'leaf', sessionId: 'kept' } }],
      sessions: { kept: { cwd: '/x', kind: 'claude', projectId: 'p-deleted', joinedAt: 3 } },
    })])

    expect(projection.sessions.get('kept')).toMatchObject({ tabId: 'tab-old', tabTitle: 'old home' })
  })
})

describe('projectWorkspace — v2 documents still on disk', () => {
  it('reads tile leaves, detached rows and buried panes, in that precedence', () => {
    const projection = projectWorkspace([windowOf({
      tabs: [{
        id: 'tab-a', title: 'app', focusedSessionId: 'leaf',
        root: { type: 'split', direction: 'vertical', ratio: 0.5, a: { type: 'leaf', sessionId: 'leaf' }, b: { type: 'leaf', sessionId: 'both' } },
      }, { id: 'tab-b', title: 'service', focusedSessionId: 'x', root: { type: 'leaf', sessionId: 'x' } }],
      detachedSessions: {
        row: { sessionId: 'row', projectTabId: 'tab-b' },
        // Also a leaf of tab-a: the leaf wins, as it does in the renderer.
        both: { sessionId: 'both', projectTabId: 'tab-b' },
      },
      buried: [{ sessionId: 'hidden', sourceTabId: 'tab-a' }],
      sessions: {
        leaf: { cwd: '/a', kind: 'claude' }, both: { cwd: '/a', kind: 'claude' }, x: { cwd: '/b', kind: 'claude' },
        row: { cwd: '/b', kind: 'codex' }, hidden: { cwd: '/a', kind: 'claude' },
      },
    })])

    expect(Object.fromEntries([...projection.sessions].map(([id, placement]) => [id, placement.tabId]))).toEqual({
      leaf: 'tab-a', both: 'tab-a', x: 'tab-b', row: 'tab-b', hidden: 'tab-a',
    })
  })

  it('degrades a malformed document to nothing rather than throwing', () => {
    // Main treats the document as opaque: a future or corrupt shape must cost
    // attribution, never the analytics recorder (which runs in the main
    // process, where a throw here is an app-level crash path).
    expect(() => projectWorkspace([
      windowOf(null), windowOf('nope'), windowOf({ sessions: [] }),
      windowOf({ projects: 'x', tabs: 7, detachedSessions: [], buried: {}, sessions: { a: null, b: 3 } }),
    ])).not.toThrow()
    const cyclic: Record<string, unknown> = { type: 'split' }
    cyclic.a = cyclic
    cyclic.b = cyclic
    expect(() => projectWorkspace([windowOf({
      tabs: [{ id: 't', title: 'loop', root: cyclic }], sessions: { a: { cwd: '/x' } },
    })])).not.toThrow()
  })
})
