import type { LanePort, PortWatchSession } from '@shared/browserPocket/types.js'

import { attributePorts, classifyProbe, type Listener, type ProbeResult, type SessionRoot } from './core/lanePorts.js'

/**
 * Finds each watched lane's dev servers (decomposition Stage 7, isolated hard
 * part #3). All platform I/O is injected so the tests replay Stage-1
 * recordings instead of touching this machine; the reconciliation itself is
 * core/lanePorts.ts.
 *
 * Cost rules (spec §7.3):
 * - Nothing to watch ⇒ no timer, no process spawned. The renderer sends an
 *   empty plan when the feature is off or no lane shows an agent.
 * - Only PIDs in the watched trees are passed to lsof, and only their
 *   listeners are probed — T3 Code's scanner probed every local listener and
 *   crashed other apps (#8407).
 * - Scans back off with their own cost: max(3 s, 20 × last scan) — VS Code's
 *   auto-forward formula — so a slow machine scans less, not more.
 * - A probe answer is cached per pid:port; a dev server is probed once.
 * - A listener is probed (and listed) only after the watcher has SEEN it
 *   listening for PROBE_SETTLE_MS; see that constant for why (#1409).
 */
export type LanePortWatcherDeps = {
  /** pid → parent pid for every process (`ps -axo pid=,ppid=`). */
  listProcesses(): Promise<Map<number, number>>
  /** Listening TCP sockets held by these pids. */
  listListeners(pids: number[]): Promise<Listener[]>
  /** tmux panes as [session name, pane pid]. */
  listTmuxPanes(): Promise<Array<[string, number]>>
  /** The provider process of an agent session, if alive. */
  agentPid(sessionId: string): number | null
  /** The shell of a direct-PTY terminal session, if alive. */
  terminalPid(sessionId: string): number | null
  probe(port: number): Promise<ProbeResult>
  broadcast(bySession: Record<string, LanePort[]>): void
  now(): number
  setTimer(fn: () => void, ms: number): () => void
}

export const SCAN_FLOOR_MS = 3000

/**
 * How long a listener must have been seen before the watcher sends it its one
 * `GET /` and shows it as a chip (#1409).
 *
 * WHY a settle window at all: agents run test suites inside their lanes, and
 * a suite's loopback server is in the lane's process tree like any dev
 * server. Probing on the first scan that saw it sent those servers an
 * unsolicited request. Tests that count requests then flaked, only on
 * developer machines, since CI has no watching app. #1187 was one: the probe
 * reached the extension runtime harness's egress server about 1.6 s after it
 * started. Every exposed server in #1409's inventory binds port 0 and lives
 * for one test or one harness run. Dev servers stay up. So "has it stayed up"
 * is the discriminator that needs no process names: `ps` reads PID/PPID
 * only, a privacy rule.
 *
 * WHY not the obvious alternatives (plan
 * docs/plans/2026-09-27-lane-port-probe-settle.md):
 * - Skipping ephemeral ports (≥ 49152) would hide the recorded tmux Python
 *   server (62679) and tools that fall back to a random free port.
 * - `HEAD` or another path still reaches test handlers.
 * - Listing an unsettled listener unprobed, as "other", would flash a chip for
 *   every test server.
 *
 * WHY 5 s (an UNCONFIRMED product call): it is about three times the 1.6 s
 * observed in #1187 and longer than a typical single test's server. A dev
 * server's chip still appears about 6–9 s after it starts, at the 3 s scan
 * floor. A counting test whose server outlives the window is still reachable;
 * those excuse exactly LANE_PORT_PROBE_USER_AGENT (lanePortsIo.ts).
 *
 * WHAT "listening for 5 s" means, and its limits (#1452 review A):
 * - The age starts when lsof RETURNED the listener (`observedAt`), not when
 *   the scan started. `ps` and `lsof` may each take up to 3 s under the load
 *   that #1409 is about. Timing from the scan start once let a listener that
 *   lsof reported 4.9 s into the scan get probed about 3 s after it was
 *   first seen. The same start-of-scan timestamp also aged a listener found
 *   by a scan that straddled a plan change.
 * - The age is only as continuous as our sampling. A server that closes and a
 *   new one that binds the same pid:port BETWEEN two scans look like one
 *   listener to `lsof`. Nothing short of watching sockets can tell them
 *   apart, so a fixed-port test server can still inherit a predecessor's age.
 *   When observation truly stops (an empty plan, stop()), the ages are
 *   dropped, so a gap of unbounded length never counts as "listening".
 * - A failed lsof (timeout, signal, missing binary) is an unknown, not an
 *   empty answer. It throws, and the scan keeps the last broadcast and the
 *   ages, instead of pruning a settled dev server and hiding its chip for
 *   another window (lanePortsIo.listListeners).
 * - Cost: a lane whose listeners keep churning (a test runner starting a new
 *   server every scan) keeps pulling the next scan in to the settle time, so
 *   the 20 x back-off does not grow for it. That is bounded (never below
 *   SCAN_FLOOR_MS) and only lasts while something is actually settling.
 */
