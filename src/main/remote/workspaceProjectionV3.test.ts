import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import { RemoteWorkspaceProjection } from './workspaceProjection'

// ---------------------------------------------------------------------------
// #1031 item 4. Every phone-projection test built a v2 document by hand —
// `tabs[]` with a `root` tile tree — so nothing in the suite exercised the
// shape the app has actually been persisting since #1013 migrated to the
// unified stage. The projection DOES handle v3, but a regression in that half
// would have been silent, and the phone's entire session list depends on it.
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
    sessions: Record<string, { kind?: string; projectId?: string; title?: string; cwd?: string }>
  }
}).workspace

/** Mirrors the v2 file's store seam: the real store notifies only after bytes
 *  reach disk, and exposes the current windows synchronously. */
function fakeStore(saves: PersistedWindow[][]) {
  let windows: readonly PersistedWindow[] = saves[0] ?? []
  let cursor = 1
  const observers = new Set<(w: readonly PersistedWindow[]) => void>()
  return {
    windows: () => windows,
    observe(listener: (w: readonly PersistedWindow[]) => void) {
      observers.add(listener)
      return () => observers.delete(listener)
    },
    commitNext() {
      windows = saves[cursor] ?? windows
      cursor += 1
      for (const observer of observers) observer(windows)
    },
  }
}

function project(saves: PersistedWindow[][]) {
  const store = fakeStore(saves)
  const projection = new RemoteWorkspaceProjection(
    store as unknown as WorkspaceFileStore,
    () => Promise.resolve({}),
  )
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
      for (const [sessionId, meta] of Object.entries(WORKSPACE.sessions)) {
        const identity = snapshot.get(sessionId)!
        expect(identity.kind).toBe(meta.kind)
        expect(identity.cwd).toBe(meta.cwd ?? null)
        kinds.add(identity.kind)
      }
      // claude, opencode, codex, terminal and extension-view all present, so
      // a kind-specific break cannot hide.
      expect(kinds.size).toBeGreaterThanOrEqual(4)
    } finally {
      projection.dispose()
    }
  })

  it('re-projects a v3 save the same way it re-projects a v2 one', () => {
    // The freshness contract, on the shape that is actually being written.
    const onChange = vi.fn()
    const renamed = JSON.parse(JSON.stringify(WINDOW)) as typeof WINDOW
    const sessionId = Object.keys(WORKSPACE.sessions)[0]!
    ;(renamed as unknown as { workspace: { sessions: Record<string, { title?: string }> } })
      .workspace.sessions[sessionId]!.title = 'Renamed on the stage'

    const { projection, commitNext } = project([[WINDOW], [renamed]])
    try {
      projection.onChange(onChange)
      onChange.mockClear()
      commitNext()
      expect(onChange).toHaveBeenCalled()
      expect(projection.snapshot().get(sessionId)?.title).toBe('Renamed on the stage')
    } finally {
      projection.dispose()
    }
  })
})
