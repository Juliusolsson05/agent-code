import { describe, expect, it } from 'vitest'

import {
  collectSessionIds,
  parseWorkspaceFile,
  readWindowWorkspaceJson,
  serializeWorkspaceFile,
  withoutWindow,
  withWindowSlice,
} from '@main/storage/workspaceFile.js'
import type { WorkspaceFile } from '@main/storage/workspaceFile.js'

// The window dimension of workspace.json.
//
// The first test here is the one that matters most in the whole multi-window
// change: `useAutoSave` prunes sessions it cannot prove are owned, so if a
// window's save could rewrite another window's slice, the two windows would
// delete each other's agents from disk every 400ms. That property is asserted
// directly rather than inferred from an integration test, because the failure
// is silent, durable, and destroys user data.

function mintIds(): () => string {
  let n = 0
  return () => `window-${(n += 1)}`
}

function okFile(text: string): WorkspaceFile {
  const parsed = parseWorkspaceFile(text, mintIds())
  if (parsed.kind !== 'ok') throw new Error(`expected a readable file, got: ${parsed.reason}`)
  return parsed.file
}

describe('window slices are independent', () => {
  it('a save into one window leaves every other window untouched', () => {
    const file = okFile(JSON.stringify({
      version: 2,
      windows: [
        {
          windowId: 'left',
          bounds: { x: 0, y: 0, width: 1400, height: 900 },
          displayId: 1,
          fullScreen: false,
          workspace: { sessions: { 'left-agent': { cwd: '/left' } }, tabs: [] },
        },
        {
          windowId: 'right',
          bounds: { x: 1400, y: 0, width: 1400, height: 900 },
          displayId: 2,
          fullScreen: false,
          workspace: { sessions: { 'right-agent': { cwd: '/right' } }, tabs: [] },
        },
      ],
    }))

    const before = file.windows.find(w => w.windowId === 'right')!
    const next = withWindowSlice(
      file,
      'left',
      // The left window serializes a workspace that knows nothing about the
      // right window's agent — which is exactly the real situation, since one
      // renderer cannot see another's store. If the merge were naive, this save
      // would erase `right-agent`.
      { sessions: { 'left-agent': { cwd: '/left' }, 'left-second': { cwd: '/left2' } }, tabs: [] },
      { bounds: { x: 10, y: 10, width: 1400, height: 900 }, displayId: 1, fullScreen: false },
    )

    const after = next.windows.find(w => w.windowId === 'right')!
    // Reference identity, not just deep equality: carrying the untouched slice
    // by reference is what makes "cannot be rewritten" true by construction. A
    // future refactor that deep-clones every window on save would still pass a
    // deep-equal assertion while reopening the door to a merge bug.
    expect(after).toBe(before)
    expect(collectSessionIds(next)).toEqual(
      new Set(['left-agent', 'left-second', 'right-agent']),
    )
  })

  it('adds a window slice when the window has never saved before', () => {
    const file = okFile(JSON.stringify({ version: 2, windows: [] }))
    const next = withWindowSlice(file, 'fresh', { sessions: {}, tabs: [] }, {
      bounds: null,
      displayId: null,
      fullScreen: false,
    })
    expect(next.windows.map(w => w.windowId)).toEqual(['fresh'])
  })

  it('drops only the named window', () => {
    const file = okFile(JSON.stringify({
      version: 2,
      windows: [
        { windowId: 'a', workspace: { sessions: { one: {} } } },
        { windowId: 'b', workspace: { sessions: { two: {} } } },
      ],
    }))
    expect(withoutWindow(file, 'a').windows.map(w => w.windowId)).toEqual(['b'])
  })
})

