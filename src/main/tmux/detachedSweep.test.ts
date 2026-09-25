import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { DETACHED_REAP_GRACE_MS, DetachedTerminalSweep, startDetachedTerminalSweep } from '@main/tmux/detachedSweep.js'
import { UNDO_CLOSE_RETENTION_MS } from '@shared/undoRetention.js'

// The running-app half of tmux cleanup (#1030 item 4). Startup reconciliation
// is covered by tmuxRecovery.test.ts and shares this file's decoder; what is
// pinned here is the part that had NO cleanup at all: a terminal closed while
// the app keeps running left its shell alive until the next launch.
//
// Only the tmux process boundary is fake — same rule as tmuxRecovery.test.ts,
// no test may address the user's real server. The workspace input is the real
// persisted file.

function registryWith(...names: string[]) {
  return {
    isAvailable: () => true,
    listManagedSessions: vi.fn(async () => names.map(name => ({ name, createdAt: 1 }))),
    killSession: vi.fn(async (_name: string) => {}),
  }
}

// The live workspace.json the app persisted on 2026-09-19, sanitized
// (testing/fixtures/workspace-v2/README.md). It holds 27 sessions, exactly one
// of which is a terminal with a tmuxName — the reference a sweep must respect.
const RECORDED = readFileSync(
  new URL('../../../testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json', import.meta.url),
  'utf8',
)

function recordedTerminalNames(): string[] {
  const parsed = JSON.parse(RECORDED) as {
    windows: { workspace: { sessions: Record<string, { kind: string; tmuxName?: string }> } }[]
  }
  return parsed.windows
    .flatMap(window => Object.values(window.workspace.sessions))
    .filter(session => session.kind === 'terminal' && session.tmuxName)
    .map(session => session.tmuxName!)
}

const REAP_AFTER_MS = UNDO_CLOSE_RETENTION_MS + DETACHED_REAP_GRACE_MS

