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

export class LanePortWatcher {
  private sessions: PortWatchSession[] = []
  private cancel: (() => void) | null = null
  private inFlight: Promise<void> | null = null
  private lastScanMs = 0
  private probeCache = new Map<string, ProbeResult>()
  private lastBroadcast = ''
  private stopped = false

  constructor(private readonly deps: LanePortWatcherDeps) {}

  setSessions(sessions: PortWatchSession[]): void {
    this.sessions = sessions
    this.cancel?.()
    this.cancel = null
    if (sessions.length === 0) {
      // Clear chips immediately rather than leaving the last scan on screen.
      this.emit({})
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
      const attributed = attributePorts({ listeners, parentOf, roots })

      const out: Record<string, LanePort[]> = {}
      for (const [sessionId, ports] of Object.entries(attributed)) {
        const rows: LanePort[] = []
        for (const p of ports) {
          const kind = classifyProbe(await this.probeOnce(p.pid, p.port))
          if (kind === 'ignore') continue
          rows.push({ port: p.port, pid: p.pid, url: `http://localhost:${p.port}/`, kind })
        }
        rows.sort((a, b) => (a.kind === b.kind ? a.port - b.port : a.kind === 'html' ? -1 : 1))
        if (rows.length) out[sessionId] = rows
      }
      // Probe cache entries for listeners that are gone would otherwise pin
      // a restarted server's old answer to a reused port.
      const live = new Set(listeners.map(l => `${l.pid}:${l.port}`))
      for (const key of this.probeCache.keys()) if (!live.has(key)) this.probeCache.delete(key)
      this.emit(out)
    } catch (error) {
      console.warn('[browser-pocket] port scan failed:', error instanceof Error ? error.message : error)
    } finally {
      this.lastScanMs = this.deps.now() - started
      if (!this.stopped && this.sessions.length) this.schedule(Math.max(SCAN_FLOOR_MS, 20 * this.lastScanMs))
    }
  }

  private hasTmux(): boolean {
    return this.sessions.some(s => s.tmuxNames.length > 0)
  }

  private async probeOnce(pid: number, port: number): Promise<ProbeResult> {
    const key = `${pid}:${port}`
    const cached = this.probeCache.get(key)
    if (cached) return cached
    const result = await this.deps.probe(port).catch((): ProbeResult => ({ status: null, contentType: null }))
    this.probeCache.set(key, result)
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
