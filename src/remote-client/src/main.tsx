import React from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './ui/App'
import { RendererHostProvider } from '@renderer/features/rendererHost/RendererHostContext'
import { PHONE_RENDERER_HOST } from './host/phoneRendererHost'
// The desktop's full style system: Tailwind tokens + the feed's visual
// rules. Imported FIRST so the phone shell css below can override shell-
// specific bits; the feed itself renders with desktop-identical classes.
import '@renderer/styles.css'
import 'highlight.js/styles/github-dark.css'
import { applyTheme } from '@renderer/app-state/settings/theme'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import { withPhoneSymbolFont } from './phoneSymbolFont'
import './styles.css'

// Theme tokens live on <html data-mode> + an inline accent property —
// exactly how the desktop boots its theme. Defaults for v1; a settings
// surface on the phone can come later.
applyTheme(DEFAULT_SETTINGS)
// The phone's symbol face goes in front of the app's font stack (#1194; see
// phoneSymbolFont.ts). applyTheme writes --theme-app-font inline on <html>,
// which every font rule on the page reads (the Tailwind `font-code` utility
// and this shell's own styles), so this one write reaches the feed rows too.
const rootStyle = document.documentElement.style
rootStyle.setProperty('--theme-app-font', withPhoneSymbolFont(rootStyle.getPropertyValue('--theme-app-font')))

// Phone client entry point. Served by RemoteServer (src/main/remote/
// RemoteServer.ts serveClient) from the bundle `npm run client:build`
// produces. SessionFeedProvider is mounted by SessionView around the feed
// subtree (desktop rows resolve session I/O through useSessionFeed); the
// shell keeps the feed as an explicit prop for its client-only surfaces
// (session list, connection state, pty replies).
//
// The RendererHost is mounted HERE, at the root, mirroring the desktop's
// app/main.tsx: it is the one place that decides what the shared rows may do
// on this device (#1177; see host/phoneRendererHost.ts).

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererHostProvider host={PHONE_RENDERER_HOST}>
      <App />
    </RendererHostProvider>
  </React.StrictMode>,
)
