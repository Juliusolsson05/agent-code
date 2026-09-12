import type { SessionKind } from '../types/providerKind.js'

export type MonitorProcessTarget = {
  sessionId: string; kind: SessionKind; pid: number | null; exited: boolean; lastActivityAt: number | null
}
export type MonitorElectronProcess = {
  pid: number; creationTime: number; type: 'main' | 'renderer' | 'gpu' | 'utility' | 'other'
  cpuPercent: number | null; memoryBytes: number | null
}
export type MonitorProcessContext = {
  generation: number; rootPid: number; sampledAt: number; truncated?: boolean
  targets: MonitorProcessTarget[]; electron: MonitorElectronProcess[]
}
export type MonitorProcessRow = {
  identity: string; pid: number | null; parentPid: number | null; creationTime: number
  type: MonitorElectronProcess['type'] | 'agent' | 'terminal' | 'child'
  provider?: SessionKind
  sessionIds: string[]; sharedSessionCount: number
  cpuPercent: number | null; memoryBytes: number | null
  quality: 'ok' | 'warming-up' | 'partial' | 'unsupported'
}
export type MonitorProcessSummary = {
  sampledAt: number; count: number; cpuPercent: number | null; memoryBytes: number | null
  quality: 'ok' | 'warming-up' | 'partial' | 'unsupported' | 'stale'
  sessionCount: number; missingRoots: number; truncated: boolean
}
export type MonitorProcessPage = { summary: MonitorProcessSummary; rows: MonitorProcessRow[]; total: number }
export type MonitorProcessChunk = {
  generation: number; offset: number; complete: boolean; rows: MonitorProcessRow[]; summary: MonitorProcessSummary
}
