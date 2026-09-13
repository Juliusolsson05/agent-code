import { execFile } from 'node:child_process'

// The OS's own record of the most recent wake, used to confirm that a tick gap
// was a sleep rather than a main-thread stall (see SystemSuspensionTracker).
//
// WHY `sysctl kern.waketime` and not `pmset -g log`: on this machine's macOS the
// power log stopped recording Sleep/Wake transitions after 2026-09-02 and holds
// only assertions, while the kernel keeps the last wake timestamp regardless.
// It is a single cheap read, only performed after a suspicious gap.
//
// Observed output format (captured on darwin 25.6, no sleep since boot):
//   `{ sec = 0, usec = 0 } Wed Dec 31 16:00:00 1969`
// A zero timestamp means "never woke since boot" and is reported as null.

export function parseSysctlTimeval(output: string): number | null {
  const match = /\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(output)
  if (!match) return null
  const seconds = Number(match[1])
  const micros = Number(match[2])
  if (!Number.isFinite(seconds) || !Number.isFinite(micros) || seconds === 0) return null
  return seconds * 1000 + Math.floor(micros / 1000)
}

/** Most recent macOS wake as wall-clock ms; null off macOS or when unknown.
 *  Off macOS a tick gap is therefore never reported: a stall must not be
 *  mistaken for sleep, and no other platform ships today. */
export function readDarwinLastWakeAt(): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('sysctl', ['-n', 'kern.waketime'], { timeout: 2_000 }, (error, stdout) => {
      resolve(error ? null : parseSysctlTimeval(String(stdout)))
    })
  })
}
