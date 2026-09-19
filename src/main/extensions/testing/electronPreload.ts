import { contextBridge } from 'electron'
import { extensionsApi } from '@preload/api/extensions.js'

// Expose the real host bridge, so the sandbox test proves the extension cannot
// reach a preload that actually exists on its parent (not an empty dummy window).
contextBridge.exposeInMainWorld('api', extensionsApi)
