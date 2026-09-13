import { OperationTimers } from '@shared/performance/operationTimers.js'
import type { MonitorOperation } from '@shared/performance/monitorContracts.js'

let sink: (record: MonitorOperation) => void = () => {}
export function setMainOperationSink(next: typeof sink): void { sink = next }

export const mainOperations = new OperationTimers(record => sink(record))
// Reuse the collector's existing tick. Importing instrumentation in a module
// or a test must not allocate another native probe or keep the process awake.
export async function measureMainOperation<T>(name: Parameters<OperationTimers['begin']>[0], work: () => Promise<T>, sessionId?: string): Promise<T> {
  const end = mainOperations.begin(name, sessionId)
  try { const result = await work(); end(); return result }
  catch (error) { end('error'); throw error }
}
