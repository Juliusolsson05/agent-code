import type { MonitorOperationName } from './monitorPolicy.js'

export const INCIDENT_RULES = ['main-stall', 'renderer-stall', 'renderer-long-tasks', 'memory-pressure', 'slow-operation', 'monitoring-loss'] as const
export type MonitorIncidentRule = typeof INCIDENT_RULES[number]
export type MonitorEvidencePoint = {
  at: number; kind: 'main' | 'window'; scope: number; value: number | null
  cpuPercent: number | null; heapRatio: number | null; longTaskMs: number | null; sleepGap: boolean
}
export type MonitorIncidentSummary = {
  id: number; ruleVersion: 1; rule: MonitorIncidentRule; at: number; scope: number
  severity: 'warning' | 'error'; observed: number; threshold: number
  operation?: MonitorOperationName
  state: 'capturing' | 'complete' | 'interrupted'; truncated: boolean; evidenceCount: number
}
export type MonitorIncident = MonitorIncidentSummary & { evidence: MonitorEvidencePoint[] }
export const INCIDENT_EXPLANATIONS: Record<MonitorIncidentRule, string> = {
  'main-stall': 'The main event loop exceeded its delay threshold. Nearby operations may be related; this evidence does not identify the blocking stack.',
  'renderer-stall': 'A visible window reported a long scheduler delay or missed heartbeats while main remained responsive. Rendering, JavaScript, or IPC delivery may be involved.',
  'renderer-long-tasks': 'A visible window repeatedly spent substantial time in long tasks. This can delay input and painting; task attribution was not collected.',
  'memory-pressure': 'The main JavaScript heap remained above 70% of its limit across three memory intervals. This is pressure evidence, not proof of a leak or a predicted crash.',
  'slow-operation': 'A measured operation exceeded its specific threshold. Elapsed time can include scheduling and I/O; it is not CPU time.',
  'monitoring-loss': 'The monitoring pipeline dropped records. Charts and incident context may have gaps; absence of evidence does not establish healthy application behavior.',
}
