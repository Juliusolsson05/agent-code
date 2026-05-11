import assert from 'node:assert/strict'

import {
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
