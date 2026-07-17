import { startCodexProviderHost } from 'workflow-mcp'

// WHY this is an Electron main-process entry instead of using workflow-mcp's
// adjacent dist file: Agent Code compiles the submodule from source, so that
// package dist path is not a packaging contract. electron-vite emits this file
// beside index.js under a stable name that child_process.fork can address in
// preview and in app.asar. Each fork hosts exactly one attempt so terminating a
// stalled agent cannot kill healthy workflow siblings.
startCodexProviderHost()
