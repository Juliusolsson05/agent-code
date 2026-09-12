import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import type { MonitorProcessContext, MonitorProcessPage, MonitorProcessRow, MonitorProcessSummary } from '@shared/performance/processSnapshot.js'
import { parseNativeProcessTable } from './nativeProcessTable.js'
import type { NativeProcessStat } from './nativeProcessTable.js'

type Execute = (args: string[]) => Promise<string>
const execute: Execute = async args => {
  const task = promisify(execFile)('/bin/ps', args, {
    env: { ...process.env, LC_ALL: 'C' }, timeout: 3000, maxBuffer: 1024 * 1024,
  })
  const result = await task
  // ps enumerates itself. Its PID is already gone when the usage pass runs;
  // retaining that row would mark every healthy sample partial forever.
  return result.stdout.split('\n').filter(line => Number(/^\s*(\d+)/.exec(line)?.[1]) !== task.child.pid).join('\n')
}

export const EMPTY_PROCESS_SUMMARY: MonitorProcessSummary = {
  sampledAt: 0, count: 0, cpuPercent: null, memoryBytes: null, quality: 'warming-up',
  sessionCount: 0, missingRoots: 0, truncated: false,
}

/** All native work lives in the monitor helper. Slow ps never blocks main or overlaps another scan. */
export class NativeProcessSampler {
  private inFlight = false
  private topologyAt = -Infinity
  private topology = new Map<number, NativeProcessStat>()
  private rootIdentities = new Map<string, { pid: number; birth: number; generation?: string }>()
  private previous = new Map<string, { cpuMs: number; at: number }>()
  private cached: MonitorProcessPage = { summary: EMPTY_PROCESS_SUMMARY, rows: [], total: 0 }

  constructor(private readonly run: Execute = execute, private readonly platform = process.platform, private readonly now: () => number = () => performance.now()) {}
  read(): MonitorProcessPage { return this.cached }

