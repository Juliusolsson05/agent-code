import { ipcMain } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'

import { AgentNameRegistry } from '@main/agentNames/registry.js'
import { STATE_DIR } from '@main/storage/paths.js'
import { windowIdFor } from '@main/window/windowRegistry.js'

// WHY its own file next to workspace.json rather than a key inside it: the
// workspace file is a per-window opaque payload that main only moves bytes for,
// and it is rewritten wholesale on every autosave. Name allocation is
// application-wide, has a different writer and a different failure mode — a
// corrupt workspace costs a layout, a corrupt registry would cost every spoken
// address — so the two must not be able to take each other down.
export const AGENT_NAMES_FILE = join(STATE_DIR, 'agent-names.json')

// Bounded so a malformed or hostile renderer cannot make the allocator walk a
// huge list under the serialization tail. 10k is far past any real workspace.
const requestSchema = z.array(z.string().min(1).max(200)).max(10_000)

/**
 * The ONLY consumer of AgentNameRegistry.
 *
 * WHY the registry is a constructor default rather than a module singleton:
 * `registerAllIpc` runs exactly once per application process, so one instance
 * per call is already process-wide, and taking it as an argument is what makes
 * the sender guard testable without touching the real state directory.
 */
export function registerAgentNamesIpc(
  registry: AgentNameRegistry = new AgentNameRegistry(AGENT_NAMES_FILE),
): void {
  ipcMain.handle('agent-names:resolve', async (event, raw: unknown) => {
    // Two separate conditions on purpose: the first proves the WebContents is
    // one of our windows, the second proves the request came from the app's own
    // top-level document rather than an embedded frame it happens to host.
    if (!windowIdFor(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent names require a registered application window')
    }
    // De-duplicate before the registry so a repeated identity in one batch
    // cannot advance the counter twice.
    return registry.resolve([...new Set(requestSchema.parse(raw))])
  })
}
