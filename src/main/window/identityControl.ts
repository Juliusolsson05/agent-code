import { app } from 'electron'
import { z } from 'zod'
import { defineCapability } from '@control-sdk'

export function applicationIdentityCapabilities() {
  return [defineCapability({ id: 'app.identity', title: 'Identify the running application for computer use', execution: 'main', effect: 'read',
    description: 'Identify THIS already-running Agent Code process: PID, exact executable, app bundle (macOS), application source/resources path and packaged/development identity. Attach computer use to this existing process; never guess another checkout or launch an Electron executable to find it. Pair app.windows stable IDs, bounds and app.observe project descriptions with the native window inventory. A bundle ID or generic Electron title alone cannot distinguish development checkouts.',
    input: z.object({}).strict(), output: z.object({ pid: z.number(), name: z.string(), version: z.string(), packaged: z.boolean(),
      executablePath: z.string(), applicationPath: z.string(), bundlePath: z.string().nullable(), platform: z.string() }),
    handler: () => {
      const executablePath = app.getPath('exe')
      const boundary = executablePath.lastIndexOf('.app/')
      return { pid: process.pid, name: app.getName(), version: app.getVersion(), packaged: app.isPackaged,
        executablePath, applicationPath: app.getAppPath(), bundlePath: process.platform === 'darwin' && boundary >= 0 ? executablePath.slice(0, boundary + 4) : null,
        platform: process.platform }
    },
  })]
}
