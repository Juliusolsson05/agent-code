import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '@renderer/app/App'
import { GlobalToastProvider } from '@renderer/ui/GlobalToast'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { ipcSessionFeed } from '@renderer/features/sessionFeed/IpcSessionFeed'
import '@renderer/styles.css'
import 'highlight.js/styles/github-dark.css'
import 'monaco-editor/min/vs/editor/editor.main.css'
// xterm.js base CSS — required for the TerminalLeaf component to render
// its cells with correct geometry. xterm.js uses absolute-positioned
// rows and explicit cell widths, none of which work without this file.
import '@xterm/xterm/css/xterm.css'
import { initializePerformance, mark } from '@renderer/performance/client'
import { AppErrorBoundary } from '@renderer/app/AppErrorBoundary'
import { WorkflowClientProvider } from '@renderer/features/workflows/client/WorkflowClientContext'
import { ipcWorkflowClient } from '@renderer/features/workflows/client/IpcWorkflowClient'
import { startRendererFreezeHeartbeat } from '@renderer/performance/freezeHeartbeat'
import { InstalledExtensionsLoader } from '@renderer/apps/host/InstalledExtensionsLoader'

void initializePerformance().then(() => {
  mark('app.renderer.reactRenderCalled')
})

// Renderer incident breadcrumbs -> main journal. Attached BEFORE React mounts so
// even an early mount error is reported. Rate-limited (coalesce by message over a
// 5s window) and redacted (truncated message + short stack) here at the boundary
// so a render-loop error storm can't flood the journal or the IPC channel.
{
  const recent = new Map<string, number>()
  const WINDOW_MS = 5000
  const send = (
    kind: 'renderer.error' | 'renderer.unhandledrejection',
    message: string,
    extra: { source?: string; line?: number; column?: number; stack?: string },
  ): void => {
    const now = Date.now()
    const last = recent.get(message)
    if (last !== undefined && now - last < WINDOW_MS) return
    recent.set(message, now)
    // Bound the dedup map by evicting EXPIRED entries — NOT clearing everything.
    // A >100-distinct-message storm (messages embedding a counter/timestamp) would
    // otherwise reset the whole window and re-admit everything each cycle. Main
    // also rate-limits server-side, so this is defense-in-depth.
    if (recent.size > 200) {
      for (const [k, ts] of recent) if (now - ts >= WINDOW_MS) recent.delete(k)
    }
    window.api?.reportIncident?.({
      kind,
      message: message.slice(0, 200),
      source: extra.source,
      line: extra.line,
      column: extra.column,
      stack: extra.stack?.split('\n').slice(0, 6).join('\n'),
    })
  }
  window.addEventListener('error', (evt) => {
    send('renderer.error', evt.message || String(evt.error), {
      source: evt.filename,
      line: evt.lineno,
      column: evt.colno,
      stack: evt.error?.stack,
    })
  })
  window.addEventListener('unhandledrejection', (evt) => {
    const reason = evt.reason
    send(
      'renderer.unhandledrejection',
      reason instanceof Error ? reason.message : String(reason),
      { stack: reason instanceof Error ? reason.stack : undefined },
    )
  })
}

// This starts before React mounts so a freeze in initial rendering has the same terminal evidence
// as a later feed/workflow freeze. It is independent of optional performance recording.
startRendererFreezeHeartbeat()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The desktop's feed-selection point (see the remote-mobile-companion
        spec's isolation section): this is the ONE place where "desktop =
        IPC transport" is decided. The remote client's entry point mounts
        the same provider with its WebSocket feed; nothing below the
        provider knows which transport it is on. */}
    <WorkflowClientProvider value={ipcWorkflowClient}>
      <SessionFeedProvider value={ipcSessionFeed}>
        <GlobalToastProvider>
          {/* INSIDE AppErrorBoundary, not wrapped around it. The previous
              placement put the loader OUTSIDE the boundary while its comment
              claimed the opposite, so a throw during its render would have
              blanked the whole app instead of being caught. It reads the store
              and runs one IPC effect, so there is nothing it needs from being
              higher in the tree. */}
          <AppErrorBoundary>
            <InstalledExtensionsLoader>
              <App />
            </InstalledExtensionsLoader>
          </AppErrorBoundary>
        </GlobalToastProvider>
      </SessionFeedProvider>
    </WorkflowClientProvider>
  </React.StrictMode>
)
