import { contextBridge, ipcRenderer } from 'electron'
import type { RuntimeApiRequest, RuntimeEvent, RuntimeInvocation } from '@shared/types/extensionRuntime.js'
import { isExtensionJson } from '@shared/types/extensionJson.js'

// This closure runs in the isolated preload world, so extension JavaScript
// cannot replace its counter or bypass the check with a direct ipcRenderer call.
// Reject oversized data BEFORE the renderer-to-main IPC clone and limit queued
// messages here; main repeats both checks as its own authority boundary.
let credits = 128
let creditedAt = performance.now()
function admit(message: unknown): void {
  const now = performance.now()
  credits = Math.min(128, credits + (now - creditedAt) * 0.128)
  creditedAt = now
  if (credits < 1) throw new Error('Extension runtime message rate exceeded.')
  credits -= 1
  if (!isExtensionJson(message)) throw new Error('Extension runtime message exceeds the JSON limits.')
}

// This preload is exclusively for a managed extension runtime. Never import the
// application preload here: its filesystem/session/management channels would turn
// a sandboxed extension into an application renderer with unrestricted authority.
contextBridge.exposeInMainWorld('agentCodeRuntimeTransport', {
  request: async (request: RuntimeApiRequest) => { admit(request); return ipcRenderer.invoke('extensions:runtime-api', request) },
  send: (event: RuntimeEvent) => { admit(event); ipcRenderer.send('extensions:runtime-event', event) },
  subscribe: (listener: (message: RuntimeInvocation) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RuntimeInvocation) => listener(message)
    ipcRenderer.on('extensions:runtime-invoke', handler)
    return () => ipcRenderer.removeListener('extensions:runtime-invoke', handler)
  },
})
