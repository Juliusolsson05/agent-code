import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { LanePortWatcher, PROBE_SETTLE_MS, SCAN_FLOOR_MS, type LanePortWatcherDeps } from './LanePortWatcher'
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
  // `advance` plays wall time passing between scans, which is what the settle
  // window (#1409) measures; `now()` alone only ticks 5 ms per read.
  const advance = (ms: number) => { t += ms }
  // One scan to discover the listeners, then one once they have settled
  // (#1409). The attribution tests below assert on what a settled scan shows.
  const settledScan = async (watcher: LanePortWatcher) => {
    await watcher.scan()
    advance(PROBE_SETTLE_MS)
    await watcher.scan()
  }
  const h = { watcher: new LanePortWatcher(deps), timers, listListeners, listTmuxPanes, probe, broadcast, advance }
  return { ...h, settle: () => settledScan(h.watcher) }
}

describe('LanePortWatcher on the recorded machine', () => {
  it('reports each lane its own dev server and nothing of its neighbour\'s', async () => {
    const h = harness({ a: ancestorClaude(4173), b: ancestorClaude(5292) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }, { sessionId: 'b', tmuxNames: [], terminalSessionIds: [] }])
    await h.settle()
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
    await h.settle()
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
    await h.settle()
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
    // Unsettled scan broadcasts no chips; the settled one broadcasts 4173.
    await h.settle()
    expect(h.broadcast).toHaveBeenCalledTimes(2)
    await h.watcher.scan()
    expect(h.broadcast).toHaveBeenCalledTimes(2)
  })
})