describe('detached tmux sweep', () => {
  it('reaps a closed terminal once the undo window has passed, and never the live one', async () => {
    const live = recordedTerminalNames()
    expect(live.length).toBeGreaterThan(0)

    // `agentcode-closed` is the shape of the leak: the pane is gone, so the
    // renderer's autosave no longer lists it, but the shell is still running.
    const registry = registryWith(...live, 'agentcode-closed')
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => live,
      now: () => clock,
    })

    // First sighting only starts the clock — Undo Close can still bring it back.
    expect(await sweep.run()).toEqual({ reaped: [], pending: ['agentcode-closed'] })
    expect(registry.killSession).not.toHaveBeenCalled()

    // Still inside the window one minute before the deadline.
    clock += REAP_AFTER_MS - 60_000
    expect((await sweep.run()).reaped).toEqual([])
    expect(registry.killSession).not.toHaveBeenCalled()

    clock += 60_001
    expect((await sweep.run()).reaped).toEqual(['agentcode-closed'])
    expect(registry.killSession).toHaveBeenCalledExactlyOnceWith('agentcode-closed')
    for (const name of live) expect(registry.killSession).not.toHaveBeenCalledWith(name)
  })

  it('never reaps a terminal main still owns, even before autosave has written it', async () => {
    // A terminal created seconds ago: live in main's registry, absent from the
    // persisted file the renderer has not flushed yet. The workspace file alone
    // would call it an orphan.
    const registry = registryWith('agentcode-just-spawned')
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => ['agentcode-just-spawned'],
      now: () => clock,
    })

    for (let i = 0; i < 4; i += 1) {
      expect((await sweep.run()).reaped).toEqual([])
      clock += REAP_AFTER_MS
    }
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('restarts the clock when Undo Close brings the terminal back', async () => {
    const registry = registryWith('agentcode-undone')
    let clock = 1_000_000
    let restored = false
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      // The restore re-attaches the same tmux session, so it reappears as a
      // live name (and, once autosave runs, in the file again).
      liveTmuxNames: () => (restored ? ['agentcode-undone'] : []),
      now: () => clock,
    })

    await sweep.run()
    clock += REAP_AFTER_MS - 1_000
    restored = true
    await sweep.run()

    // Closed again, well past the ORIGINAL deadline: the window must start over.
    restored = false
    clock += 2_000
    expect((await sweep.run()).reaped).toEqual([])
    clock += REAP_AFTER_MS - 1_000
    expect((await sweep.run()).reaped).toEqual([])
    clock += 2_000
    expect((await sweep.run()).reaped).toEqual(['agentcode-undone'])
  })

  it('protects a persisted-only terminal, and reaps an overdue one that is in neither authority', async () => {
    // The hibernated case, which is the one the unified stage made common: the
    // terminal exists in the workspace file and has NO live registry entry.
    // Without the persisted authority this shell would be killed; the earlier
    // tests could not see that, because they also handed the recorded name in
    // as a live name (review finding 4).
    const persisted = recordedTerminalNames()
    const registry = registryWith(...persisted, 'agentcode-really-gone')
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => [], // nothing hibernated is live in main
      now: () => clock,
    })

    await sweep.run()
    clock += REAP_AFTER_MS + 1
    expect((await sweep.run()).reaped).toEqual(['agentcode-really-gone'])
    for (const name of persisted) expect(registry.killSession).not.toHaveBeenCalledWith(name)
  })

  it('an undo between sweeps restarts the window even though no sweep saw it', async () => {
    // Close at t0, undo at t0+55min, close again a minute later, all between
    // two ticks. With the clock reset only by an observing sweep, the ORIGINAL
    // deadline stood and the shell died while its new undo entry was still
    // valid — the undo then produced a fresh shell with none of the original
    // processes or scrollback.
    const registry = registryWith('agentcode-reopened')
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => [],
      now: () => clock,
    })

    await sweep.run() // clock starts
    clock += REAP_AFTER_MS - 60_000
    sweep.noteAttached('agentcode-reopened') // ⌘⇧T re-attached the same session
    clock += 60_000 // closed again, one minute later
    clock += 1_000

    // Past the original deadline, nowhere near a new one.
    expect((await sweep.run()).reaped).toEqual([])
    clock += REAP_AFTER_MS - 1_000
    expect((await sweep.run()).reaped).toEqual([])
    clock += 2_000
    expect((await sweep.run()).reaped).toEqual(['agentcode-reopened'])
  })

  it('does not kill a terminal restored while the scan was awaiting tmux', async () => {
    // Every authority the sweep reads is a snapshot taken before an await, and
    // `tmux list-sessions` spawns a process. A restore landing in that gap used
    // to be killed by evidence that was already false.
    let release!: () => void
    const listing = new Promise<void>(resolve => { release = resolve })
    const registry = {
      isAvailable: () => true,
      listManagedSessions: vi.fn(async () => {
        await listing
        return [{ name: 'agentcode-raced', createdAt: 1 }]
      }),
      killSession: vi.fn(async (_name: string) => {}),
    }
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => [],
      now: () => clock,
    })

    registry.listManagedSessions = vi.fn(async () => [{ name: 'agentcode-raced', createdAt: 1 }])
    await sweep.run() // clock starts
    clock += REAP_AFTER_MS + 1

    registry.listManagedSessions = vi.fn(async () => { await listing; return [{ name: 'agentcode-raced', createdAt: 1 }] })
    const inFlight = sweep.run()
    sweep.noteAttached('agentcode-raced') // the user pressed ⌘⇧T
    release()

    expect((await inFlight).reaped).toEqual([])
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('does not kill a terminal restored after the scan already judged it overdue', async () => {
    // The narrower half of the same race: the restore lands AFTER the
    // classification loop has put the name on the kill list, while the sweep is
    // re-reading its evidence. Only the check taken immediately before the kill
    // — with no await after it — can catch this one.
    let release!: () => void
    const confirmRead = new Promise<void>(resolve => { release = resolve })
    let announceConfirm!: () => void
    const reachedConfirm = new Promise<void>(resolve => { announceConfirm = resolve })
    let reads = 0
    const registry = registryWith('agentcode-late-undo')
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => {
        reads += 1
        // Read 1 is the first sweep. Read 2 is the second sweep's
        // classification; read 3 is its PRE-KILL confirmation, i.e. the sweep
        // has already decided this name is overdue. Hold that one open.
        if (reads === 3) {
          announceConfirm()
          await confirmRead
        }
        return RECORDED
      },
      liveTmuxNames: () => [],
      now: () => clock,
    })

    await sweep.run() // read 1: clock starts (nothing due, so no confirm read)
    clock += REAP_AFTER_MS + 1

    const inFlight = sweep.run()
    // Only once the confirm read is in flight is the name genuinely on the
    // kill list — that is the state this test is about.
    await reachedConfirm
    expect(reads).toBe(3)
    sweep.noteAttached('agentcode-late-undo')
    release()

    expect((await inFlight).reaped).toEqual([])
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('issues no kill after stop(), even from a run already in flight', async () => {
    // Quit. These shells are exactly what the next launch recovers terminals
    // from, so a tick that fires during shutdown must not reach killSession.
    let release!: () => void
    const listing = new Promise<void>(resolve => { release = resolve })
    const registry = {
      isAvailable: () => true,
      listManagedSessions: vi.fn(async () => [{ name: 'agentcode-quitting', createdAt: 1 }]),
      killSession: vi.fn(async (_name: string) => {}),
    }
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => [],
      now: () => clock,
    })

    await sweep.run()
    clock += REAP_AFTER_MS + 1

    registry.listManagedSessions = vi.fn(async () => { await listing; return [{ name: 'agentcode-quitting', createdAt: 1 }] })
    const inFlight = sweep.run()
    sweep.stop()
    release()
    expect((await inFlight).reaped).toEqual([])
    expect(registry.killSession).not.toHaveBeenCalled()

    // And it stays disarmed.
    registry.listManagedSessions = vi.fn(async () => [{ name: 'agentcode-quitting', createdAt: 1 }])
    expect((await sweep.run()).withheld).toBe('stopped')
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('withholds cleanup when the inventory is not complete', async () => {
    // A partially-decoded file cannot prove orphanhood (#898). The discarded
    // region is exactly where a terminal's only reference may have been.
    const registry = registryWith('agentcode-unknown')
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => JSON.stringify({ version: 2, windows: 'not-an-array' }),
      liveTmuxNames: () => [],
      now: () => clock,
    })

    expect(await sweep.run()).toEqual({ reaped: [], pending: [], withheld: 'inventory-incomplete' })
    clock += REAP_AFTER_MS * 2
    expect((await sweep.run()).withheld).toBe('inventory-incomplete')
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('withholds cleanup when the workspace file cannot be read', async () => {
    const registry = registryWith('agentcode-unknown')
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) },
      liveTmuxNames: () => [],
      now: () => 1_000_000,
    })
    expect((await sweep.run()).withheld).toBe('inventory-incomplete')
    expect(registry.killSession).not.toHaveBeenCalled()
  })

  it('does nothing at all when tmux is unavailable', async () => {
    const registry = { ...registryWith('agentcode-closed'), isAvailable: () => false }
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => [],
      now: () => 1_000_000,
    })
    expect((await sweep.run()).withheld).toBe('tmux-unavailable')
    expect(registry.listManagedSessions).not.toHaveBeenCalled()
  })

  it('retries a kill that failed instead of restarting the window', async () => {
    const registry = registryWith('agentcode-stubborn')
    registry.killSession = vi.fn(async () => { throw new Error('tmux busy') })
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => [],
      now: () => clock,
    })

    await sweep.run()
    clock += REAP_AFTER_MS + 1
    await expect(sweep.run()).rejects.toThrow('tmux busy')
    // The timestamp survived the throw, so the very next sweep tries again
    // rather than granting another full hour.
    registry.killSession = vi.fn(async (_name: string) => {})
    expect((await sweep.run()).reaped).toEqual(['agentcode-stubborn'])
  })

  it('forgets a name that died on its own, so a recycled name is not born overdue', async () => {
    let alive = ['agentcode-recycled']
    const registry = {
      isAvailable: () => true,
      listManagedSessions: vi.fn(async () => alive.map(name => ({ name, createdAt: 1 }))),
      killSession: vi.fn(async (_name: string) => {}),
    }
    let clock = 1_000_000
    const sweep = new DetachedTerminalSweep({
      registry,
      readWorkspace: async () => RECORDED,
      liveTmuxNames: () => [],
      now: () => clock,
    })

    await sweep.run() // clock starts
    alive = [] // the user typed `exit`
    clock += REAP_AFTER_MS + 1
    await sweep.run()

    // Same name again — tmux names are UUID-derived so this is defensive, but
    // a stale timestamp would kill a brand-new shell on its first sighting.
    alive = ['agentcode-recycled']
    expect((await sweep.run()).reaped).toEqual([])
    expect(registry.killSession).not.toHaveBeenCalled()
  })
})

