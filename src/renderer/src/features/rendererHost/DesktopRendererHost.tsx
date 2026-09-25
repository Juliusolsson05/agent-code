import { useMemo } from 'react'
import type { ReactNode } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { openInPocket } from '@renderer/features/browser-pocket/state/pocketBus'
import { isLoopbackUrl } from '@shared/browserPocket/url'

import { RendererHostProvider } from './RendererHostContext'
import type { RendererHost } from './RendererHostContext'

// The desktop app's RendererHost (#1177): the Electron-backed capabilities
// the feed's rows used to reach for directly. Mounted once at the app root
// (app/main.tsx). Only this module — never a row — may import the desktop
// implementations below, which is what keeps them out of the phone bundle.

// Stable across renders: none of these close over React state.
const loadMonacoRuntime: RendererHost['loadMonacoRuntime'] = () => import('@renderer/lib/code/monacoRuntime')

const openExternalUrl: RendererHost['openExternalUrl'] = async ({ url, sessionId, modifierHeld }) => {
  // A dev-server link printed by an agent opens in THAT agent's browser
  // pocket (#1142) — the whole point of a lane-attached browser is not
  // guessing which localhost belongs to which worktree. ⌘/Ctrl-click keeps
  // the old "open in my browser" behaviour.
  if (sessionId && !modifierHeld && isLoopbackUrl(url) && openInPocket(sessionId, url)) return 'opened'
  try {
    const result = await window.api.openRenderedExternalUrl({ url })
    return result.ok ? 'opened' : 'blocked'
  } catch {
    return 'failed'
  }
}

const openWorkspaceFile: NonNullable<RendererHost['openWorkspaceFile']> = async request => {
  // The global-editor opener imports the browser app store, whose theme
  // slice touches `document` at module load. Loading it on actual activation
  // keeps every link — and every headless import of a row — from
  // initializing editor state. A chunk-load failure is reported like any
  // other open failure, never as an unhandled rejection.
  try {
    const { openFileInGlobalEditor } = await import('@renderer/features/global-editor/openFileInGlobalEditor')
    const result = await openFileInGlobalEditor(request)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  } catch {
    return { ok: false, error: 'the editor could not be loaded' }
  }
}

// The desktop recorder lives in main; these are its preload bridges, bound
// lazily so a missing preload (a bare harness) fails inside the capture
// provider's own guards rather than at module load.
const sessionRecording: NonNullable<RendererHost['sessionRecording']> = {
  isRecording: sessionId => window.api.isSessionRecording(sessionId),
  onStarted: cb => window.api.onSessionRecordingStarted(cb),
  onStopping: cb => window.api.onSessionRecordingStopping(cb),
  finishStop: (sessionId, generation) => window.api.finishSessionRecordingStop(sessionId, generation),
  appendSightings: (sessionId, generation, sightings) => window.api.appendRenderShapeSightings(sessionId, generation, sightings),
}

export function DesktopRendererHostProvider({ children }: { children: ReactNode }) {
  const renderingDebugMode = useAppStore(state => state.renderingDebugMode)
  // One object per debug-mode value, so consumers re-render only when a
  // capability actually changes.
  const host = useMemo<RendererHost>(
    () => ({ loadMonacoRuntime, openExternalUrl, openWorkspaceFile, renderingDebugMode, sessionRecording }),
    [renderingDebugMode],
  )
  return <RendererHostProvider host={host}>{children}</RendererHostProvider>
}
