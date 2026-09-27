import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type { CliUpdateBehavior, CliUpdateKind, CliUpdateSnapshot } from '@shared/types/cliUpdate.js'

// Preload bridge for the CLI auto-updater.
//
// Kept as its own module (rather than folded into systemApi) because the
// surface is distinct enough — a mutable setting, a state broadcast, and
// a file-open action — that grouping it under "window chrome" would be
// misleading. The IPC channel prefix mirrors this: everything is
// `cli-updates:*`.

export const cliUpdatesApi = {
  /** Fetch the current authoritative snapshot. Called once on mount from
   *  the renderer so the banner has state before the first push arrives. */
  cliUpdatesGet: (): Promise<CliUpdateSnapshot> =>
    ipcRenderer.invoke('cli-updates:get'),
  /** Force a fresh probe + potential update. Resolves with the new
   *  snapshot; the state channel also emits, so the store updates
   *  either way. */
  cliUpdatesRefresh: (): Promise<CliUpdateSnapshot> =>
    ipcRenderer.invoke('cli-updates:refresh'),
  /** Run a one-shot update for a single CLI, bypassing the behavior
   *  gate. Called from the notify-mode "Update now" button — the user
   *  asked for THIS update to run without turning on automatic mode
   *  permanently. Silent if the target isn't behind or a session is
   *  active. */
  cliUpdatesUpdateNow: (cli: CliUpdateKind): Promise<CliUpdateSnapshot> =>
    ipcRenderer.invoke('cli-updates:update-now', cli),
  /** Persist the user's automatic/notify/off preference. Resolves with
   *  the new snapshot so the setting page can render without waiting
   *  for the state push. */
  cliUpdatesSetBehavior: (behavior: CliUpdateBehavior): Promise<CliUpdateSnapshot> =>
    ipcRenderer.invoke('cli-updates:set-behavior', behavior),
  /** Open this CLI's current failure log in the OS default handler. Main
   *  picks the path from its own failed state (#1423 review a: a
   *  renderer-supplied path could open anything). `false` when it did not
   *  open; the caller says so in its own words (#1250 row 10). */
  cliUpdatesOpenLog: (cli: CliUpdateKind): Promise<boolean> =>
    ipcRenderer.invoke('cli-updates:open-log', cli),
  /** Subscribe to state changes. Returns an Unsub. The subscriber gets
   *  every transition — updating→updated, updating→failed, notify
   *  transitions on manual refresh, and behavior changes. */
  onCliUpdatesState: (cb: (snapshot: CliUpdateSnapshot) => void): Unsub =>
    subscribe('cli-updates:state', cb),
}
