import { randomBytes } from 'node:crypto'

export function createAppRunId(now = new Date(), pid = process.pid): string {
  const safeStamp = now.toISOString().replace(/[:.]/g, '-')
  const suffix = randomBytes(3).toString('hex')
  return `${safeStamp}-main-${pid}-${suffix}`
}

// Incident ids only need to be unique WITHIN one app run (they're already
// scoped by appRunId on disk), so a timestamp + short random suffix is enough.
export function createIncidentId(now = new Date()): string {
  const safeStamp = now.toISOString().replace(/[:.]/g, '-')
  const suffix = randomBytes(3).toString('hex')
  return `${safeStamp}-${suffix}`
}