describe('review A #8 / surviving mutations', () => {
  it('a server that went away and came back on the same pid:port is probed again', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.settle()
    const listen = h.listListeners.getMockImplementation()!
    h.listListeners.mockImplementation(async () => [])
    await h.watcher.scan()
    h.listListeners.mockImplementation(listen)
    // The returning server settles afresh: its predecessor's age must not
    // carry over (it could be a test server reusing a freed port).
    await h.watcher.scan()
    expect(h.probe.mock.calls.map(c => c[0])).toEqual([4173])
    h.advance(PROBE_SETTLE_MS)
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

// #1409: agents run test suites inside their lanes, and those suites' loopback
// servers (every one in the issue's inventory binds port 0 and lives for one
// test) received the watcher's unsolicited `GET /`. The recorder's own page
// server in the recording is exactly such a listener: `listen(0)` on 62678,
// under claude 81647.
describe('#1409: short-lived listeners are never contacted', () => {
  const RECORDER_PAGE_SERVER = 62678

  it('a loopback server that is gone by the next scan is never probed nor listed', async () => {
    const h = harness({ a: ancestorClaude(RECORDER_PAGE_SERVER) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    h.listListeners.mockImplementation(async () => [])
    h.advance(PROBE_SETTLE_MS)
    await h.watcher.scan()
    expect(h.probe).not.toHaveBeenCalled()
    for (const [bySession] of h.broadcast.mock.calls) expect(bySession.a ?? []).toEqual([])
  })

  it('a dev server is probed and listed only once it has listened for the settle window', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.broadcast.mock.calls.at(-1)?.[0].a ?? []).toEqual([])
    h.advance(PROBE_SETTLE_MS)
    await h.watcher.scan()
    expect(h.probe.mock.calls.map(c => c[0])).toEqual([4173])
    expect(h.broadcast.mock.calls.at(-1)![0].a.map((p: { port: number }) => p.port)).toEqual([4173])
  })

  it('while a listener is unsettled the next scan comes when it settles, not after a longer back-off', async () => {
    const timers: number[] = []
    let t = 0
    const watcher = new LanePortWatcher({
      // 400 ms per scan ⇒ a 20 × 400 = 8 s back-off, longer than the window.
      listProcesses: async () => { t += 400; return parentOf },
      listListeners: async pids => listeners.filter(l => pids.includes(l.pid)), listTmuxPanes: async () => [],
      probe: async port => probes.get(port) ?? { status: null, contentType: null },
      agentPid: () => ancestorClaude(4173), terminalPid: () => null, broadcast: () => {},
      now: () => t, setTimer: (_fn, ms) => { timers.push(ms); return () => {} },
    })
    watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await watcher.scan()
    const next = timers.at(-1)!
    expect(next).toBeGreaterThanOrEqual(SCAN_FLOOR_MS)
    expect(next).toBeLessThanOrEqual(PROBE_SETTLE_MS)
  })

  it('pulling the next scan in for a settling listener never goes below the floor', async () => {
    const h = harness({ a: ancestorClaude(4173) })
    h.watcher.setSessions([{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }])
    await h.watcher.scan()
    // About 1 s left in the window: the rescan still waits the floor.
    h.advance(PROBE_SETTLE_MS - 1000)
    await h.watcher.scan()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.timers.at(-1)!.ms).toBe(SCAN_FLOOR_MS)
  })
})

// #1452 review A: what "listening for PROBE_SETTLE_MS" is measured from. These
// use a clock that only moves when a test moves it (the shared harness ticks
// 5 ms on every `now()` read, which blurs exact boundaries). Each scenario is
// one the reviewer reproduced against the first version of the window.
function preciseHarness(agent: number) {
  const clock = { t: 0 }
  const timers: number[] = []
  const probe = vi.fn(async (port: number) => probes.get(port) ?? { status: null, contentType: null })
  const broadcast = vi.fn()
  const owned = async (pids: number[]) => listeners.filter(l => pids.includes(l.pid))
  const listListeners = vi.fn(owned)
  const listProcesses = vi.fn(async () => parentOf)
  const watcher = new LanePortWatcher({
    listProcesses, listListeners, listTmuxPanes: async () => [], probe, broadcast,
    agentPid: () => agent, terminalPid: () => null,
    now: () => clock.t, setTimer: (_fn, ms) => { timers.push(ms); return () => {} },
  })
  const plan = [{ sessionId: 'a', tmuxNames: [], terminalSessionIds: [] }]
  return { clock, timers, probe, broadcast, listListeners, listProcesses, owned, watcher, plan }
}

describe('#1452: the settle window counts observed time only', () => {
  it('a slow lsof does not shorten the window: age starts when the listener was observed', async () => {
    const h = preciseHarness(ancestorClaude(4173))
    h.watcher.setSessions(h.plan)
    // lsof answers 4.9 s into the scan; that is when 4173 was first seen.
    h.listListeners.mockImplementationOnce(async pids => { h.clock.t += 4900; return h.owned(pids) })
    await h.watcher.scan()
    h.clock.t += SCAN_FLOOR_MS
    await h.watcher.scan()
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('a scan that straddles a plan change does not age what it finds', async () => {
    const h = preciseHarness(ancestorClaude(4173))
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.listProcesses.mockImplementationOnce(async () => { await gate; return parentOf })
    h.watcher.setSessions(h.plan)
    const first = h.watcher.scan()
    h.clock.t = 5100
    h.watcher.setSessions([...h.plan])
    release()
    await first
    // The generation-fenced immediate rescan, still at t = 5100.
    await h.watcher.scan()
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('an empty plan forgets ages: time spent unwatched is not settled time', async () => {
    const h = preciseHarness(ancestorClaude(4173))
    h.watcher.setSessions(h.plan)
    await h.watcher.scan()
    h.watcher.setSessions([])
    h.clock.t = PROBE_SETTLE_MS
    h.watcher.setSessions(h.plan)
    await h.watcher.scan()
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('probes at exactly PROBE_SETTLE_MS of observed life, not a millisecond before', async () => {
    const h = preciseHarness(ancestorClaude(4173))
    h.watcher.setSessions(h.plan)
    await h.watcher.scan()
    h.clock.t = PROBE_SETTLE_MS - 1
    await h.watcher.scan()
    expect(h.probe).not.toHaveBeenCalled()
    h.clock.t = PROBE_SETTLE_MS
    await h.watcher.scan()
    expect(h.probe.mock.calls.map(c => c[0])).toEqual([4173])
  })

  it('a failed lsof keeps a settled chip on screen and does not restart its window', async () => {
    const h = preciseHarness(ancestorClaude(4173))
    h.watcher.setSessions(h.plan)
    await h.watcher.scan()
    h.clock.t = PROBE_SETTLE_MS
    await h.watcher.scan()
    const settled = h.broadcast.mock.calls.at(-1)![0]
    expect(settled.a.map((p: { port: number }) => p.port)).toEqual([4173])
    const broadcasts = h.broadcast.mock.calls.length
    h.listListeners.mockRejectedValueOnce(Object.assign(new Error('lsof timed out'), { killed: true, signal: 'SIGTERM', code: null }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await h.watcher.scan()
    warn.mockRestore()
    expect(h.broadcast.mock.calls.length).toBe(broadcasts)
    h.clock.t += SCAN_FLOOR_MS
    await h.watcher.scan()
    // Still listed, from the probe cache: no resettle, no second probe.
    expect(h.broadcast.mock.calls.length).toBe(broadcasts)
    expect(h.probe.mock.calls.map(c => c[0])).toEqual([4173])
  })
})
