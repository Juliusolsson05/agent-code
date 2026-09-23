import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { LanePortWatcher, SCAN_FLOOR_MS, type LanePortWatcherDeps } from './LanePortWatcher'
import { parseLsofListen, parsePsTable, parseTmuxPanesAll } from './core/lanePorts'

// Replays the Stage-1 recording of a live machine: two apps' agents, a
// vite preview under one claude, a vite dev under another, and a tmux terminal
// serving from its pane. Which agent pid belongs to which session is the one
// fact the recording cannot carry, so the tests pick the recorded claudes.
const FIX = join(__dirname, '__fixtures__')
const TAG = 'agents-and-tmux-terminal'
const ps = parsePsTable(readFileSync(join(FIX, `ps-topology.${TAG}.txt`), 'utf8'))
const listeners = parseLsofListen(readFileSync(join(FIX, `lsof-listen.${TAG}.txt`), 'utf8'))
const panes = parseTmuxPanesAll(readFileSync(join(FIX, `tmux-panes.${TAG}.txt`), 'utf8'))
const probes = new Map((JSON.parse(readFileSync(join(FIX, `probe.${TAG}.json`), 'utf8')).probes as Array<{ port: number; status: number | null; contentType: string | null }>).map(p => [p.port, p]))
const parentOf = new Map(ps.map(r => [r.pid, r.ppid]))
const ancestorClaude = (port: number) => {
  let pid = listeners.find(l => l.port === port)!.pid
  while (ps.find(r => r.pid === pid)?.comm !== 'claude') pid = parentOf.get(pid)!
  return pid
}
const recTmux = panes.find(([name]) => name.startsWith('acpocket-rec-'))!

function harness(agents: Record<string, number>) {
  const timers: Array<{ fn: () => void; ms: number }> = []
  const listListeners = vi.fn(async (pids: number[]) => listeners.filter(l => pids.includes(l.pid)))
  const listTmuxPanes = vi.fn(async () => panes)
  const probe = vi.fn(async (port: number) => probes.get(port) ?? { status: null, contentType: null })
  const broadcast = vi.fn()
  let t = 0
  const deps: LanePortWatcherDeps = {
    listProcesses: async () => parentOf,
    listListeners, listTmuxPanes, probe, broadcast,
    agentPid: id => agents[id] ?? null,
    terminalPid: () => null,
    now: () => (t += 5),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return () => {} },
  }
  return { watcher: new LanePortWatcher(deps), timers, listListeners, listTmuxPanes, probe, broadcast }
}

describe('LanePortWatcher on the recorded machine', () => {
  it('reports each lane its own dev server and nothing of its neighbour\'s', async () => {
    const h = harness({ a: ancestorClaude(4173), b: ancestorClaude(5292) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }, { sessionId: 'b', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    const out = h.broadcast.mock.calls.at(-1)![0]
    const ports = (id: string) => (out[id] ?? []).map((p: { port: number }) => p.port)
    expect(ports('a')).toContain(4173)
    expect(ports('a')).not.toContain(5292)
    expect(ports('b')).toContain(5292)
    expect(ports('b')).not.toContain(4173)
    // The recorded vite dev server 404s at "/" (custom base): listed, as other.
    expect(out.b.find((p: { port: number }) => p.port === 5292).kind).toBe('other')
  })

  it('finds a tmux terminal\'s server through its pane, attributed to the lane that owns the terminal', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [recTmux[0]], terminalSessionIds: [] }])
    await h.watcher.scan()
    const ports = h.broadcast.mock.calls.at(-1)![0].a.map((p: { port: number }) => p.port)
    expect(ports).toContain(listeners.find(l => l.pid === recTmux[1])!.port)
    expect(ports).toContain(4173)
  })

  it('hands lsof only the watched trees\' pids — never Electron, the proxies, or other apps', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    const asked = new Set(h.listListeners.mock.calls[0]![0])
    const foreign = ps.filter(r => r.comm === 'Electron' || r.comm === 'mitmdump' || r.comm === 'opencode').map(r => r.pid)
    expect(foreign.some(pid => asked.has(pid))).toBe(false)
  })

  it('probes only owned listeners, and each pid:port once across scans', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    await h.watcher.scan()
    expect(h.probe.mock.calls.map(c => c[0])).toEqual([4173])
  })

  it('does not ask tmux anything when no lane has a tmux terminal', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    expect(h.listTmuxPanes).not.toHaveBeenCalled()
  })
})

describe('scheduling and cost', () => {
  it('an empty plan schedules nothing and clears the chips', () => {
    const h = harness({})
    h.watcher.setSessions([])
    expect(h.timers).toEqual([])
    expect(h.broadcast).toHaveBeenLastCalledWith({})
  })

  it('a new plan scans at once; repeats never come faster than the floor', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    expect(h.timers[0]!.ms).toBe(0)
    h.timers[0]!.fn()
    await h.watcher.scan()
    expect(h.timers.slice(1).every(t => t.ms >= SCAN_FLOOR_MS)).toBe(true)
  })

  it('unchanged results are not re-broadcast', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    await h.watcher.scan()
    expect(h.broadcast).toHaveBeenCalledTimes(1)
  })
})

describe('review A #8 / surviving mutations', () => {
  it('a server that went away and came back on the same pid:port is probed again', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    const listen = h.listListeners.getMockImplementation()!
    h.listListeners.mockImplementation(async () => [])
    await h.watcher.scan()
    h.listListeners.mockImplementation(listen)
    await h.watcher.scan()
    expect(h.probe.mock.calls.map(c => c[0])).toEqual([4173, 4173])
  })

  it('backs off with the cost of a scan: 20 × the last scan time, never below the floor', async () => {
    const timers: number[] = []
    let t = 0
    const watcher = new LanePortWatcher({
      listProcesses: async () => { t += 400; return parentOf },
      listListeners: async () => [], listTmuxPanes: async () => [], probe: async () => ({ status: null, contentType: null }),
      agentPid: () => ancestorClaude(4173), terminalPid: () => null, broadcast: () => {},
      now: () => t, setTimer: (_fn, ms) => { timers.push(ms); return () => {} },
    })
    watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await watcher.scan()
    expect(timers.at(-1)).toBe(20 * 400)
  })

  it('a scan that started before the feature was turned off does not broadcast its stale ports', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const broadcast = vi.fn()
    const watcher = new LanePortWatcher({
      listProcesses: async () => { await gate; return parentOf },
      listListeners: async pids => listeners.filter(l => pids.includes(l.pid)), listTmuxPanes: async () => [],
      probe: async port => probes.get(port) ?? { status: null, contentType: null },
      agentPid: () => ancestorClaude(4173), terminalPid: () => null, broadcast,
      now: () => 0, setTimer: () => () => {},
    })
    watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    const scanning = watcher.scan()
    watcher.setSessions([])
    release()
    await scanning
    expect(broadcast.mock.calls.map(c => c[0])).toEqual([{}])
  })
})
