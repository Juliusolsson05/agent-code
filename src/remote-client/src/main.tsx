import React from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './ui/App'
// The desktop's full style system: Tailwind tokens + the feed's visual
// rules. Imported FIRST so the phone shell css below can override shell-
// specific bits; the feed itself renders with desktop-identical classes.
import '@renderer/styles.css'
import 'highlight.js/styles/github-dark.css'
import { applyTheme } from '@renderer/app-state/settings/theme'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import './styles.css'

// Theme tokens live on <html data-mode> + an inline accent property —
// exactly how the desktop boots its theme. Defaults for v1; a settings
// surface on the phone can come later.
applyTheme(DEFAULT_SETTINGS)

// Phone client entry point. Served by RemoteServer (src/main/remote/
// RemoteServer.ts serveClient) from the bundle `npm run client:build`
// produces. SessionFeedProvider is mounted by SessionView around the feed
// subtree (desktop rows resolve session I/O through useSessionFeed); the
// shell keeps the feed as an explicit prop for its client-only surfaces
// (session list, connection state, pty replies).

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
