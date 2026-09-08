import { ipcMain } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'

import {
  AGENT_NAME_IDENTITY_MAX_LENGTH,
  AGENT_NAME_IDENTITY_REQUEST_MAX,
} from '@shared/types/agentNames.js'
import { AgentNameRegistry } from '@main/agentNames/registry.js'
import { STATE_DIR } from '@main/storage/paths.js'
import { getBrowserWindow, windowIdFor } from '@main/window/windowRegistry.js'

// WHY its own file next to workspace.json rather than a key inside it: the
// workspace file is a per-window opaque payload that main only moves bytes for,
// and it is rewritten wholesale on every autosave. Name allocation is
// application-wide, has a different writer and a different failure mode — a
// corrupt workspace costs a layout, a corrupt registry would cost every spoken
// address — so the two must not be able to take each other down.
export const AGENT_NAMES_FILE = join(STATE_DIR, 'agent-names.json')

// Both bounds come from the shared contract, because the renderer's
// `identityOf` has to refuse exactly what this refuses — see
// shared/types/agentNames.ts for the batch-wide failure that drift caused.
const requestSchema = z
  .array(z.string().min(1).max(AGENT_NAME_IDENTITY_MAX_LENGTH))
  .max(AGENT_NAME_IDENTITY_REQUEST_MAX)

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
    // Three separate conditions on purpose, and deliberately the SAME three the
    // control host's `senderWindow` applies (createControlHost.ts:66-67), so the
    // two main-side entry points a renderer can reach cannot drift apart:
    //   1. the WebContents maps to one of our registered window IDs,
    //   2. that ID still has a live BrowserWindow, and
    //   3. the request came from the app's own top-level document rather than an
    //      embedded frame it happens to host.
    //
    // WHY (2) is not redundant with (1): `windowIdFor` deliberately keeps
    // answering for a closed window — it falls back to `retiredWebContentsIds`
    // (windowRegistry.ts:429-435) so late messages from a departing renderer can
    // still be attributed — while `getBrowserWindow` returns null once the entry
    // is gone or the window is destroyed. Without (2), a queued invoke from a
    // window the user already closed would still allocate, and allocation is
    // monotonic: it would permanently spend a spoken address on nothing.
    const windowId = windowIdFor(event.sender)
    if (!windowId || !getBrowserWindow(windowId) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent names require a registered application window')
    }
    // De-duplicate before the registry so a repeated identity in one batch
    // cannot advance the counter twice.
    return registry.resolve([...new Set(requestSchema.parse(raw))])
  })
}
