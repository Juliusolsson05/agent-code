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

// #1336 (codex-headless#70 review a, P1): a fresh session's proxy run lives
// under `shell-<sessionId>`, chosen at process start, but once its first turn
// reveals the providerSessionId the bundle asked only for `resume-<id>`. The
// reader answered `match: 'none'` and the bundle had no proxy section. The
// stub answers exactly as readProxyEventsForBundle does for a segment that
// does not exist (match 'none', nulls) and for one that does.
async function bundleWithProxy(providerSessionId: string | null, existingSegment: string) {
  const saved: Array<{ name: string; content: string }> = []
  const asked: string[] = []
  const originalApi = window.api
  window.api = {
    ...originalApi,
    flushPerformance: async () => {},
    getPerformanceSnapshot: async () => null,
    getScreenDebug: async () => ({ screen: null, samples: [] }),
    readProxyEvents: async ({ sessionKey }: { sessionKey: string }) => {
      asked.push(sessionKey)
      return sessionKey === existingSegment
        ? { proxyEvents: '{"kind":"request"}\n{"kind":"request-body-latest"}\n', runDir: `/proxy/p/${sessionKey}/run1`, sessionMeta: null, match: 'exact', requestedSessionKey: sessionKey, matchedSessionSegment: sessionKey }
        : { proxyEvents: null, runDir: null, sessionMeta: null, match: 'none', requestedSessionKey: sessionKey, matchedSessionSegment: null }
    },
    saveDebugBundle: async (input: { files: Array<{ name: string; content: string }> }) => {
      saved.push(...input.files)
      return { bundlePath: '/tmp/bundle' }
    },
  } as never
  try {
    await assembleAndSaveDebugBundle({ sessionId: 'pane-1', runtime: emptyRuntime(), kind: 'codex', cwd: '/repo', providerSessionId })
  } finally {
    window.api = originalApi
  }
  const proxyFile = saved.find(file => file.name.includes('proxy') && file.content.includes('request-body-latest'))
  const manifest = JSON.parse(saved.find(file => file.name.endsWith('manifest.json'))!.content) as Record<string, unknown>
  return { asked, proxyFile, manifest }
}

it('finds a fresh session\'s proxy run after its first turn revealed the provider id', async () => {
  const { asked, proxyFile, manifest } = await bundleWithProxy('thread-1', 'shell-pane-1')
  expect(asked).toEqual(['resume-thread-1', 'shell-pane-1'])
  expect(proxyFile).toBeDefined()
  expect(JSON.stringify(manifest)).toContain('shell-pane-1')
})

it('prefers the resumed run when the process was launched to resume', async () => {
  const { asked, proxyFile } = await bundleWithProxy('thread-1', 'resume-thread-1')
  expect(asked).toEqual(['resume-thread-1'])
  expect(proxyFile).toBeDefined()
})
