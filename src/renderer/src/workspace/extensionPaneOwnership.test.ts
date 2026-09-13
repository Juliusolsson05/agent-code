import { describe, expect, it } from 'vitest'

import {
  collectLiveProcessIds,
  collectOwnedSessionIds,
  collectTileLeafIds,
} from '@renderer/workspace/sessionOwnership'
import type { SessionId, SessionMeta, Tab } from '@renderer/workspace/types'

// The two ownership sets an `extension-view` pane has to sit BETWEEN.
//
// It is a real tile leaf, so its metadata must survive every autosave — but it has
// no process, so rehydrate must never try to spawn or recover one for it. Those are
// different questions with different answers, and the module they live in was
// deliberately split so that "excluded from spawning" cannot silently mean
// "excluded from persistence".
//
// That is not a hypothetical pairing. Built on the pre-split shape, the extension
// skip removed these panes from the OWNED set too, so pickOwnedSessions deleted
// their metadata on the very next autosave — turning them into the orphan leaves
// the same module then repairs by collapsing them out of the user's tree.

const AGENT = 'agent-1' as SessionId
const EXTENSION = 'ext-1' as SessionId
const TERMINAL = 'term-1' as SessionId

function meta(overrides: Partial<SessionMeta>): SessionMeta {
  return { cwd: '/repo', ...overrides } as SessionMeta
}

function workspaceWithAllThreeKinds(): { tabs: Tab[]; sessions: Record<SessionId, SessionMeta> } {
  return {
    tabs: [
      {
        id: 'tab-1',
        title: 'Project',
        focusedSessionId: AGENT,
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          a: { type: 'leaf', sessionId: AGENT },
          b: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: EXTENSION },
            b: { type: 'leaf', sessionId: TERMINAL },
          },
        },
      } as Tab,
    ],
    sessions: {
      [AGENT]: meta({ kind: 'claude' }),
      [EXTENSION]: meta({ kind: 'extension-view', extensionViewId: 'timer.main' }),
      [TERMINAL]: meta({ kind: 'terminal', tmuxName: 'ac-term-1' }),
    },
  }
}

describe('extension-view pane ownership', () => {
  it('is OWNED, so autosave keeps its metadata', () => {
    // If this ever fails, an extension pane's SessionMeta is deleted on the next
    // autosave tick and the pane silently disappears on the following launch.
    const owned = collectOwnedSessionIds(workspaceWithAllThreeKinds())
    expect(owned.has(EXTENSION)).toBe(true)
    expect(owned.has(AGENT)).toBe(true)
    expect(owned.has(TERMINAL)).toBe(true)
  })

  it('is a tile leaf, like every other pane', () => {
    expect(collectTileLeafIds(workspaceWithAllThreeKinds()).has(EXTENSION)).toBe(true)
  })

  it('is NOT in the live-process set, so rehydrate never spawns for it', () => {
    // Rehydrate spawns or recovers a process for every id in this set. An
    // extension-view kind reaching SessionManager falls through the provider switch
    // into the terminal branch and starts a stray shell.
    const live = collectLiveProcessIds(workspaceWithAllThreeKinds())
    expect(live.has(EXTENSION)).toBe(false)
    // …while its neighbours are, so the exclusion is not just "the set is empty".
    expect(live.has(AGENT)).toBe(true)
    expect(live.has(TERMINAL)).toBe(true)
  })

  it('keeps the two sets genuinely different for this kind', () => {
    // The property that matters, stated directly: owned ⊃ live, and the extension
    // pane is exactly what sits in the gap. Collapsing the two sets back into one
    // would pass every other assertion in this file.
    const input = workspaceWithAllThreeKinds()
    const owned = collectOwnedSessionIds(input)
    const live = collectLiveProcessIds(input)
    const gap = [...owned].filter(id => !live.has(id))
    expect(gap).toEqual([EXTENSION])
  })

  it('does not strand a leaf whose metadata is missing entirely', () => {
    // The failure mode undo-close produced: a leaf in the tree with no row in
    // `sessions`. It must not be reported as live (there is nothing to spawn — no
    // cwd, no kind) or the restore-completion gate becomes unsatisfiable forever,
    // which locks autosave and freezes the workspace file.
    const input = workspaceWithAllThreeKinds()
    delete input.sessions[EXTENSION]
    expect(collectLiveProcessIds(input).has(EXTENSION)).toBe(false)
    expect(collectOwnedSessionIds(input).has(EXTENSION)).toBe(false)
  })
})
