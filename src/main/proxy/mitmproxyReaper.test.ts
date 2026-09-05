import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasMitmproxyOwnerMarker,
  killOwnedMitmproxyProcessesSync,
  mitmproxyOwnerMarker,
  parsePsRows,
  sameMitmproxyProcess,
  reapOwnedMitmproxyProcesses,
  reapStaleMitmproxyProcesses,
  selectStaleMitmproxyProcesses,
  stopProxyServerWithDeadline,
  terminateProcessWithGrace,
  type ProcessRow,
  type TerminateOutcome,
} from './mitmproxyReaper.js'

afterEach(() => vi.useRealTimers())

const CONF_DIR = '/Users/someone/.config/agent-code/proxy/_shared-conf'
const MARKER = mitmproxyOwnerMarker(CONF_DIR)
const SELF_PID = 7_117
const STARTED_AT = 'Fri Sep 4 12:00:00 2026'

// The exact argv shape ProxyServer.startUnlocked produces, as `ps -o args=`
// prints it (verified against a live dev instance on 2026-09-03).
function mitmdumpArgs(port: number, confDir: string = CONF_DIR): string {
  return (
    `/opt/homebrew/bin/mitmdump --listen-host 127.0.0.1 --listen-port ${port} ` +
    `--set confdir=${confDir} --set allow_hosts=^api\\.anthropic\\.com(:443)?$ ` +
    '-s /Applications/Agent Code.app/Contents/Resources/app.asar.unpacked/out/main/mitmAddon.py'
  )
}

function row(pid: number, ppid: number, args: string): ProcessRow {
  return { pid, ppid, args, startedAt: STARTED_AT }
}

function esrch(): NodeJS.ErrnoException {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
}

describe('ps row parsing', () => {
  it('keeps the whole command line including spaces and right-aligned pids', () => {
    const text = [
      `    1     0 ${STARTED_AT} /sbin/launchd`,
      ` 75312 ${SELF_PID} ${STARTED_AT} ${mitmdumpArgs(57337)}`,
      '',
      'garbage line without numbers',
    ].join('\n')
    expect(parsePsRows(text)).toEqual([
      row(1, 0, '/sbin/launchd'),
      row(75312, SELF_PID, mitmdumpArgs(57337)),
    ])
  })
})

describe('ownership marker', () => {
  it('matches the confdir token as a whole argument', () => {
    expect(hasMitmproxyOwnerMarker(mitmdumpArgs(1), MARKER)).toBe(true)
  })

  it('does not match a different state directory that shares the prefix', () => {
    expect(hasMitmproxyOwnerMarker(mitmdumpArgs(1, `${CONF_DIR}-other`), MARKER)).toBe(false)
    expect(hasMitmproxyOwnerMarker(mitmdumpArgs(1, `/elsewhere${CONF_DIR}`), MARKER)).toBe(false)
  })

  it('matches when the state directory itself contains spaces', () => {
    const spaced = '/Users/Some One/.config/agent-code/proxy/_shared-conf'
    expect(hasMitmproxyOwnerMarker(mitmdumpArgs(1, spaced), mitmproxyOwnerMarker(spaced))).toBe(true)
  })
})

