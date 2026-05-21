import assert from 'node:assert/strict'

import {
  collectLiveProcessIds,
  collectOwnedSessionIds,
  collectUnownedSessionIds,
  pickOwnedSessions,
  pruneSessionOwnership,
} from '../src/renderer/src/workspace/sessionOwnership'
import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  SessionMeta,
  Tab,
} from '../src/renderer/src/workspace/types'

const meta = (cwd: string, kind: SessionMeta['kind'] = 'codex'): SessionMeta => ({
  cwd,
  kind,
  providerSessionId: `${cwd}-provider`,
})

const tab: Tab = {
  id: 'tab-a',
  title: 'Project A',
  focusedSessionId: 'visible-a',
  root: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.5,
    a: { type: 'leaf', sessionId: 'visible-a' },
    b: { type: 'leaf', sessionId: 'visible-b' },
  },
}

const detached: DetachedSessionRecord = {
  sessionId: 'detached-a',
  surface: 'dispatch',
  projectTabId: 'tab-a',
  projectTabTitle: 'Project A',
  projectTabIndex: 0,
  detachedAt: 1,
}

const buried: BuriedPaneRecord = {
  id: 'buried-a',
  sessionId: 'buried-a',
  sessionMeta: meta('/buried'),
  buriedAt: 2,
  sourceTabId: 'tab-a',
  sourceTabTitle: 'Project A',
  sourceTabIndex: 0,
}

const sessions: Record<string, SessionMeta> = {
  'visible-a': meta('/visible-a'),
  'visible-b': meta('/visible-b'),
  'detached-a': meta('/detached-a'),
  'buried-a': meta('/buried-a'),
  'stale-a': meta('/stale-a'),
}

{
  const owned = collectOwnedSessionIds({
    tabs: [tab],
    sessions,
    detachedSessions: { 'old-key': detached },
    buried: [buried],
  })

  assert.deepEqual(
    [...owned].sort(),
    ['buried-a', 'detached-a', 'visible-a', 'visible-b'],
  )
}

// WHY this block exists:
//
// The previous regression was the inverse of the original OOM bug. After the
// owned-set was introduced to stop orphan metadata from respawning, EVERY
// owner — including detached/buried — got a fresh PTY + mitmdump on rehydrate.
// Each "park this dispatch agent" action permanently added a backend process
// to every future launch. The live-process set is the smaller, stricter
// answer to "what must the user be able to type into RIGHT NOW?", and
// rehydrate filters its Promise.all by this set.
//
// The asserts below pin down the contract:
//   - tile leaves ARE live processes (visible-a, visible-b)
//   - detached are NOT (dispatch parking, wake-on-attach later)
//   - buried are NOT (hidden by user, wake-on-restore later)
//   - dispatch focus alone is NOT (it is a selection pointer, not ownership)
{
  const live = collectLiveProcessIds({
    tabs: [tab],
    sessions,
    detachedSessions: { 'old-key': detached },
    buried: [buried],
  })
  assert.deepEqual([...live].sort(), ['visible-a', 'visible-b'])

  // No tabs ⇒ no live processes, even with detached/buried records present.
  // This is the rehydrate-after-bury edge case.
  const liveEmpty = collectLiveProcessIds({
    tabs: [],
    sessions,
    detachedSessions: { 'old-key': detached },
    buried: [buried],
  })
  assert.deepEqual([...liveEmpty], [])
}

{
  assert.deepEqual(
    collectUnownedSessionIds({
      tabs: [tab],
      sessions,
      detachedSessions: { 'detached-a': detached },
      buried: [buried],
    }),
    ['stale-a'],
  )
}

{
  const owned = new Set(['visible-a', 'buried-a'])
  assert.deepEqual(Object.keys(pickOwnedSessions(sessions, owned)).sort(), [
    'buried-a',
    'visible-a',
  ])
}

{
  const pruned = pruneSessionOwnership({
    tabs: [tab],
    sessions: {
      ...sessions,
      'missing-detached-meta': meta('/missing-detached-meta'),
    },
    detachedSessions: {
      'stale-key': detached,
      'missing-owner': {
        ...detached,
        sessionId: 'owner-without-meta',
      },
    },
    buried: [
      buried,
      {
        ...buried,
        id: 'buried-without-meta',
        sessionId: 'buried-without-meta',
      },
    ],
    dispatchMode: {
      scope: 'project',
      focusedSessionId: 'stale-a',
    },
  })

  // WHY this assertion matters:
  //
  // The regression was not "visible panes disappear"; it was the opposite:
  // invisible metadata survived and became real processes. This fixture keeps
  // all legitimate hidden owners (detached + buried), normalizes detached keys
  // to their session id, and proves that focus alone does not keep stale-a
  // alive.
  assert.deepEqual(Object.keys(pruned.sessions).sort(), [
    'buried-a',
    'detached-a',
    'visible-a',
    'visible-b',
  ])
  assert.deepEqual(Object.keys(pruned.detachedSessions), ['detached-a'])
  assert.deepEqual(pruned.buried.map(entry => entry.sessionId), ['buried-a'])
  assert.equal(pruned.dispatchMode?.focusedSessionId, undefined)
  assert.deepEqual(pruned.droppedSessionIds.sort(), [
    'missing-detached-meta',
    'stale-a',
  ])
}
