import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { LiveFixtureWriter, sessionRowFor } from 'opencode-terminal-headless/testing'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { opencodeTerminalScope, paneMeta, SESSION_ID, waitFor } from '@renderer/workspace/hook/ipc/testing/opencodeTerminalScope'
import { seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'

import { loadInitialHistoryForSession, reconcileStuckTranscriptLoads } from './initialHistory'

// The initial-history loader's two safety valves, exercised on the pane type
// that now depends on them most: an OpenCode Terminal pane, whose history
// became a loader call on every spawn, recovery, rehydrate, restart and MCP
// read when it stopped being skipped.
//
// NOTE: the loader's concurrency limiter is module state. Each test file gets
// its own module instance, and every load here settles before its test ends,
// so no test inherits a held slot from another.

const scope = opencodeTerminalScope()
const PROVIDER_SESSION = 'ses_empty_terminal'

// A real OpenCode database holding the session row and nothing else: a pane
// whose TUI was opened and never prompted.
function emptySession() {
  const file = join(scope.dir(), 'empty.db')
  const writer = new LiveFixtureWriter(file, PROVIDER_SESSION, sessionRowFor(PROVIDER_SESSION))
  scope.onCleanup(() => writer.close())
  const history = scope.serveHistoryFrom(file)
  // `history.load.end` is the loader's own "this load settled" breadcrumb.
  const settled: string[] = []
  scope.extendApi({
    reportSessionLifecycle: (report: { name: string; data?: { status?: string } }) => {
      if (report.name === 'history.load.end') settled.push(report.data?.status ?? 'unknown')
    },
  })
  return { history, settled }
}

// Seeded the way rehydrate leaves every durable agent: transcript `loading`.
const rehydratedPane = () =>
  scope.restoredPane(PROVIDER_SESSION, { ...emptyRuntime(), ...seedResumedRuntimeFields(undefined, paneMeta(PROVIDER_SESSION)) })

describe('the initial-history loader under failure and repetition', () => {
  it('frees its slot when the history bridge throws before returning a promise, so a third load still runs', async () => {
    const { history, settled } = emptySession()
    const pane = rehydratedPane()
    // A missing or broken preload method throws synchronously. The loader's
    // two slots used to be released in a `.finally()` on the returned promise,
    // which a synchronous throw never reaches: two such throws held both
    // slots forever and every later load in the window waited behind them.
    const broken = vi.fn(() => {
      throw new Error('loadInitialHistory is not attached')
    })
    scope.extendApi({ loadInitialHistory: broken })
    for (const attempt of [1, 2]) {
      await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })
      expect(settled).toHaveLength(attempt)
      expect(pane.runtime()).toMatchObject({ transcriptStatus: 'error', transcriptError: 'loadInitialHistory is not attached' })
    }

    scope.extendApi({ loadInitialHistory: history.loadInitialHistory })
    // Not awaited: with a leaked limiter this promise never settles, and the
    // bounded wait below is what reports it.
    void loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })
    await waitFor(() => pane.runtime().transcriptStatus === 'ready', 'a third load to run', 2_000)
    expect(history.loadInitialHistory).toHaveBeenCalledTimes(1)
  })

  it('re-kicks a genuinely empty terminal session once per pass, each ending ready, and never while a read is in flight', async () => {
    const { history, settled } = emptySession()
    const pane = rehydratedPane()
    // Each read waits for the test, so a second pass can land mid-read.
    const releases: Array<() => void> = []
    const gated = vi.fn(async (request: { cwd: string; providerSessionId: string; limit: number }) => {
      await new Promise<void>(resolve => releases.push(resolve))
      return history.loadInitialHistory(request)
    })
    scope.extendApi({ loadInitialHistory: gated })

    // Boot schedules exactly three reconciler passes (useBootstrap's
    // STUCK_TRANSCRIPT_HEAL_DELAYS_MS). An empty session matches "stuck" on
    // every pass, because an empty feed is what a dropped load also looks
    // like; each pass therefore costs one read of an empty session, and must
    // end `ready`, never `error`, and never start a second read of its own.
    for (const pass of [1, 2, 3]) {
      expect(reconcileStuckTranscriptLoads({ refs: pane.refs, setRuntimes: pane.setRuntimes })).toBe(1)
      await waitFor(() => releases.length === pass, `pass ${pass}'s read to start`)
      expect(reconcileStuckTranscriptLoads({ refs: pane.refs, setRuntimes: pane.setRuntimes })).toBe(0)
      releases[pass - 1]!()
      await waitFor(() => settled.length === pass, `pass ${pass} to settle`)
      expect(settled[pass - 1]).toBe('ready')
      expect(pane.runtime()).toMatchObject({ transcriptStatus: 'ready', transcriptError: null, entries: [], totalEntries: 0 })
    }
    expect(gated).toHaveBeenCalledTimes(3)
  })
})
