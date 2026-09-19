import type { MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'
import { useAgentIdentities } from '../agentIdentity'
import { useAgentUsage } from '../useAgentUsage'
import { HealthTiles } from './HealthTiles'
import { ResponsivenessCards, UsageCharts } from './ResourceCharts'
import { TopConsumers } from './TopConsumers'

/**
 * The monitor's first page, ordered by the questions people open it with:
 * totals (is the app heavy right now), where memory and CPU went over the last
 * fifteen minutes, which agent is responsible, and whether the UI is keeping up.
 *
 * WHY "Go to" closes the monitor only after navigation succeeds: a detached
 * agent is woken first and that can fail (its provider cannot start). Closing
 * first would drop the user back into the workspace with no agent focused and
 * no explanation; the workspace's own toast reports the failure instead.
 */
export function Overview({ snapshot, onClose }: { snapshot: MonitorSnapshot; onClose: () => void }) {
  const { usage, error } = useAgentUsage()
  const { identities, focusAgent } = useAgentIdentities()
  const openAgent = (sessionId: string) => {
    void focusAgent(sessionId).then(ok => { if (ok) onClose() }).catch(() => {})
  }
  return (
    <div className="flex flex-col gap-2">
      <HealthTiles snapshot={snapshot} usage={usage} identities={identities} />
      <UsageCharts snapshot={snapshot} usage={usage} />
      <TopConsumers usage={usage} identities={identities} onOpenAgent={openAgent} />
      <ResponsivenessCards snapshot={snapshot} />
      <p className="text-[10px] leading-4 text-muted">
        {error ? 'Agent readings delayed; showing the last sample. ' : ''}
        Memory is resident memory (RSS); pages shared between processes can be counted more than once. CPU coverage: {usage?.quality ?? snapshot.processes?.quality ?? 'warming-up'}.
        {snapshot.processes?.missingRoots ? ` ${snapshot.processes.missingRoots} agent processes could not be measured.` : ''} Monitor helper uses {Math.round(snapshot.workerRss / 1024 ** 2)} MB.
      </p>
    </div>
  )
}
