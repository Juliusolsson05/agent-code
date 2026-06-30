import { randomBytes } from 'node:crypto'

export function createAppRunId(now = new Date(), pid = process.pid): string {
  const safeStamp = now.toISOString().replace(/[:.]/g, '-')
  const suffix = randomBytes(3).toString('hex')
  return `${safeStamp}-main-${pid}-${suffix}`
}

// The canonical, process-wide app run identity.
//
// WHY a singleton: the whole thesis of the journal is "stop manually matching
// timestamps between subsystems." That only works if every diagnostic — the
// incident journal, the performance run, (later) heap snapshots and debug
// bundles — stamps the SAME id. So the id is minted exactly once, lazily, the
// first time anything asks, and cached for the life of the process. Whichever
// subsystem starts first mints it (AppRunJournal in normal runs; PerformanceService
// at module load when AGENT_CODE_PERF is on); everyone else gets the same value.
// This replaces the previous state where the journal and PerformanceService each
// minted their own unrelated run id — the single biggest correlation gap.
let canonicalAppRunId: string | null = null

export function getAppRunId(): string {
  if (canonicalAppRunId === null) {
    canonicalAppRunId = createAppRunId()
  }
  return canonicalAppRunId
}

// Incident ids only need to be unique WITHIN one app run (they're already
// scoped by appRunId on disk), so a timestamp + short random suffix is enough.
export function createIncidentId(now = new Date()): string {
  const safeStamp = now.toISOString().replace(/[:.]/g, '-')
  const suffix = randomBytes(3).toString('hex')
  return `${safeStamp}-${suffix}`
}
