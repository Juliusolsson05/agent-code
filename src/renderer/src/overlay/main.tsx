import React from 'react'
import { createRoot } from 'react-dom/client'

// styles.css first, overlay.css second — overlay.css overrides the opaque
// html/body backgrounds for the transparent window (see its header comment).
import '@renderer/styles.css'
import './overlay.css'
import { OverlayApp } from '@renderer/overlay/OverlayApp'

// Deliberately minimal compared to app/main.tsx: no performance client, no
// incident breadcrumb bridge, no feed/toast providers. The overlay is a
// dumb status display fed by one IPC channel; wiring the main window's
// startup machinery into it would double-report incidents (both windows
// share the main-process journal) for zero diagnostic value.

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
)
