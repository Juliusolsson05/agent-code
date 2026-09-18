// One set of formatters for every monitor surface, so a tile, a tooltip and a
// table row never print the same quantity two ways.

// WHY decimal labels (GB) on binary divisions (1024^n): this matches what
// macOS Activity Monitor and Windows Task Manager print for RSS — users
// cross-check our numbers against those tools, and a GiB figure that differs
// from Activity Monitor's GB by 7% reads as a bug to them.
export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(abs >= 10 * 1024 ** 3 ? 1 : 2)} GB`
  if (abs >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(abs >= 100 * 1024 ** 2 ? 0 : 1)} MB`
  if (abs >= 1024) return `${Math.round(value / 1024)} KB`
  return `${Math.round(value)} B`
}

/** CPU is percent of ONE core, so a busy process can exceed 100%. */
export function formatCpu(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(value >= 100 ? 0 : 1)}%`
}

export function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 10_000) return `${(value / 1000).toFixed(0)} s`
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`
  return `${value.toFixed(value >= 10 ? 0 : 1)} ms`
}

/** Signed change, with a deliberate dead band: RSS jitters by a few MB every
 * sample, and a wall of "+2 MB" arrows would drown the one agent really
 * growing. */
export function formatByteDelta(value: number | null): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (value === null || !Number.isFinite(value)) return { text: '—', tone: 'flat' }
  if (Math.abs(value) < 16 * 1024 ** 2) return { text: '±0', tone: 'flat' }
  return { text: `${value > 0 ? '+' : '−'}${formatBytes(Math.abs(value))}`, tone: value > 0 ? 'up' : 'down' }
}

export function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}
