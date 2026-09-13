/**
 * ps is asked for numeric resource fields and start time only. Do not add
 * command/args/environment columns: this table crosses the automatic history
 * boundary and must never become a second copy of prompts or project paths.
 * LC_ALL=C fixes the month/day tokens across localized macOS/Linux hosts.
 */
export type NativeProcessStat = { pid: number; parentPid: number; creationTime: number; cpuMs: number | null; rss: number | null }
const rowPattern = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(\S+)\s+(\d+))?\s*$/

export function parseCpuTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value)
  if (!match) return null
  const total = (Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000
  return Number.isFinite(total) && total >= 0 ? total : null
}

export function parseNativeProcessTable(text: string, limit = 20000): NativeProcessStat[] {
  const rows: NativeProcessStat[] = []
  for (const line of text.split('\n')) {
    if (rows.length >= limit) break
    const match = rowPattern.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const creationTime = Date.parse(match[3])
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || !Number.isFinite(creationTime)) continue
    rows.push({ pid, parentPid, creationTime, cpuMs: match[4] ? parseCpuTime(match[4]) : null, rss: match[5] ? Number(match[5]) * 1024 : null })
  }
  return rows
}
