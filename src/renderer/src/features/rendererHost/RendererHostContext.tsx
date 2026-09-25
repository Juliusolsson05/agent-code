import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

import type { RenderedLocalFileTarget } from '@shared/renderedContent/targets'
import type { RenderShapeSightingsSink } from '@renderer/features/feed/evidence/observer'

// RendererHost — what the feed subtree needs from the APP it is mounted in
// (#1177), injected instead of reached for.
//
// WHY this exists. The feed's rows used to call the desktop directly:
// `window.api.openRenderedExternalUrl`, the Global Editor opener, the app
// store's `renderingDebugMode`, an eager Monaco/LSP path. The phone mounts
// the same rows, so it swapped those MODULES out with Vite aliases — six of
// them, with stubs that had to mirror each module's exports by hand, and an
// app-store stub the type checker could not see ("missing keys are not
// caught by tsc"). Every desktop change to one of those modules silently
// risked the phone. This context is the seam that replaces the aliases:
// the rows import real modules on every host, and the few host-specific
// capabilities arrive here, typed, from whichever app mounted the feed.
//
// Scope rule: only capabilities a RENDERED ROW needs belong here. Session
// I/O is the SessionFeed's job (SessionFeedContext), toasts are
// GlobalToastContext's, and anything a desktop pane chrome needs stays in
// the desktop pane. A capability goes here when a row the phone also mounts
// would otherwise have to touch `window.api` or desktop-only state.
//
// The DEFAULT is deliberately inert, not the desktop: a default that
// imported the desktop implementations would drag them into every bundle
// that mounts a row (the phone, the replay harness, renderer tests), which
// is exactly the coupling this file ends. The desktop app root mounts
// DesktopRendererHostProvider; the phone mounts its own host.

export type OpenExternalUrlOutcome = 'opened' | 'blocked' | 'failed'

export type RendererHost = {
  /**
   * Loads the Monaco editor runtime, or null when this host has none. Null
   * makes every code block use its static engine — the instant hljs layer
   * the Monaco path paints first anyway — so a host without an editor
   * renders code identically, just without the later LSP upgrade. A LOADER
   * (not the runtime) so only a host that supplies one ever bundles Monaco.
   */
  loadMonacoRuntime: (() => Promise<typeof import('@renderer/lib/code/monacoRuntime')>) | null
  /**
   * Open an http(s) link a rendered row produced. `sessionId` is the row's
   * session ('' outside one) and `modifierHeld` the ⌘/Ctrl state of the
   * click, because the desktop routes a plain click on a loopback URL to
   * that session's browser pocket. The link has already been classified as
   * a safe external URL by the row; the host only decides WHERE it opens.
   */
  openExternalUrl: (request: { url: string; sessionId: string; modifierHeld: boolean }) => Promise<OpenExternalUrlOutcome>
  /**
   * Open a workspace file a row links to, or null when this host has no
   * editor. Null turns file links and file-like inline code into plain
   * text instead of controls that could only fail.
   */
  openWorkspaceFile:
    | ((request: { root: string } & Omit<RenderedLocalFileTarget, 'kind'>) =>
        Promise<{ ok: true } | { ok: false; error: string }>)
    | null
  /** The desktop's rendering-debug overlay switch. Hosts without a debug
   *  surface pass false. */
  renderingDebugMode: boolean
  /**
   * The session recorder's lifecycle, for render-shape evidence capture, or
   * null when this host records nothing. Feed's capture provider arms the
   * shape observer from it; with null the observer is simply never armed —
   * the state the phone reached before only by `window.api` calls failing
   * inside try/catch.
   */
  sessionRecording: SessionRecordingBridge | null
}

export type SessionRecordingBridge = {
  /** Reload recovery: is this session recording right now, and under which
   *  recorder generation? */
  isRecording: (sessionId: string) => Promise<{ recording: boolean; generation: string | null }>
  /** Push: a recorder started (the authoritative arming signal). */
  onStarted: (cb: (payload: { sessionId: string; generation: string }) => void) => () => void
  /** Push: a recorder is closing and asks for the final flush. */
  onStopping: (cb: (payload: { sessionId: string; generation?: string }) => void) => () => void
  /** Acknowledge the final flush so the recorder may close. */
  finishStop: (sessionId: string, generation: string) => Promise<void>
  /** Where armed captures send their coalesced sightings. */
  appendSightings: RenderShapeSightingsSink
}

export const INERT_RENDERER_HOST: RendererHost = {
  loadMonacoRuntime: null,
  openExternalUrl: async () => 'blocked',
  openWorkspaceFile: null,
  renderingDebugMode: false,
  sessionRecording: null,
}

const RendererHostContext = createContext<RendererHost>(INERT_RENDERER_HOST)

export function RendererHostProvider({ host, children }: { host: RendererHost; children: ReactNode }) {
  return <RendererHostContext.Provider value={host}>{children}</RendererHostContext.Provider>
}

export function useRendererHost(): RendererHost {
  return useContext(RendererHostContext)
}
