import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import { RemoteWorkspaceProjection } from './workspaceProjection'
import { fakeWorkspaceFileStore } from './workspaceProjection.testSupport'

// ---------------------------------------------------------------------------
// #1031 item 4.
//
// WHAT WAS ACTUALLY MISSING — and what was not. `agentActivity/
// workspaceProjection.test.ts` already covers the SHARED decoder on v3
// documents (`projectWorkspace — v3 documents (#992)`), built by hand; delete
// the v3 `projects` parsing and two of its tests fail. So a decoder regression
// was never silent, and an earlier version of this comment claiming otherwise
// was wrong.
//
// The real gap is narrower and specific to the phone: nothing drove
// `RemoteWorkspaceProjection` — the phone's own read model, and the class its
// entire session list depends on — with a v3 document at all. Every test here
// built a v2 `tabs[]`/`root` tile tree by hand, which is not what the app has
// persisted since #1013.
//
// The input is the REAL v3 file the app wrote on 2026-09-20, sanitized
// (testing/fixtures/workspace-v3/README.md): one window, three projects, 13
// sessions across five kinds.
//
// WHY the v2 test file is left alone rather than parameterised: main reads
// whatever is on disk, and a window that has not saved since the upgrade still
// holds a v2 document. Both generations must keep working, so both keep their
// own evidence.
// ---------------------------------------------------------------------------

const RECORDED = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../testing/fixtures/workspace-v3/2026-09-20-live-workspace.sanitized.json'),
    'utf8',
  ),
) as { version: number; windows: PersistedWindow[] }

const WINDOW = RECORDED.windows[0]!
const WORKSPACE = (WINDOW as unknown as {
  workspace: {
    projects: { id: string; title: string }[]
    sessions: Record<string, { kind?: string; projectId?: string; title?: string; cwd?: string; tldrIdentity?: string }>
  }
}).workspace

function project(saves: PersistedWindow[][]) {
  const store = fakeWorkspaceFileStore(saves)
  const projection = new RemoteWorkspaceProjection(store.asStore(), () => Promise.resolve({}))
  return { projection, commitNext: () => store.commitNext() }
}

describe('the phone projection on a REAL v3 workspace (#1031 item 4)', () => {
  it('is actually a v3 document, with no v2 tile tree to fall back on', () => {
    // Guard the guard: if the fixture ever stops being v3, every assertion
    // below would pass for the wrong reason.
    expect(RECORDED.version).toBe(3)
    expect(WORKSPACE.projects.length).toBeGreaterThan(0)
    expect((WORKSPACE as unknown as { tabs?: unknown }).tabs ?? []).toEqual([])
  })

  it('projects every session in the file', () => {
    const { projection } = project([[WINDOW]])
    try {
      const snapshot = projection.snapshot()
      expect(snapshot.size).toBe(Object.keys(WORKSPACE.sessions).length)
      for (const sessionId of Object.keys(WORKSPACE.sessions)) {
        expect(snapshot.get(sessionId)).toBeDefined()
      }
    } finally {
      projection.dispose()
    }
  })

  it('resolves each session to its project through `projectId`, not a tile tree', () => {
    // THE v3 membership rule. A reader that only understands `tabs[].root`
    // finds every session but places none of them, so the phone would list
    // agents with no project — which is exactly the regression this catches.
    const { projection } = project([[WINDOW]])
    try {
      const titleById = new Map(WORKSPACE.projects.map(entry => [entry.id, entry.title]))
      const placed = Object.entries(WORKSPACE.sessions)
        .filter(([, meta]) => meta.projectId && titleById.has(meta.projectId))
      // The recorded file must actually exercise this, or the test is vacuous.
      expect(placed.length).toBeGreaterThan(0)

      const snapshot = projection.snapshot()
      for (const [sessionId, meta] of placed) {
        expect(snapshot.get(sessionId)?.tabTitle).toBe(titleById.get(meta.projectId!))
      }
      // More than one project is represented, so a projection that hard-coded
      // a single title could not pass.
      const titles = new Set(placed.map(([, meta]) => titleById.get(meta.projectId!)))
      expect(titles.size).toBeGreaterThan(1)
    } finally {
      projection.dispose()
    }
  })

  it('carries the identity fields the phone renders, for every provider kind', () => {
    const { projection } = project([[WINDOW]])
    try {
      const snapshot = projection.snapshot()
      const kinds = new Set<string>()
      let joined = 0
      for (const [sessionId, meta] of Object.entries(WORKSPACE.sessions)) {
        const identity = snapshot.get(sessionId)!
        expect(identity.kind).toBe(meta.kind)
        expect(identity.cwd).toBe(meta.cwd ?? null)
        // `tldrIdentity` is the phone's JOIN KEY: the remote server keys every
        // TLDR and Goal frame by it, so dropping it silently empties both on
        // the phone while the session list still looks correct. kind and cwd
        // are pass-throughs and would not catch that.
        expect(identity.tldrIdentity).toBe(meta.tldrIdentity ?? null)
        if (meta.tldrIdentity) joined += 1
        kinds.add(identity.kind)
      }
      expect(joined).toBeGreaterThan(0)
      // claude, opencode, codex, terminal and extension-view are all present,
      // so a kind-specific break cannot hide.
      expect(kinds.size).toBeGreaterThanOrEqual(5)
    } finally {
      projection.dispose()
    }
  })

  it('re-projects a v3 save the same way it re-projects a v2 one', () => {
    // The freshness contract, on the shape that is actually being written.
    const onChange = vi.fn()
    // Changing the TLDR identity rather than the title, deliberately: the
    // projection's change detection compares identities field by field, and
    // the tldrIdentity comparison was unpinned by any test — deleting it left
    // all 74 remote tests green.
    const renamed = JSON.parse(JSON.stringify(WINDOW)) as typeof WINDOW
    const sessionId = Object.keys(WORKSPACE.sessions)
      .find(id => WORKSPACE.sessions[id]!.tldrIdentity)!
    ;(renamed as unknown as { workspace: { sessions: Record<string, { tldrIdentity?: string }> } })
      .workspace.sessions[sessionId]!.tldrIdentity = '11111111-2222-4333-8444-999999999999'

    const { projection, commitNext } = project([[WINDOW], [renamed]])
    try {
      projection.onChange(onChange)
      onChange.mockClear()
      commitNext()
      expect(onChange).toHaveBeenCalled()
      expect(projection.snapshot().get(sessionId)?.tldrIdentity).toBe('11111111-2222-4333-8444-999999999999')
    } finally {
      projection.dispose()
    }
  })
})