describe('selectStaleMitmproxyProcesses', () => {
  const rows: ProcessRow[] = [
    // Ours, live: parented by this process.
    row(100, SELF_PID, mitmdumpArgs(50001)),
    // Reparented to launchd after the previous main died.
    row(101, 1, mitmdumpArgs(50002)),
    // Parent pid recorded but no longer running.
    row(102, 4_000, mitmdumpArgs(50003)),
    // Parent alive but not us (previous instance mid-teardown / subreaper).
    row(103, 5_000, mitmdumpArgs(50004)),
    // A user's own mitmproxy: same binary, orphaned, but no marker. Never ours.
    row(104, 1, '/opt/homebrew/bin/mitmdump --listen-port 8080 --set confdir=/Users/someone/.mitmproxy'),
    // Another install's proxy under a sibling state dir.
    row(105, 1, mitmdumpArgs(50005, `${CONF_DIR}-dev`)),
    // Unrelated process.
    row(106, 1, '/usr/bin/python3 some-script.py'),
  ]
  const live = new Set([SELF_PID, 5_000])
  const selection = selectStaleMitmproxyProcesses(rows, {
    marker: MARKER,
    selfPid: SELF_PID,
    isPidRunning: pid => live.has(pid),
  })

  it('kills marked processes whose owner is dead (ppid 1 or a dead pid)', () => {
    expect(selection.stale.map(r => r.pid)).toEqual([101, 102])
  })

  it('keeps marked processes parented by this process', () => {
    expect(selection.ownedBySelf.map(r => r.pid)).toEqual([100])
  })

  it('keeps marked processes whose foreign owner is still alive, and reports them', () => {
    expect(selection.keptLiveForeignOwner.map(r => r.pid)).toEqual([103])
  })

  it('never selects processes without the marker, even orphaned mitmdumps', () => {
    const all = [...selection.stale, ...selection.ownedBySelf, ...selection.keptLiveForeignOwner]
    expect(all.map(r => r.pid)).not.toContain(104)
    expect(all.map(r => r.pid)).not.toContain(105)
    expect(all.map(r => r.pid)).not.toContain(106)
  })

  it('treats pid 1 as a dead owner without consulting liveness', () => {
    const isPidRunning = vi.fn(() => true)
    const result = selectStaleMitmproxyProcesses([row(9, 1, mitmdumpArgs(1))], {
      marker: MARKER,
      selfPid: SELF_PID,
      isPidRunning,
    })
    expect(result.stale.map(r => r.pid)).toEqual([9])
    expect(isPidRunning).not.toHaveBeenCalled()
  })
})

