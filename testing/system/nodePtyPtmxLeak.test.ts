import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import * as pty from 'node-pty'

// The behavioural half of #1437: spawn real PTYs through the installed
// (patched, rebuilt) node-pty and count this process's /dev/ptmx fds. Ported
// from upstream's own regression test in microsoft/node-pty#882.
//
// WHY darwin only: the leak is in node-pty's macOS-only pty_posix_spawn;
// Linux uses forkpty and never had it. CI's quality gate runs on Linux, so
// there testing/unit/patchNodePty.test.ts (the source-level check on the
// real 1.1.0 file) is the guard, and this test is the local proof that the
// compiled module actually stopped leaking.
//
// WHY one spawn at a time and only 20: each spawn needs a free PTY from a
// SYSTEM-WIDE table (kern.tty.ptmx_max, 511). A wide burst on a machine that
// is already near the cap fails for reasons unrelated to this bug, and
// competes with the user's own terminals. 20 sequential spawns is enough to
// show the pre-patch growth of exactly one fd per spawn.
//
// WHY `lsof -p`: it is the same measurement that found the leak in the
// packaged app (506 ptmx fds with 16 live sessions), so a pass here means the
// field symptom is gone, not a proxy for it.
function ptmxFdCount(): number {
  const out = execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' })
  return out.split('\n').filter(line => line.trimEnd().endsWith('/dev/ptmx')).length
}

describe.runIf(process.platform === 'darwin')('node-pty spawn does not leak /dev/ptmx (#1437)', () => {
  it('open ptmx fds return to the baseline after 20 PTYs exit', async () => {
    const before = ptmxFdCount()
    for (let i = 0; i < 20; i++) {
      const term = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24 })
      await new Promise<void>(resolve => term.onExit(() => resolve()))
      // destroy() mirrors what our session teardown reaches through kill();
      // node-pty already destroys the socket on exit, so this only makes the
      // measurement independent of its 200 ms DESTROY_SOCKET_TIMEOUT.
      ;(term as unknown as { destroy?: () => void }).destroy?.()
    }
    // Let the socket 'close' handlers run before counting.
    await new Promise(resolve => setTimeout(resolve, 500))
    // Pre-patch this is before + 20 (one leaked low_fds[0] per spawn).
    expect(ptmxFdCount()).toBeLessThanOrEqual(before)
  }, 30_000)
})
