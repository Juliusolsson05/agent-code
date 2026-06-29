import { randomBytes } from 'node:crypto'

export function createAppRunId(now = new Date(), pid = process.pid): string {
  const safeStamp = now.toISOString().replace(/[:.]/g, '-')
  const suffix = randomBytes(3).toString('hex')
  return `${safeStamp}-main-${pid}-${suffix}`
}
