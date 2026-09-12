import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import type { SessionManager } from '@main/sessionManager.js'
import type { SessionForwarderControl } from '@main/sessions/forwarder.js'
import { loadInitialHistoryChunk } from '@main/sessions/historyLoader.js'
import { isAgentProviderKind } from '@shared/types/providerKind.js'
import { aliasScreenSnapshotForWire } from '@shared/types/session.js'
import type { SessionRoutingScope, SessionRoutingResyncResult, SessionRoutingHistoryResult } from '@shared/types/sessionRouting.js'
import { acknowledgeSessionRoutingGap, captureSessionWindowLease, isSessionWindowLeaseAvailable, sendToSessionWindow, sessionRoutingGapsForWindow, windowIdFor } from '@main/window/windowRegistry.js'

/**
 * A display gap grants a read-only repair capability, never input authority.
 * Checking the gap's owner revision survives metadata expiry: eviction means
 * evidence is unavailable, not that the current owner may never refresh again.
 * Ack remains gap-versioned so an old repair cannot erase a newer incident.
 */
export function registerSessionRoutingIpc(manager: SessionManager, forwarder: SessionForwarderControl): void {
  ipcMain.handle('session:routing-gaps', evt => {
    const windowId = windowIdFor(evt.sender)
    return windowId ? sessionRoutingGapsForWindow(windowId) : []
  })
  const owner = (evt: IpcMainInvokeEvent, scope: SessionRoutingScope) => {
    if (!scope || typeof scope.sessionId !== 'string' || !Number.isSafeInteger(scope.ownershipRevision)) return null
    const lease = captureSessionWindowLease(scope.sessionId)
    return lease && lease.revision === scope.ownershipRevision &&
      lease.windowId === windowIdFor(evt.sender) && isSessionWindowLeaseAvailable(lease) ? lease : null
  }
  const source = (sessionId: string) => {
    const backend = manager.getBackendSnapshot(sessionId)
    const providerSessionId = manager.getNativeConversationId(sessionId)
    if (!backend?.sessionRunId || !isAgentProviderKind(backend.kind) || !providerSessionId) return null
    const reference = { kind: backend.kind, cwd: backend.cwd, providerSessionId }
    // Capture all source evidence available in today's manager. This fences
    // runtime replacement and observed native selection/locator changes; it is
    // NOT a claim that an unobserved /clear or an in-place transcript rewrite
    // has an epoch already. B12 adds that native source-generation contract.
    const sourceKey = createHash('sha256').update(JSON.stringify([
      backend.sessionRunId, reference, manager.getTranscriptFile(sessionId),
    ])).digest('hex')
    return { ...reference, sourceKey }
  }

  ipcMain.handle('session:resync-routing', (evt, scope: SessionRoutingScope): SessionRoutingResyncResult => {
    const lease = owner(evt, scope)
    if (!lease) return { kind: 'stale' }
    // Main flushes existing observations, captures current values, and sends
    // seeds on the SAME event transport in one synchronous turn. Returning
    // screen state over invoke would let a delayed reply overwrite a newer
    // live frame. Seeding never manufactures a started/exit/turn-completed edge.
    forwarder.flushSession(scope.sessionId)
    if (!owner(evt, scope)) return { kind: 'stale' }
    const backend = manager.getBackendSnapshot(scope.sessionId)
    const screen = manager.getScreenSnapshot(scope.sessionId)
    const conditions = manager.getConditionsSnapshot(scope.sessionId)
    const process = manager.getProcessStateSnapshot(scope.sessionId)
    if (!backend && !screen && !conditions && !process) return { kind: 'unavailable' }
    const seeds: Array<[string, unknown]> = []
    if (backend) seeds.push(['session:input-readiness', { sessionId: scope.sessionId, input: backend.input }])
    if (screen) seeds.push(['session:screen', aliasScreenSnapshotForWire({ sessionId: scope.sessionId, ...screen })])
    if (conditions) seeds.push(['session:conditions', { sessionId: scope.sessionId, snapshot: conditions }])
    if (process) seeds.push(['session:process-state', { sessionId: scope.sessionId, ...process }])
    for (const [channel, payload] of seeds) {
      if (sendToSessionWindow(scope.sessionId, channel, payload) !== 'delivered') return { kind: 'unavailable' }
    }
    acknowledgeSessionRoutingGap(lease, scope.gapRevision)
    return { kind: 'seeded', sessionRunId: backend?.sessionRunId ?? null, history: source(scope.sessionId) }
  })

  // One admitted history read per pane and at most four across the application.
  // A deadline would release the IPC waiter, not the filesystem/provider read;
  // retain admission until settlement so a slow source cannot spawn a storm.
  const pending = new Set<string>()
  ipcMain.handle('session:load-routing-history', async (
    evt, scope: SessionRoutingScope, sourceKey: string,
  ): Promise<SessionRoutingHistoryResult> => {
    const lease = owner(evt, scope)
    const captured = lease ? source(scope.sessionId) : null
    if (!lease || !captured || captured.sourceKey !== sourceKey) return { kind: 'stale' }
    if (pending.has(scope.sessionId) || pending.size >= 4) return { kind: 'unavailable' }
    pending.add(scope.sessionId)
    try {
      const chunk = await loadInitialHistoryChunk({ ...captured, limit: 120 })
      if (owner(evt, scope) !== lease || source(scope.sessionId)?.sourceKey !== sourceKey) return { kind: 'stale' }
      return { kind: 'loaded', chunk }
    } catch {
      // Native errors can contain paths/credentials. Preserve the gap and a
      // retryable read outcome without sending raw provider exception text.
      return { kind: 'unavailable' }
    } finally {
      pending.delete(scope.sessionId)
    }
  })
}
