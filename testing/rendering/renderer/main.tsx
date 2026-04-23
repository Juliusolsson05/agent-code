import React from 'react'
import { createRoot } from 'react-dom/client'

import { GlobalToastProvider } from '@renderer/GlobalToast'
import { RenderingHarnessApp } from './RenderingHarnessApp'

import '@renderer/styles.css'
import 'highlight.js/styles/github-dark.css'
import 'monaco-editor/min/vs/editor/editor.main.css'
import '@xterm/xterm/css/xterm.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalToastProvider>
      <RenderingHarnessApp />
    </GlobalToastProvider>
  </React.StrictMode>,
)
