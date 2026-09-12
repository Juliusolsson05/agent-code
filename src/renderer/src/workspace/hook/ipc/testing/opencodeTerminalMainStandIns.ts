import type { AgentSession, SessionOptions } from '@shared/types/session'

// The only main-process modules the OpenCode Terminal pane harness replaces,
// and why each one. Test files install these with `vi.mock(path, async () =>
// (await import('./testing/opencodeTerminalMainStandIns')).<standIn>)`.
//
// WHY a module of its own: `vi.mock` must be called in each test file, but its
// factory may import lazily. The factories cannot import the harness itself
// (opencodeTerminalPane.tsx): that module imports SessionManager, which
// imports the very modules being mocked, and a factory that waits on a module
// still evaluating would deadlock. This file imports nothing at runtime, so
// every factory can read the routing hooks below without a cycle.
//
// Everything NOT listed here is production code in the harness: the OpenCode
// Terminal adapter and opencode-terminal-headless (real sockets, real
// SQLite), SessionManager's per-session event relay (ownership fence,
// readiness revisions, cached conditions, exit → removed → exit), main's
// forwarder with its JSONL, semantic and process-state coalescers, and the
// renderer's useIpcSubscriptions with the workspace's real updateRuntime.

export const mainStandIns = {
  /**
   * Where main's forwarder hands a window message. Production:
   * windowRegistry.sendToSessionWindow → Electron IPC → preload → the
   * SessionFeed. The harness delivers it to a FakeSessionFeed after a
   * structured clone, the same serialization Electron IPC applies.
   */
  deliver: (_sessionId: string, _channel: string, _payload: unknown): void => {},
  /**
   * The provider registry's `createTerminalSession`. Production constructs
   * `new OpencodeTerminalSession(options)`; the harness constructs the same
   * class with its PTY spawn and launch step injected (no real TUI, and the
   * launch points at a replay server and a fixture database).
   */
  createTerminalSession: null as null | ((options: SessionOptions) => AgentSession),
}

/** windowRegistry: routes to a BrowserWindow, which a test does not have. */
export const windowRegistryStandIn = {
  sendToSessionWindow: (sessionId: string, channel: string, payload: unknown): void =>
    mainStandIns.deliver(sessionId, channel, payload),
  broadcastToWindows: (): void => {},
  releaseSession: (): void => {},
}

/**
 * registry.main: only the OpenCode terminal factory is reachable. The real
 * registry would construct the adapter with the production PTY and launch,
 * i.e. start an installed OpenCode.
 */
export const registryMainStandIn = {
  getMainProvider: () => ({
    name: 'OpenCode',
    createSession: () => {
      throw new Error('the structured OpenCode runtime is not under test here')
    },
    createTerminalSession: (options: SessionOptions) => {
      if (!mainStandIns.createTerminalSession) throw new Error('no OpenCode Terminal factory installed')
      return mainStandIns.createTerminalSession(options)
    },
  }),
}

/**
 * workspaceDirectory: the spawn guard stats the cwd; panes run in a
 * synthetic `/sandbox/project` that does not exist on disk.
 */
export const workspaceDirectoryStandIn = {
  MissingWorkspaceDirectoryError: class MissingWorkspaceDirectoryError extends Error {},
  assertWorkspaceDirectoryExists: async (): Promise<void> => {},
}

/**
 * toolchain: SessionManager resolves the provider CLI to an absolute path
 * before spawning. The injected PTY never executes it.
 */
export const toolchainStandIn = {
  getToolPath: (): string => '/usr/bin/true',
  refreshToolchainFromState: async (): Promise<void> => {},
}

/**
 * PerformanceService and the feed-debug log write under the user's
 * ~/.config/agent-code, which a test must never touch.
 */
export const performanceServiceStandIn = {
  performanceService: {
    mark: (): void => {},
    record: (): void => {},
    error: (): void => {},
    metric: (): void => {},
  },
}

export const feedDebugLogStandIn = {
  forgetFeedDebugSession: (): void => {},
}