  async sample(context: MonitorProcessContext): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const supported = this.platform === 'darwin' || this.platform === 'linux'
      let partial = !supported
      let truncated = context.truncated === true
      let missingRoots = 0
      const native = new Map<number, NativeProcessStat>()
      let nativeQuerySucceeded = false
      const owners = new Map<number, { ids: string[]; count: number }>()
      const selected = new Set<number>()
      const representedOwners = new Set<string>()
      const electron = new Map(context.electron.map(row => [row.pid, row]))
      if (supported) {
        try {
          const now = this.now()
          if (now - this.topologyAt >= MONITOR_POLICY.topologyMs) {
            const text = await this.run(['-axo', 'pid=,ppid=,lstart='])
            const parsed = parseNativeProcessTable(text)
            this.topology = new Map(parsed.map(row => [row.pid, row]))
            this.topologyAt = now
            if (parsed.length >= 20000) truncated = true
          }
          const children = new Map<number, number[]>()
          for (const row of this.topology.values()) {
            const entries = children.get(row.parentPid) ?? []
            entries.push(row.pid)
            children.set(row.parentPid, entries)
          }
          const visit = (root: number, sessionId?: string): void => {
            if (!this.topology.has(root) && !electron.has(root)) return
            const queue = [root]
            const seen = new Set<number>()
            for (let i = 0; i < queue.length && seen.size < MONITOR_POLICY.processLimit; i++) {
              const pid = queue[i]
              if (seen.has(pid)) continue
              seen.add(pid)
              if (!selected.has(pid) && selected.size >= MONITOR_POLICY.processLimit) { truncated = true; continue }
              selected.add(pid)
              if (sessionId) {
                representedOwners.add(sessionId)
                const owner = owners.get(pid) ?? { ids: [], count: 0 }
                owner.count++
                if (owner.ids.length < 4) owner.ids.push(sessionId)
                owners.set(pid, owner)
              }
              for (const child of children.get(pid) ?? []) if (!seen.has(child)) queue.push(child)
            }
            if (queue.length > seen.size) truncated = true
          }
          // Explicit session roots include detached/reparented providers that
          // no longer descend from Electron's main PID. A shared descendant is
          // selected once; its owners are recorded without summing it twice.
          visit(context.rootPid)
          const activeRoots = new Set<string>()
          for (const target of context.targets) if (target.pid && !target.exited) {
            activeRoots.add(target.sessionId)
            const birth = this.topology.get(target.pid)?.creationTime
            const prior = this.rootIdentities.get(target.sessionId)
            const sameLifetime = prior?.pid === target.pid && prior.generation === target.generation
            const expected = target.creationTime ?? (sameLifetime ? prior.birth : undefined)
            // The manager's backend run ID permits an intentional same-pane
            // restart. A changed OS birth within that same run is PID reuse,
            // not a new child of the old agent; preserve unavailable coverage.
            if (birth === undefined || (expected !== undefined && expected !== birth)) continue
            this.rootIdentities.set(target.sessionId, { pid: target.pid, birth, generation: target.generation })
            visit(target.pid, target.sessionId)
          }
          for (const id of this.rootIdentities.keys()) if (!activeRoots.has(id)) this.rootIdentities.delete(id)
          const nativePids = [...selected].filter(pid => !electron.has(pid))
          if (nativePids.length) {
            const text = await this.run(['-o', 'pid=,ppid=,lstart=,time=,rss=', '-p', nativePids.join(',')])
            nativeQuerySucceeded = true
            for (const row of parseNativeProcessTable(text, MONITOR_POLICY.processLimit)) {
              // Topology can go stale between 15s scans. A PID recycled during
              // that interval must not be attributed through its old parent.
              if (this.topology.get(row.pid)?.creationTime === row.creationTime) native.set(row.pid, row)
              else partial = true
            }
          }
        } catch { partial = true }
      }
      const now = this.now()
      const nextPrevious = new Map<string, { cpuMs: number; at: number }>()
      const rows: MonitorProcessRow[] = []
      const targetKinds = new Map(context.targets.map(target => [target.sessionId, target.kind]))
      for (const metric of context.electron.slice(0, MONITOR_POLICY.processLimit)) {
        const ids = owners.get(metric.pid)?.ids ?? []
        rows.push({
          identity: `${metric.pid}:${metric.creationTime}`, pid: metric.pid,
          parentPid: this.topology.get(metric.pid)?.parentPid ?? null,
          creationTime: metric.creationTime, type: metric.type, sessionIds: ids.slice(0, 4), sharedSessionCount: owners.get(metric.pid)?.count ?? 0,
          cpuPercent: metric.cpuPercent, memoryBytes: metric.memoryBytes,
          quality: metric.cpuPercent === null ? 'warming-up' : 'ok',
        })
      }
      for (const pid of selected) {
        if (electron.has(pid) || rows.length >= MONITOR_POLICY.processLimit) continue
        const stat = native.get(pid)
        if (!stat && nativeQuerySucceeded) continue
        const identity = `${pid}:${stat?.creationTime ?? this.topology.get(pid)?.creationTime ?? 0}`
        const previous = this.previous.get(identity)
        const elapsed = previous ? now - previous.at : 0
        const cpuPercent = stat?.cpuMs != null && previous && elapsed > 0 && elapsed <= 15000 && stat.cpuMs >= previous.cpuMs
          ? (stat.cpuMs - previous.cpuMs) / elapsed * 100 : null
        if (stat?.cpuMs != null) nextPrevious.set(identity, { cpuMs: stat.cpuMs, at: now })
        const ids = owners.get(pid)?.ids ?? []
        rows.push({
          identity, pid, parentPid: stat?.parentPid ?? null, creationTime: stat?.creationTime ?? this.topology.get(pid)?.creationTime ?? 0,
          type: ids.length ? targetKinds.get(ids[0]) === 'terminal' ? 'terminal' : 'agent' : 'child',
          ...(ids.length ? { provider: targetKinds.get(ids[0]) } : {}),
          sessionIds: ids.slice(0, 4), sharedSessionCount: owners.get(pid)?.count ?? 0,
          cpuPercent, memoryBytes: stat?.rss ?? null, quality: !stat ? 'partial' : cpuPercent === null ? 'warming-up' : 'ok',
        })
      }
      // Ownership IDs in each row are capped at four for transport. Keep a
      // separate bounded membership set so a fifth shared owner does not
      // become a fictitious unavailable process in the table.
      const represented = new Set<string>()
      for (const target of context.targets) {
        if (representedOwners.has(target.sessionId) && rows.some(row => row.pid === target.pid)) represented.add(target.sessionId)
      }
      for (const target of context.targets) {
        if (target.exited || represented.has(target.sessionId)) continue
        if (rows.length >= MONITOR_POLICY.processLimit) { truncated = true; break }
        rows.push({ identity: `session:${target.sessionId}`, pid: null, parentPid: null, creationTime: 0,
          type: target.kind === 'terminal' ? 'terminal' : 'agent', provider: target.kind,
          sessionIds: [target.sessionId], sharedSessionCount: 1, cpuPercent: null, memoryBytes: null, quality: 'unsupported' })
        // The placeholder is the canonical unavailable-root evidence. Count
        // it here exactly once whether discovery failed during topology,
        // lifetime validation, or the later resource query.
        missingRoots++
      }
      // Replace the entire interval map: exited identities cannot accumulate
      // forever or leak a previous CPU baseline into a later PID reuse.
      this.previous = nextPrevious
      rows.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || (a.pid ?? 0) - (b.pid ?? 0))
      const cpu = rows.flatMap(row => row.cpuPercent === null ? [] : [row.cpuPercent])
      const memory = rows.flatMap(row => row.memoryBytes === null ? [] : [row.memoryBytes])
      this.cached = {
        rows, total: rows.length,
        summary: {
          contextGeneration: context.generation, sampledAt: Date.now(), count: rows.filter(row => row.pid !== null).length, sessionCount: context.targets.filter(target => !target.exited).length,
          cpuPercent: cpu.length ? cpu.reduce((a, b) => a + b, 0) : null,
          memoryBytes: memory.length ? memory.reduce((a, b) => a + b, 0) : null,
          missingRoots, truncated,
          quality: partial || truncated || missingRoots > 0 || rows.some(row => row.quality === 'partial' || row.quality === 'unsupported') ? 'partial'
            : rows.some(row => row.quality === 'warming-up') ? 'warming-up' : 'ok',
        },
      }
    } finally { this.inFlight = false }
  }
}
