import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import 'highlight.js/styles/github-dark.css'
import 'monaco-editor/min/vs/editor/editor.main.css'
// xterm.js base CSS — required for the TerminalLeaf component to render
// its cells with correct geometry. xterm.js uses absolute-positioned
// rows and explicit cell widths, none of which work without this file.
import '@xterm/xterm/css/xterm.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
