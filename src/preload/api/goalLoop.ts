import { ipcRenderer } from 'electron'
import { subscribeShared } from '@preload/api/ipc.js'
import type { GoalLoopControlAction, GoalLoopState } from '@shared/types/goalLoop.js'

export type GoalLoopControlRequest = {
  sessionId: string
  action: GoalLoopControlAction
  value?: number
}

export const goalLoopApi = {
  readGoalLoops: (sessionIds: string[]): Promise<Record<string, GoalLoopState>> =>
    ipcRenderer.invoke('goal-loop:read', sessionIds),
  controlGoalLoop: (request: GoalLoopControlRequest): Promise<GoalLoopState | null> =>
    ipcRenderer.invoke('goal-loop:control', request),
  /** #1279: a replaced pane's loop follows it to the successor's id. */
  carryGoalLoop: (from: string, to: string): Promise<GoalLoopState | null> =>
    ipcRenderer.invoke('goal-loop:carry', { from, to }),
  // Shared (#1015): every mounted GoalLoopPane subscribes.
  onGoalLoopChanged: (listener: () => void): (() => void) =>
    subscribeShared('goal-loop:changed', () => listener()),
}
