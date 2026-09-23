import { ipcMain, webContents } from 'electron'

import { attachGuestContextMenu, showPocketMenu } from '@main/browserPocket/nativeMenus.js'
import { attachGuestInput } from '@main/browserPocket/guestPolicies.js'
import { mayRegisterGuest } from '@main/browserPocket/guestRegistration.js'
import { clearPocketStorage, configurePocketSession, partitionFor } from '@main/browserPocket/partition.js'
import type { PocketFlags, PocketPickResult, PortWatchSession, PocketMenuState } from '@shared/browserPocket/types.js'

/**
 * What the IPC layer needs from the controller (src/main/browserPocket/
 * controller). An interface, not the class, so this module stays a thin
 * transport: every decision lives behind it and is tested there.
 */
export type BrowserPocketIpcDeps = {
  register(pocketId: string, sessionId: string, guest: Electron.WebContents): void
  unregister(pocketId: string): Promise<void>
  noteHumanInput(pocketId: string, at?: { x: number; y: number }): void
  agentTyping(pocketId: string): boolean
  takeOver(pocketId: string): void
  resume(pocketId: string): void
  setFlags(flags: PocketFlags): void
  thumbnail(pocketId: string): Promise<string | null>
  pick(pocketId: string): Promise<PocketPickResult | null>
  cancelPick(pocketId: string): void
  applyEmulation(pocketId: string, emulation: { viewport?: { width: number; height: number; mobile: boolean } | null; colorScheme?: 'light' | 'dark' | null; zoom?: number }): Promise<void>
  setWatchedSessions(sessions: PortWatchSession[]): void
}

export function registerBrowserPocketIpc(deps: BrowserPocketIpcDeps): void {
  ipcMain.handle('browser-pocket:menu', (event, state: PocketMenuState) => showPocketMenu(event.sender, state))
  ipcMain.handle('browser-pocket:partition', (_event, p: { pocketId: string; profile: 'lane' | 'project'; projectId?: string }) => {
    const partition = partitionFor(p, p.projectId)
    // Configure BEFORE returning: the renderer only sets the <webview>'s
    // partition attribute after this resolves, so the permission and
    // certificate handlers exist before the guest's first request.
    configurePocketSession(partition)
    return partition
  })

  ipcMain.handle('browser-pocket:register-guest', (event, p: { pocketId: string; sessionId: string; webContentsId: number }) => {
    const guest = webContents.fromId(p.webContentsId)
    if (!mayRegisterGuest(guest, event.sender.id)) return { ok: false }
    const sender = event.sender
    // Policies are attached once per guest webContents; a remap only re-keys.
    if (!guestsWithPolicies.has(guest!.id)) {
      guestsWithPolicies.add(guest!.id)
      guest!.once('destroyed', () => guestsWithPolicies.delete(guest!.id))
      // Navigation/popup security is attached at did-attach-webview by the
      // window guard; this adds only the pocket-aware input handling.
      attachGuestContextMenu(guest!)
      attachGuestInput(guest!, {
        forwardChord: key => { if (!sender.isDestroyed()) sender.send('browser-pocket:chord', key) },
        localAction: action => { if (!sender.isDestroyed()) sender.send('browser-pocket:local-action', { pocketId: p.pocketId, action }) },
        onHumanInput: at => deps.noteHumanInput(p.pocketId, at),
        agentTyping: () => deps.agentTyping(p.pocketId),
      })
    }
    deps.register(p.pocketId, p.sessionId, guest!)
    return { ok: true }
  })

  ipcMain.handle('browser-pocket:unregister-guest', (_event, p: { pocketId: string }) => deps.unregister(p.pocketId))
  ipcMain.handle('browser-pocket:set-flags', (_event, flags: PocketFlags) => deps.setFlags({ enabled: flags.enabled === true, allowEvaluate: flags.allowEvaluate === true }))
  ipcMain.handle('browser-pocket:take-over', (_event, p: { pocketId: string }) => deps.takeOver(p.pocketId))
  ipcMain.handle('browser-pocket:resume', (_event, p: { pocketId: string }) => deps.resume(p.pocketId))
  ipcMain.handle('browser-pocket:thumbnail', (_event, p: { pocketId: string }) => deps.thumbnail(p.pocketId))
  ipcMain.handle('browser-pocket:pick', (_event, p: { pocketId: string }) => deps.pick(p.pocketId))
  ipcMain.handle('browser-pocket:cancel-pick', (_event, p: { pocketId: string }) => deps.cancelPick(p.pocketId))
  ipcMain.handle('browser-pocket:emulation', (_event, p: { pocketId: string; emulation: Parameters<BrowserPocketIpcDeps['applyEmulation']>[1] }) => deps.applyEmulation(p.pocketId, p.emulation))
  // One watcher serves the whole app, but every window submits the plan for
  // ITS OWN workspace. Replacing the watcher's plan with whichever window
  // spoke last meant an empty second window cleared the first window's port
  // chips, and because unchanged plans are not resubmitted nothing ever
  // repaired it (review round 2, A #7). Keep one plan per window, scan their
  // union, and drop a window's plan when it closes.
  const plansBySender = new Map<number, PortWatchSession[]>()
  const applyPlans = () => deps.setWatchedSessions(mergeWatchPlans(plansBySender.values()))
  ipcMain.handle('browser-pocket:set-watch', (event, p: { sessions: PortWatchSession[] }) => {
    const sender = event.sender
    if (!plansBySender.has(sender.id)) {
      const id = sender.id
      sender.once('destroyed', () => { plansBySender.delete(id); applyPlans() })
    }
    plansBySender.set(sender.id, Array.isArray(p.sessions) ? p.sessions : [])
    applyPlans()
  })
  ipcMain.handle('browser-pocket:clear-storage', (_event, p: { pocketId: string; profile: 'lane' | 'project'; projectId?: string }) =>
    clearPocketStorage(partitionFor(p, p.projectId)))
}

const guestsWithPolicies = new Set<number>()

/** Union of every window's watch plan. A session can only be shown in one
 * window at a time, but a stale plan from a window mid-handoff may still list
 * it; the first entry wins so one session is never scanned twice. */
export function mergeWatchPlans(plans: Iterable<PortWatchSession[]>): PortWatchSession[] {
  const seen = new Set<string>()
  const merged: PortWatchSession[] = []
  for (const plan of plans) {
    for (const session of plan) {
      if (seen.has(session.sessionId)) continue
      seen.add(session.sessionId)
      merged.push(session)
    }
  }
  return merged
}