describe('detached tmux sweep schedule', () => {
  it('runs on the interval, never overlaps itself, and survives a throwing run', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let started = 0
      const registry = {
        isAvailable: () => true,
        listManagedSessions: vi.fn(async () => {
          started += 1
          // The FIRST run hangs on a slow `tmux list-sessions`; later runs do not.
          if (started === 1) await gate
          if (started === 2) throw new Error('tmux went away')
          return []
        }),
        killSession: vi.fn(async (_name: string) => {}),
      }
      const errors: unknown[] = []
      const schedule = startDetachedTerminalSweep({
        registry,
        readWorkspace: async () => RECORDED,
        liveTmuxNames: () => [],
        intervalMs: 1_000,
        onError: error => { errors.push(error) },
      })

      // Three ticks while the first run is still in flight: the in-flight flag
      // must collapse them, or a hung tmux call queues a backlog of sweeps.
      await vi.advanceTimersByTimeAsync(3_500)
      expect(started).toBe(1)

      release()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(started).toBe(2)

      // A throwing sweep is reported and the timer keeps going.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(errors).toHaveLength(1)
      expect(started).toBe(3)

      schedule.stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(started).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not run immediately — startup reconciliation just did that pass', async () => {
    vi.useFakeTimers()
    try {
      const registry = {
        isAvailable: () => true,
        listManagedSessions: vi.fn(async () => []),
        killSession: vi.fn(async (_name: string) => {}),
      }
      const schedule = startDetachedTerminalSweep({
        registry,
        readWorkspace: async () => RECORDED,
        liveTmuxNames: () => [],
        intervalMs: 1_000,
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(registry.listManagedSessions).not.toHaveBeenCalled()
      schedule.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
