// Guest lifecycle policies (decomposition Stage 4): when a hidden guest is put
// to sleep, and how a crashed guest is brought back.

/**
 * Pockets whose guests should be destroyed now.
 *
 * WHY destroy instead of freezing: CDP's Page.setWebLifecycleState "frozen"
 * stops timers but does not release GPU surfaces; Orca measured ~4 GB of GPU
 * process memory at 10 painting hidden tabs (#19116). Sleep = drop the guest,
 * keep `pocket.url`, recreate on next visibility.
 *
 * Never slept: a visible pocket, or one an agent is using (`agentLease`) — an
 * agent's next browser_* call must not find its page gone.
 */
export function pocketsToSleep(
  pockets: Array<{ pocketId: string; lastVisibleAt: number; visible: boolean; agentLease: boolean }>,
  now: number,
  opts: { idleMs?: number; maxLive?: number } = {},
): string[] {
  // 10 minutes hidden: long enough that switching between a few agents never
  // reloads a page, short enough that a forgotten pocket stops costing memory.
  const idle = opts.idleMs ?? 10 * 60_000
  // Six live guests: the grid shows at most a handful of pockets at once;
  // beyond that the least-recently-seen hidden ones go first.
  const cap = opts.maxLive ?? 6
  const sleepable = pockets.filter(p => !p.visible && !p.agentLease)
  const out = new Set(sleepable.filter(p => now - p.lastVisibleAt > idle).map(p => p.pocketId))
  const stillLive = pockets.length - out.size
  if (stillLive > cap) {
    const lru = sleepable.filter(p => !out.has(p.pocketId)).sort((a, b) => a.lastVisibleAt - b.lastVisibleAt)
    for (const p of lru.slice(0, stillLive - cap)) out.add(p.pocketId)
  }
  return [...out]
}

/**
 * Delay before remounting a crashed guest, or null to stop and show "Page
 * crashed — Reload". 250 ms × 2ⁿ with at most three crashes in 30 s (T3 Code's
 * webviewCrashRecovery): a page that crashes on load would otherwise respawn a
 * renderer process in a tight loop.
 */
export function nextCrashDelay(crashTimes: number[], now: number): number | null {
  const recent = crashTimes.filter(t => now - t < 30_000)
  if (recent.length >= 3) return null
  return 250 * 2 ** recent.length
}