export const PROBE_SETTLE_MS = 5000

export class LanePortWatcher {
  private sessions: PortWatchSession[] = []
  private cancel: (() => void) | null = null
  private inFlight: Promise<void> | null = null
  private lastScanMs = 0
  private probeCache = new Map<string, ProbeResult>()
  /** pid:port → the `now()` of the scan that first saw it listening. Pruned
   * with the probe cache, so a server that restarts on the same pid:port
   * settles again rather than inheriting its predecessor's age. */
  private firstSeen = new Map<string, number>()
  private lastBroadcast = ''
  private stopped = false
  /** Bumped by every setSessions. A scan that started under an older plan
   * must not broadcast: after the feature is turned off it would refill the
   * port cache with stale ports, and a new plan should get its own answer
   * immediately rather than one back-off later (review A #8). */
  private planGeneration = 0

  constructor(private readonly deps: LanePortWatcherDeps) {}

  setSessions(sessions: PortWatchSession[]): void {
    this.sessions = sessions
    this.planGeneration++
    this.cancel?.()
    this.cancel = null
    if (sessions.length === 0) {
      // Clear chips immediately rather than leaving the last scan on screen.
      this.emit({})
      // No scan runs while the plan is empty, so nothing is being observed.
      // Keeping the ages would let a listener that reappears after an
      // unwatched gap of any length count that gap as settled time, and would
      // reuse a probe answer from a server that may since have been replaced
      // (#1452 review A).
      this.forgetListeners()
      return
    }
    // A plan change (a lane now shows a different agent) deserves an answer
    // now, not after the back-off.
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    this.cancel?.()
    this.cancel = null
    this.forgetListeners()
  }

  private forgetListeners(): void {
    this.firstSeen.clear()
    this.probeCache.clear()
  }

