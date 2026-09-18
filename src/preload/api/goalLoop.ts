import { ipcRenderer } from 'electron'
import type { GoalLoopState } from '@shared/types/goalLoop.js'

export type GoalLoopControlRequest = {
  sessionId: string
  action: 'pause' | 'resume' | 'stop' | 'raise-cap'
  value?: number
}

export const goalLoopApi = {
  readGoalLoops: (sessionIds: string[]): Promise<Record<string, GoalLoopState>> =>
    ipcRenderer.invoke('goal-loop:read', sessionIds),
  controlGoalLoop: (request: GoalLoopControlRequest): Promise<GoalLoopState | null> =>
    ipcRenderer.invoke('goal-loop:control', request),
  onGoalLoopChanged: (listener: () => void): (() => void) => {
    const handler = () => listener()
    ipcRenderer.on('goal-loop:changed', handler)
    return () => { ipcRenderer.removeListener('goal-loop:changed', handler) }
  },
}