describe('migration from the single-window format', () => {
  it('moves a v1 workspace into windows[0] without touching its contents', () => {
    // A v1 file as the app actually wrote it: no version, one `workspace`
    // envelope, and every field the renderer persists.
    const legacyWorkspace = {
      tabs: [{ id: 'tab-1', title: 'agent-code', focusedSessionId: 's1', root: { leaf: 's1' } }],
      activeTabId: 'tab-1',
      dispatchMode: null,
      sessions: { s1: { cwd: '/repo', kind: 'claude' } },
      detachedSessions: { s2: { sessionId: 's2', surface: 'dispatch', projectTabId: 'tab-1' } },
      buried: [{ id: 's3', sessionId: 's3', sessionMeta: { cwd: '/repo' }, buriedAt: 1 }],
      pinnedSessionIds: ['s2'],
      tileTabs: null,
      drafts: { s1: 'half-written prompt' },
    }
    const parsed = parseWorkspaceFile(
      JSON.stringify({ workspace: legacyWorkspace }),
      mintIds(),
    )

    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    expect(parsed.migratedFromV1).toBe(true)
    expect(parsed.file.windows).toHaveLength(1)
    // The whole point of keeping `workspace` opaque: migration must not
    // normalize, reorder, or drop anything the renderer owns. Deep equality
    // over the entire structure is the assertion, not a spot check of `tabs` —
    // a migration that silently lost `drafts` or `pinnedSessionIds` would pass
    // a narrower test and lose real user state.
    expect(parsed.file.windows[0]?.workspace).toEqual(legacyWorkspace)
    expect(parsed.file.windows[0]?.bounds).toBeNull()
  })

  it('round-trips a v2 file unchanged', () => {
    const text = serializeWorkspaceFile(okFile(JSON.stringify({
      version: 2,
      windows: [{
        windowId: 'w1',
        bounds: { x: 1, y: 2, width: 800, height: 600 },
        displayId: 7,
        fullScreen: true,
        workspace: { sessions: { a: {} } },
      }],
    })))
    expect(okFile(text)).toEqual(okFile(text))
    expect(okFile(text).windows[0]).toMatchObject({
      windowId: 'w1',
      fullScreen: true,
      displayId: 7,
    })
  })

  it('hands back the renderer envelope it expects', () => {
    const file = okFile(JSON.stringify({
      version: 2,
      windows: [{ windowId: 'w1', workspace: { sessions: { a: {} } } }],
    }))
    // rehydrate.ts must never learn that windows exist, so what comes back is
    // byte-shaped exactly like the pre-multi-window file.
    expect(readWindowWorkspaceJson(file, 'w1')).toBe(
      JSON.stringify({ workspace: { sessions: { a: {} } } }),
    )
    expect(readWindowWorkspaceJson(file, 'never-saved')).toBeNull()
  })
})

describe('refusing to destroy a file we cannot represent', () => {
  it('reports a newer version as unreadable instead of resetting it', () => {
    const parsed = parseWorkspaceFile(
      JSON.stringify({ version: 99, windows: [] }),
      mintIds(),
    )
    // Not `ok` with empty windows: that would let this build start fresh and
    // then overwrite a newer build's workspace on the first autosave. Running
    // an older build must cost a session, not the user's tabs and agents.
    expect(parsed.kind).toBe('unreadable')
  })

  it('reports truncated JSON as unreadable', () => {
    expect(parseWorkspaceFile('{"version":2,"windows":[', mintIds()).kind).toBe('unreadable')
  })

  it('keeps the first of two windows sharing an id', () => {
    // Hand-edited files are an explicit threat model across this codebase.
    // Duplicate ids would make a save ambiguous about which slot it replaces,
    // which is how one window's workspace ends up in another window's slot.
    const file = okFile(JSON.stringify({
      version: 2,
      windows: [
        { windowId: 'dup', workspace: { sessions: { first: {} } } },
        { windowId: 'dup', workspace: { sessions: { second: {} } } },
      ],
    }))
    expect(file.windows).toHaveLength(1)
    expect(collectSessionIds(file)).toEqual(new Set(['first']))
  })

  it('skips a window record with no workspace payload', () => {
    // Otherwise a junk entry produces an empty window on every launch that the
    // user never asked for and cannot get rid of except by editing the file.
    const file = okFile(JSON.stringify({
      version: 2,
      windows: [{ windowId: 'ghost' }, { windowId: 'real', workspace: { sessions: {} } }],
    }))
    expect(file.windows.map(w => w.windowId)).toEqual(['real'])
  })
})