  /** One scan. Exposed for tests; concurrent callers share the scan in flight. */
  scan(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runScan().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async runScan(): Promise<void> {
    if (this.stopped || this.sessions.length === 0) return
    const started = this.deps.now()
    const generation = this.planGeneration
    // The earliest moment an unsettled listener becomes probeable, so the next
    // scan can be pulled in to meet it (see the finally block).
    let nextSettleAt: number | null = null
    try {
      const [parentOf, panes] = await Promise.all([this.deps.listProcesses(), this.hasTmux() ? this.deps.listTmuxPanes() : Promise.resolve([])])
      const panesByName = new Map<string, number[]>()
      for (const [name, pid] of panes) panesByName.set(name, [...(panesByName.get(name) ?? []), pid])

      const roots: Record<string, SessionRoot[]> = {}
      for (const s of this.sessions) {
        const list: SessionRoot[] = []
        const agent = this.deps.agentPid(s.sessionId)
        if (agent) list.push({ pid: agent, countsOwnListeners: false })
        for (const name of s.tmuxNames) for (const pid of panesByName.get(name) ?? []) list.push({ pid, countsOwnListeners: true })
        for (const id of s.terminalSessionIds) {
          const pid = this.deps.terminalPid(id)
          if (pid) list.push({ pid, countsOwnListeners: true })
        }
        roots[s.sessionId] = list
      }

      // Only the watched trees' pids are handed to lsof.
      const pids = new Set<number>()
      const children = new Map<number, number[]>()
      for (const [pid, ppid] of parentOf) children.set(ppid, [...(children.get(ppid) ?? []), pid])
      const queue = Object.values(roots).flat().map(r => r.pid)
      for (let i = 0; i < queue.length; i++) {
        const pid = queue[i]!
        if (pids.has(pid)) continue
        pids.add(pid)
        queue.push(...(children.get(pid) ?? []))
      }
      const listeners = pids.size ? await this.deps.listListeners([...pids]) : []
      // When these listeners were actually observed; see PROBE_SETTLE_MS for
      // why this is not `started`.
      const observedAt = this.deps.now()
      // WHY a scan from an older plan writes NOTHING from here on (#1452
      // round-2 review A): setSessions([]) forgets every age and probe
      // answer, but a scan that was already waiting on lsof resumed after
      // that clear and wrote its listeners' ages back, dated before the
      // unwatched gap. A listener then counted the gap as settled time and was
      // probed on the first scan of the restored plan. So an obsolete scan
      // neither records ages, probes, caches nor prunes. Its only effect is
      // the immediate rescan the finally block schedules for the new plan.
      const current = () => generation === this.planGeneration
      if (!current()) return
      const attributed = attributePorts({ listeners, parentOf, roots })

      const out: Record<string, LanePort[]> = {}
      for (const [sessionId, ports] of Object.entries(attributed)) {
        const rows: LanePort[] = []
        for (const p of ports) {
          // Probes await, so the plan can change mid-loop too.
          if (!current()) return
          const key = `${p.pid}:${p.port}`
          const seenAt = this.firstSeen.get(key) ?? observedAt
          this.firstSeen.set(key, seenAt)
          if (observedAt - seenAt < PROBE_SETTLE_MS) {
            // Not contacted, not listed: a test server that is gone before it
            // settles never learns the watcher exists (#1409).
            const settleAt = seenAt + PROBE_SETTLE_MS
            nextSettleAt = nextSettleAt === null ? settleAt : Math.min(nextSettleAt, settleAt)
            continue
          }
          const kind = classifyProbe(await this.probeOnce(p.pid, p.port, current))
          if (kind === 'ignore') continue
          rows.push({ port: p.port, pid: p.pid, url: `http://localhost:${p.port}/`, kind })
        }
        rows.sort((a, b) => (a.kind === b.kind ? a.port - b.port : a.kind === 'html' ? -1 : 1))
        if (rows.length) out[sessionId] = rows
      }
      // Probe cache entries for listeners that are gone would otherwise pin
      // a restarted server's old answer to a reused port.
      if (!current()) return
      const live = new Set(listeners.map(l => `${l.pid}:${l.port}`))
      for (const key of this.probeCache.keys()) if (!live.has(key)) this.probeCache.delete(key)
      for (const key of this.firstSeen.keys()) if (!live.has(key)) this.firstSeen.delete(key)
      this.emit(out)
    } catch (error) {
      // Nothing is pruned or broadcast on failure: the chips and the ages
      // from the last good scan stand until a scan succeeds.
      console.warn('[browser-pocket] port scan failed:', error instanceof Error ? error.message : error)
    } finally {
      const ended = this.deps.now()
      this.lastScanMs = ended - started
      // A plan that changed during this scan is answered right away.
      const stale = generation !== this.planGeneration
      let next = Math.max(SCAN_FLOOR_MS, 20 * this.lastScanMs)
      // While a listener is waiting out the settle window, do not let a slow
      // machine's 20 x back-off push its chip out by up to a minute: rescan
      // when it settles. The floor still holds, so this never scans faster
      // than an idle watcher would.
      if (nextSettleAt !== null) next = Math.min(next, Math.max(SCAN_FLOOR_MS, nextSettleAt - ended))
      if (!this.stopped && this.sessions.length) this.schedule(stale ? 0 : next)
    }
  }

  private hasTmux(): boolean {
    return this.sessions.some(s => s.tmuxNames.length > 0)
  }

  private async probeOnce(pid: number, port: number, current: () => boolean): Promise<ProbeResult> {
    const key = `${pid}:${port}`
    const cached = this.probeCache.get(key)
    if (cached) return cached
    const result = await this.deps.probe(port).catch((): ProbeResult => ({ status: null, contentType: null }))
    // The plan may have been emptied (and the cache cleared) while the probe
    // was in flight; see `current` in runScan.
    if (current()) this.probeCache.set(key, result)
    return result
  }

  private emit(bySession: Record<string, LanePort[]>): void {
    // The renderer re-renders lane headers on every broadcast; send only changes.
    const key = JSON.stringify(bySession)
    if (key === this.lastBroadcast) return
    this.lastBroadcast = key
    this.deps.broadcast(bySession)
  }

  private schedule(ms: number): void {
    this.cancel?.()
    this.cancel = this.deps.setTimer(() => { this.cancel = null; void this.scan() }, ms)
  }
}
