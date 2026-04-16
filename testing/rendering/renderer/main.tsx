import React from 'react'
import { createRoot } from 'react-dom/client'

import { GlobalToastProvider } from '../../../src/renderer/src/GlobalToast'
import { RenderingHarnessApp } from './RenderingHarnessApp'

import '../../../src/renderer/src/styles.css'
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
