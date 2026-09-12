import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterEach, beforeEach, vi } from 'vitest'

import { ensureAbortSignalTimeout } from 'opencode-terminal-headless/testing'

import { createOpencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase'
import { createOpencodeHistorySource } from '@providers/opencode/runtime/opencodeHistory'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { makeWorkspaceRefsForTest } from './workspaceRefsForTest'

// What every OpenCode Terminal renderer test shares, whether or not it runs a
// live backend: the pane's identity and workspace, a monotonic wait, a
// per-test temporary directory, a minimal `window.api`, cleanup that runs on
// failure too, and history served by the real OpenCode history source.
//
// WHY this is separate from opencodeTerminalPane.tsx: that module imports
// main's SessionManager and forwarder, which only work behind the main-module
// stand-ins each live test file installs with `vi.mock`. Reload, restart and
// adoption tests need no backend, so they import only this.

export const SESSION_ID = 'opencode-terminal-pane' as SessionId
export const PARENT_ID = 'orchestrating-parent' as SessionId
export const PANE_CWD = '/sandbox/project'

/**
 * Wait for an observable condition, with a monotonic deadline (a wall-clock
 * jump must neither fire nor extend it). Polls on a macrotask so sockets,
 * SQLite reads and main's setImmediate batches all get to run in between.
 */
export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export function paneMeta(providerSessionId: string): SessionMeta {
  return {
    cwd: PANE_CWD,
    kind: 'opencode',
    providerRuntime: 'terminal',
    providerSessionId,
    providerSessionIdSource: 'jsonl-entry',
    orchestrationParentId: PARENT_ID,
    orchestrationRootId: PARENT_ID,
    orchestrationRunId: 'run-1',
    orchestrationRole: 'child',
  }
}

/**
 * A real workspace shape, not a sessions-only stub: Agent Management scopes
 * by tab membership and Agent Status derives placement from the tile tree, so
 * both read nothing from a workspace that lacks them. The parent sits in the
 * same tab as the pane, which is what makes it a legitimate Agent Management
 * caller for this pane.
 */
export function paneWorkspace(meta: SessionMeta): WorkspaceState {
  return {
    tabs: [{
      id: 'project',
      title: 'project',
      focusedSessionId: PARENT_ID,
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: { type: 'leaf', sessionId: PARENT_ID },
        b: { type: 'leaf', sessionId: SESSION_ID },
      },
    }],
    activeTabId: 'project',
    dispatchMode: null,
    sessions: { [PARENT_ID]: { cwd: PANE_CWD, kind: 'claude' }, [SESSION_ID]: meta },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

export type HistoryServer = {
  loadInitialHistory: ReturnType<typeof vi.fn<(request: { cwd: string; providerSessionId: string; limit: number }) => ReturnType<ReturnType<typeof createOpencodeHistorySource>['loadHistoryChunk']>>>
  loadOlderHistory: ReturnType<typeof vi.fn<(request: { cwd: string; providerSessionId: string; limit: number; beforeMarker: string }) => ReturnType<ReturnType<typeof createOpencodeHistorySource>['loadHistoryChunk']>>>
}

export type RestoredPane = {
  meta: SessionMeta
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  runtime: () => SessionRuntime
}

/**
 * Per-test scope: a temporary directory, a `window.api` with only what these
 * paths call, and cleanup that runs (every step of it) whether the test
 * passed or not. Call once at the top of a test file.
 */
export function opencodeTerminalScope() {
  let dir = ''
  let cleanups: Array<() => unknown> = []
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

  beforeEach(() => {
    ensureAbortSignalTimeout()
    dir = mkdtempSync(join(tmpdir(), 'oc-terminal-pane-'))
    cleanups = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
    })
  })

  afterEach(async () => {
    // Every release is attempted even when an earlier one throws, so a
    // failing test cannot leak the next test a socket or a database handle.
    const failures: unknown[] = []
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    rmSync(dir, { recursive: true, force: true })
    if (originalApi) Object.defineProperty(window, 'api', originalApi)
    else Reflect.deleteProperty(window, 'api')
    if (failures.length > 0) throw failures[0]
  })

  const onCleanup = (cleanup: () => unknown): void => {
    cleanups.push(cleanup)
  }

  /** Add `window.api` methods for this test on top of the scope's minimal set. */
  const extendApi = (methods: Record<string, unknown>): void => {
    Object.defineProperty(window, 'api', { configurable: true, value: { ...window.api, ...methods } })
  }

  /**
   * Install `window.api.loadInitialHistory` / `loadOlderHistory` backed by the
   * real OpenCode history source over `database`: what main's history
   * loader delegates to for a provider that owns its history. A `{ error }`
   * database fails to resolve the way `opencode db path` fails.
   *
   * `olderPageLimit` shrinks older pages below the renderer's fixed 200 so a
   * recorded session of a hundred-odd messages spans several pages, which is
   * what exercises the cursor handoff between them. Main passes the
   * renderer's limit through unchanged; the mocks record what was asked.
   */
  function serveHistoryFrom(database: string | { error: string }, options: { olderPageLimit?: number } = {}): HistoryServer {
    const handle = createOpencodeDatabase({
      resolveDbPath: typeof database === 'string'
        ? async () => database
        : async () => { throw new Error(database.error) },
    })
    onCleanup(() => handle.release())
    const source = createOpencodeHistorySource(handle)
    const loadInitialHistory = vi.fn((request: { cwd: string; providerSessionId: string; limit: number }) =>
      source.loadHistoryChunk({ cwd: request.cwd, providerSessionId: request.providerSessionId, limit: request.limit }))
    const loadOlderHistory = vi.fn((request: { cwd: string; providerSessionId: string; limit: number; beforeMarker: string }) =>
      source.loadHistoryChunk({
        cwd: request.cwd,
        providerSessionId: request.providerSessionId,
        limit: Math.min(request.limit, options.olderPageLimit ?? request.limit),
        beforeMarker: request.beforeMarker,
      }))
    extendApi({ loadInitialHistory, loadOlderHistory })
    return { loadInitialHistory, loadOlderHistory }
  }

  /**
   * A pane with no live backend (reload, restart, adoption all start from a
   * seeded runtime, not one a stream built). Its runtime map is written
   * synchronously, like the workspace store.
   */
  function restoredPane(providerSessionId: string, runtime: SessionRuntime): RestoredPane {
    const meta = paneMeta(providerSessionId)
    let runtimes: Record<SessionId, SessionRuntime> = { [SESSION_ID]: runtime }
    const refs = makeWorkspaceRefsForTest(paneWorkspace(meta))
    refs.latestRuntimesRef.current = runtimes
    const setRuntimes: WorkspaceSetRuntimes = next => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    return { meta, refs, setRuntimes, runtime: () => runtimes[SESSION_ID]! }
  }

  return {
    dir: () => dir,
    onCleanup,
    extendApi,
    serveHistoryFrom,
    restoredPane,
  }
}

export type OpencodeTerminalScope = ReturnType<typeof opencodeTerminalScope>
