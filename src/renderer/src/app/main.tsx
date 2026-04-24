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

void initializePerformance().then(() => {
  mark('app.renderer.reactRenderCalled')
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalToastProvider>
      <App />
    </GlobalToastProvider>
  </React.StrictMode>
)
