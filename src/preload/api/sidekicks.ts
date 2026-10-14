import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import { SIDEKICK_CHANNELS } from '@shared/sidekicks/types.js'
import type {
  SidekickAttachResult,
  SidekickId,
  SidekickIndexView,
  SidekickRegisterRequest,
  SidekickReleasedEvent,
  SidekickSaveRequest,
  SidekickWriteResult,
} from '@shared/sidekicks/types.js'

// Preload bridge for Sidekicks (#1493). Main derives the requesting window
// from the sender for every call; nothing here can name another window.
//
// WHY plain `subscribe`, not `subscribeShared`: each channel has exactly one
// listener per window (the always-mounted SidekickPanelSurface), never one
// per pane, so the listener-count problem subscribeShared solves cannot occur.
export const sidekickApi = {
  listSidekicks: (): Promise<SidekickIndexView> => ipcRenderer.invoke(SIDEKICK_CHANNELS.list),
  registerSidekick: (request: SidekickRegisterRequest): Promise<SidekickWriteResult> =>
    ipcRenderer.invoke(SIDEKICK_CHANNELS.register, request),
  saveSidekick: (request: SidekickSaveRequest): Promise<SidekickWriteResult> =>
    ipcRenderer.invoke(SIDEKICK_CHANNELS.save, request),
  attachSidekick: (id: SidekickId): Promise<SidekickAttachResult> => ipcRenderer.invoke(SIDEKICK_CHANNELS.attach, id),
  takeSidekick: (id: SidekickId): Promise<SidekickAttachResult> => ipcRenderer.invoke(SIDEKICK_CHANNELS.take, id),
  removeSidekick: (id: SidekickId, caller?: 'sidekick.remove' | 'sidekick.register-failed'): Promise<SidekickWriteResult> =>
    ipcRenderer.invoke(SIDEKICK_CHANNELS.remove, id, caller),
  onSidekicksChanged: (cb: (view: SidekickIndexView) => void): Unsub => subscribe(SIDEKICK_CHANNELS.changed, cb),
  onSidekickReleased: (cb: (event: SidekickReleasedEvent) => void): Unsub => subscribe(SIDEKICK_CHANNELS.released, cb),
}