describe('terminateProcessWithGrace', () => {
  it('does not escalate after PID identity changes during the grace period', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const canSignal = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const result = terminateProcessWithGrace(42, { kill, canSignal, isPidRunning: () => true, graceMs: 100, pollMs: 10 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toBe('identity-changed')
    expect(kill.mock.calls).toEqual([[42, 'SIGTERM']])
  })

  it('sends no signal when initial identity cannot be proven', async () => {
    const kill = vi.fn()
    await expect(terminateProcessWithGrace(42, { kill, canSignal: async () => false, isPidRunning: () => true })).resolves.toBe('identity-changed')
    expect(kill).not.toHaveBeenCalled()
  })
  function fakeProcess(options: { exitAfterTermMs?: number; ignoreTerm?: boolean; ignoreKill?: boolean } = {}) {
    let alive = true
    const signals: NodeJS.Signals[] = []
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (!alive) throw esrch()
      signals.push(signal)
      if (signal === 'SIGTERM' && !options.ignoreTerm) {
        setTimeout(() => { alive = false }, options.exitAfterTermMs ?? 0)
      }
      if (signal === 'SIGKILL' && !options.ignoreKill) alive = false
    })
    return { kill, signals, isPidRunning: () => alive, die: () => { alive = false } }
  }

  it('sends only SIGTERM when the process exits inside the grace window', async () => {
    vi.useFakeTimers()
    const proc = fakeProcess({ exitAfterTermMs: 300 })
    const outcome = terminateProcessWithGrace(42, { ...proc, graceMs: 2_000, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(400)
    await expect(outcome).resolves.toBe('exited-on-term')
    expect(proc.signals).toEqual(['SIGTERM'])
  })

  it('sends SIGKILL only after the full grace window when SIGTERM is ignored', async () => {
    vi.useFakeTimers()
    const proc = fakeProcess({ ignoreTerm: true })
    const outcome = terminateProcessWithGrace(42, { ...proc, graceMs: 2_000, pollMs: 100 })
    await vi.advanceTimersByTimeAsync(1_900)
    expect(proc.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(200)
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(outcome).resolves.toBe('killed')
  })

  it('reports survived when the process outlives SIGKILL and its wait', async () => {
    vi.useFakeTimers()
    const proc = fakeProcess({ ignoreTerm: true, ignoreKill: true })
    const outcome = terminateProcessWithGrace(42, {
      ...proc,
      graceMs: 1_000,
      killWaitMs: 500,
      pollMs: 100,
    })
    await vi.advanceTimersByTimeAsync(1_600)
    await expect(outcome).resolves.toBe('survived')
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('sends nothing when the process is already gone', async () => {
    const proc = fakeProcess()
    proc.die()
    await expect(terminateProcessWithGrace(42, proc)).resolves.toBe('already-gone')
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('treats ESRCH on SIGTERM as already gone rather than an error', async () => {
    const kill = vi.fn(() => { throw esrch() })
    await expect(
      terminateProcessWithGrace(42, { kill, isPidRunning: () => true }),
    ).resolves.toBe('already-gone')
  })

  it('propagates errors other than ESRCH so callers do not claim a kill they could not send', async () => {
    const kill = vi.fn(() => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }) })
    await expect(
      terminateProcessWithGrace(42, { kill, isPidRunning: () => true }),
    ).rejects.toThrow('EPERM')
  })
})

describe('signal identity boundary', () => {
  const expected = row(42, SELF_PID, mitmdumpArgs(50001))
  it('accepts the same native proxy including executable paths with spaces', () => {
    expect(sameMitmproxyProcess(expected, { row: expected, command: '/Applications/Agent Code.app/mitmdump' })).toBe(true)
  })
  it('accepts a normal Python mitmdump launcher but not an unrelated Python script carrying the marker', () => {
    const python = { ...expected, args: '/usr/bin/python3 /opt/homebrew/bin/mitmdump --set ' + MARKER }
    expect(sameMitmproxyProcess(python, { row: python, command: '/usr/bin/python3' })).toBe(true)
    const unrelated = { ...expected, args: '/usr/bin/python3 unrelated.py --set ' + MARKER }
    expect(sameMitmproxyProcess(unrelated, { row: unrelated, command: '/usr/bin/python3' })).toBe(false)
  })
  it('does not kill a recycled PID in the synchronous exit sweep', () => {
    const kill = vi.fn()
    expect(killOwnedMitmproxyProcessesSync({
      listProcessesSync: () => [expected], marker: MARKER, selfPid: SELF_PID, kill,
      inspectProcessSync: () => ({ row: { ...expected, startedAt: 'Fri Sep 4 12:01:00 2026' }, command: 'mitmdump' }),
    })).toBe(0)
    expect(kill).not.toHaveBeenCalled()
  })
  it.each([
    { row: { ...expected, startedAt: 'Fri Sep 4 12:01:00 2026' }, command: 'mitmdump' },
    { row: { ...expected, ppid: 999 }, command: 'mitmdump' },
    { row: { ...expected, args: mitmdumpArgs(50002) }, command: 'mitmdump' },
    { row: expected, command: '/usr/bin/echo' },
    null,
  ])('rejects replacement, reassignment and unrelated executables', current => {
    expect(sameMitmproxyProcess(expected, current)).toBe(false)
  })
})

describe('reapStaleMitmproxyProcesses', () => {
  it('terminates exactly the stale set and reports every bucket', async () => {
    const rows = [
      row(100, SELF_PID, mitmdumpArgs(50001)),
      row(101, 1, mitmdumpArgs(50002)),
      row(102, 4_000, mitmdumpArgs(50003)),
      row(103, 5_000, mitmdumpArgs(50004)),
      row(104, 1, '/opt/homebrew/bin/mitmdump --listen-port 8080'),
    ]
    const outcomes: Record<number, TerminateOutcome> = { 101: 'exited-on-term', 102: 'survived' }
    const terminate = vi.fn(async (pid: number) => outcomes[pid] ?? 'killed')
    const report = await reapStaleMitmproxyProcesses({
      listProcesses: async () => rows,
      marker: MARKER,
      selfPid: SELF_PID,
      isPidRunning: pid => pid === 5_000,
      terminate,
    })
    expect(terminate.mock.calls.map(([pid]) => pid)).toEqual([101, 102])
    expect(report).toMatchObject({
      scanned: 5,
      stale: 2,
      reaped: 1,
      survived: 1,
      keptOwnedBySelf: 1,
      keptLiveForeignOwner: 1,
    })
    expect(report.processes).toEqual([
      { pid: 101, ppid: 1, outcome: 'exited-on-term' },
      { pid: 102, ppid: 4_000, outcome: 'survived' },
    ])
  })

  it('records a per-process error instead of failing the whole sweep', async () => {
    const report = await reapStaleMitmproxyProcesses({
      listProcesses: async () => [row(101, 1, mitmdumpArgs(1)), row(102, 1, mitmdumpArgs(2))],
      marker: MARKER,
      selfPid: SELF_PID,
      isPidRunning: () => false,
      terminate: async pid => {
        if (pid === 101) throw new Error('kill EPERM')
        return 'killed'
      },
    })
    expect(report.reaped).toBe(1)
    expect(report.survived).toBe(1)
    expect(report.processes[0]).toEqual({ pid: 101, ppid: 1, outcome: 'error', error: 'kill EPERM' })
  })
})

describe('quit-time sweeps', () => {
  const rows = [
    row(100, SELF_PID, mitmdumpArgs(50001)),
    row(101, SELF_PID, mitmdumpArgs(50002)),
    row(102, 1, mitmdumpArgs(50003)),
    row(103, SELF_PID, '/usr/bin/python3 unrelated.py'),
  ]

  it('reapOwnedMitmproxyProcesses terminates only marked children of this process', async () => {
    const terminate = vi.fn(async (_pid: number): Promise<TerminateOutcome> => 'exited-on-term')
    const report = await reapOwnedMitmproxyProcesses({
      listProcesses: async () => rows,
      marker: MARKER,
      selfPid: SELF_PID,
      terminate,
    })
    expect(terminate.mock.calls.map(([pid]) => pid)).toEqual([100, 101])
    expect(report).toMatchObject({ scanned: 4, owned: 2, reaped: 2, survived: 0 })
  })

  it('killOwnedMitmproxyProcessesSync SIGKILLs the same set and tolerates a vanished pid', () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 101) throw esrch()
    })
    const killed = killOwnedMitmproxyProcessesSync({
      listProcessesSync: () => rows,
      inspectProcessSync: pid => ({ row: rows.find(item => item.pid === pid)!, command: '/opt/homebrew/bin/mitmdump' }),
      marker: MARKER,
      selfPid: SELF_PID,
      kill,
    })
    expect(kill.mock.calls).toEqual([[100, 'SIGKILL'], [101, 'SIGKILL']])
    expect(killed).toBe(1)
  })
})

