import React from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './ui/App'
import './styles.css'

// Phone client entry point. Served by RemoteServer (src/main/remote/
// RemoteServer.ts serveClient) from the bundle `npm run client:build`
// produces. No SessionFeedProvider here: the phone UI takes the feed as an
// explicit prop because it also consumes client-only surfaces (session
// list, connection state, pty replies) that the shared contract
// deliberately does not carry. When the desktop's semantic feed components
// are mounted on the phone (next slice), THAT subtree gets the provider.

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
