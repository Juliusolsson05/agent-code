import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '@renderer/app/App'
import { GlobalToastProvider } from '@renderer/ui/GlobalToast'
import '@renderer/styles.css'
import 'highlight.js/styles/github-dark.css'
import 'monaco-editor/min/vs/editor/editor.main.css'
// xterm.js base CSS — required for the TerminalLeaf component to render
// its cells with correct geometry. xterm.js uses absolute-positioned
// rows and explicit cell widths, none of which work without this file.
import '@xterm/xterm/css/xterm.css'
import { initializePerformance, mark } from '@renderer/performance/client'
import { AppErrorBoundary } from '@renderer/app/AppErrorBoundary'

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
    if (recent.size > 100) recent.clear() // bound the dedup map
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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalToastProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </GlobalToastProvider>
  </React.StrictMode>
)