describe('stopProxyServerWithDeadline', () => {
  it('returns stopped without scanning when the package stop resolves in time', async () => {
    vi.useFakeTimers()
    const listProcesses = vi.fn(async () => [] as ProcessRow[])
    const result = stopProxyServerWithDeadline(
      { stop: async () => undefined, info: { proxyPort: 57337 } },
      { deadlineMs: 6_000, listProcesses, marker: MARKER, selfPid: SELF_PID },
    )
    await vi.advanceTimersByTimeAsync(0)
    await expect(result).resolves.toEqual({ outcome: 'stopped', processes: [] })
    expect(listProcesses).not.toHaveBeenCalled()
    // The deadline timer must not keep the event loop (or a test) alive.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('escalates by port to our own child when stop never resolves', async () => {
    vi.useFakeTimers()
    const stop = vi.fn(() => new Promise<void>(() => {}))
    const terminate = vi.fn(async (_pid: number): Promise<TerminateOutcome> => 'killed')
    const listProcesses = vi.fn(async () => [
      row(501, SELF_PID, mitmdumpArgs(57337)),
      row(502, SELF_PID, mitmdumpArgs(57338)),
      // Same port, but an orphan of a previous run — the startup reaper's job.
      row(503, 1, mitmdumpArgs(57337)),
      // Same port, no marker: not ours.
      row(504, SELF_PID, '/opt/homebrew/bin/mitmdump --listen-port 57337'),
    ])
    const result = stopProxyServerWithDeadline(
      { stop, info: { proxyPort: 57337 } },
      { deadlineMs: 6_000, listProcesses, marker: MARKER, selfPid: SELF_PID, terminate },
    )
    await vi.advanceTimersByTimeAsync(5_999)
    expect(listProcesses).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({
      outcome: 'escalated',
      processes: [{ pid: 501, ppid: SELF_PID, outcome: 'killed' }],
    })
    expect(terminate.mock.calls.map(([pid]) => pid)).toEqual([501])
  })

  it('reports escalated-not-found when the child was already dead (the package hang)', async () => {
    vi.useFakeTimers()
    const result = stopProxyServerWithDeadline(
      { stop: () => new Promise<void>(() => {}), info: { proxyPort: 57337 } },
      { deadlineMs: 1_000, listProcesses: async () => [], marker: MARKER, selfPid: SELF_PID },
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toEqual({ outcome: 'escalated-not-found', processes: [] })
  })

  it('propagates a rejected stop instead of masking it as a timeout', async () => {
    await expect(
      stopProxyServerWithDeadline(
        { stop: async () => { throw new Error('boom') }, info: { proxyPort: 1 } },
        { deadlineMs: 1_000, listProcesses: async () => [] },
      ),
    ).rejects.toThrow('boom')
  })
})
