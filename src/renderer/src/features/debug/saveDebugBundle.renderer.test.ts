import { expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { assembleAndSaveDebugBundle, buildStateSnapshot } from './saveDebugBundle'

// #762: the renderer's screen copy only moves while a debug surface holds a
// lease, so the bundle's state snapshot takes the screen from MAIN when it
// has one, and falls back to the renderer copy only when main's read failed
// (#1236 review C: an unconditional fallback survived every test).
it('takes the screen fields from main, falling back to the renderer copy only without one', () => {
  const runtime = { ...emptyRuntime(), screen: 'stale', screenMarkdown: 'stale', recentScreen: 'stale', recentScreenMarkdown: 'stale' }
  const fromMain = buildStateSnapshot(runtime, { plain: 'live', markdown: 'live md', recent: 'live recent', recentMarkdown: 'live recent md' })
  expect(fromMain).toMatchObject({ screen: 'live', screenMarkdown: 'live md', recentScreen: 'live recent', recentScreenMarkdown: 'live recent md' })
  expect(buildStateSnapshot(runtime, null)).toMatchObject({ screen: 'stale', recentScreen: 'stale' })
})

// The whole consumer seam, through the real bundle assembly: main's screen
// and tail history must land in the saved files (#1236 review C: dropping
// the samples at this call site survived every test). window.api is the only
// mocked edge.
it('saves the screen and tail history main recorded into the bundle', async () => {
  const saved: Array<{ name: string; content: string }> = []
  const originalApi = window.api
  window.api = {
    ...originalApi,
    flushPerformance: async () => {},
    getPerformanceSnapshot: async () => null,
    readProxyEvents: async () => null,
    getScreenDebug: async () => ({
      screen: { plain: 'main screen', markdown: 'main screen', recent: 'main recent', recentMarkdown: 'main recent' },
      samples: [{ id: '0-a', seq: 0, ts: 1, tsIso: new Date(1).toISOString(), hash: 'a', lineCount: 1, content: 'recorded in main' }],
    }),
    saveDebugBundle: async (input: { files: Array<{ name: string; content: string }> }) => {
      saved.push(...input.files)
      return { bundlePath: '/tmp/bundle' }
    },
  } as never
  try {
    await assembleAndSaveDebugBundle({ sessionId: 'bundle-pane', runtime: emptyRuntime(), kind: 'claude' })
  } finally {
    window.api = originalApi
  }
  expect(saved.find(file => file.name === 'trace/screen/latest-tail.txt')?.content).toBe('recorded in main')
  const state = JSON.parse(saved.find(file => file.name.endsWith('state-snapshot.json'))!.content) as { recentScreen: string }
  expect(state.recentScreen).toBe('main recent')
})
