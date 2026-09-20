import { performance } from 'node:perf_hooks'

// Process polling helpers shared by the OpenCode CLI system tests
// (opencodeCliSessions.system.test.ts and its processTree sibling). They live in
// one module so a fix to how the tests wait cannot land in one file and
// silently miss the other.

/**
 * Whether a pid currently names a process.
 *
 * Only for processes a test cannot observe through a ChildProcess handle, such
 * as a fixture's grandchild. A raw pid is not an identity: a zombie still
 * answers, and a reaped pid can be reused. For direct children prefer the
 * handle's `exitCode` / `signalCode`.
 */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** The settled value of `promise`, or 'pending' if it has not settled within `ms`. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), Math.max(0, ms)) })])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Poll `predicate` until it holds, failing with `label` after `timeoutMs`.
 *
 * WHY setImmediate rather than a fixed interval: each turn lets the child
 * process and filesystem callbacks the predicate depends on run, without adding
 * a delay to every check. The deadline is monotonic (performance.now), as
 * docs/testing/standard.md requires, so a wall-clock change cannot stretch or
 * cut it.
 */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}
