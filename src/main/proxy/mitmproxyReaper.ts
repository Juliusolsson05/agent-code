import { execFile, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { PROXY_EVENTS_DIR } from '@main/storage/paths.js'
import { isPidRunning as defaultIsPidRunning } from '@main/storage/processLock.js'

// Process hygiene for the per-session `mitmdump` children that Claude proxy
// streaming spawns (issue #767, item 5).
//
// WHY this module exists at all — the launcher is not ours to change here:
// `createProxyServer` / `ProxyServer` live in the `claude-code-headless`
// submodule (packages/claude-code-headless/src/proxy/proxyServer.ts). That
// launcher spawns mitmdump with `child_process.spawn(..., { stdio:
// ['ignore', 'pipe', 'pipe'] })` — not detached, not in its own process
// group, with no parent-death guard — and its `stop()` awaits
// `child.once('exit')` after SIGTERM/SIGKILL. Two consequences the 2026-09-03
// audit measured on a two-day run (20 orphaned mitmdump processes with ppid 1
// next to 12 live ones):
//
//   1. Any death of the Electron main process that skips the will-quit
//      handlers — Force Quit / SIGKILL, a native crash, `process.exit(1)` from
//      installProcessCrashHooks, `app.exit(1)` during startup — reparents every
//      mitmdump to launchd and leaves it running. mitmdump never notices its
//      stdio pipes closing because it only writes when there is traffic, and
//      an orphan gets none.
//   2. `ProxyServer.stop()` never resolves if the child ALREADY exited on its
//      own: the 'exit' event fired before the listener was attached and
//      `kill()` on a dead handle returns false without throwing. A mitmdump
//      that died mid-session therefore hangs claudeSession.stop() → killAll()
//      → the will-quit gate, and the user's only exit is Force Quit — which
//      orphans every OTHER session's proxy (consequence 1).
//
// What the host side CAN do without touching the submodule, and what this
// module provides:
//
//   - Identify mitmdump processes Agent Code started by an argv token WE
//     control (`--set confdir=<STATE_DIR>/proxy/_shared-conf`, passed from
//     claudeSession.ts) rather than by the bare name `mitmdump`. A Homebrew
//     mitmproxy the user runs by hand, or another app's, never carries that
//     path and is never touched (#767 (d)).
//   - Decide ownership by the kernel's ppid: exactly one Agent Code main can
//     own a state directory at a time (acquireStateProcessLock), so a marked
//     process whose parent is this pid is ours-and-alive, one whose parent is
//     init/launchd or a dead pid has lost its owner, and anything else is
//     kept (conservative — see selectStaleMitmproxyProcesses).
//   - Terminate with a grace period (SIGTERM, wait, SIGKILL, wait) in a form
//     whose signals and clock are injectable so the sequence is unit-tested
//     with fake timers instead of a real mitmdump.
//   - Bound the per-session teardown so a wedged or already-dead child can
//     never hang quit (stopProxyServerWithDeadline), sweep our own children
//     once more after SessionManager.killAll (reapOwnedMitmproxyProcesses),
//     and kill leftovers from a previous run at startup
//     (reapStaleMitmproxyProcesses).
//
// The proper parent-side fix — `detached: true` plus `process.kill(-pgid)`,
// or an addon-side `os.getppid()` watchdog in mitmAddon.py — belongs in the
// submodule and is listed as a follow-up in the plan
// (docs/superpowers/plans/2026-09-03-mitmproxy-reaping.md). Nothing here
// conflicts with it: once the launcher detaches, the marker/ppid logic keeps
// working unchanged because the child's ppid is still the spawning main.

const execFileAsync = promisify(execFile)

/**
 * The one mitmproxy confdir every Claude session shares (CA material lives
 * there; see proxyServer.ts resolveConfDir for why sessions must not each get
 * a fresh one). Exported so claudeSession.ts passes THIS constant to
 * createProxyServer — the value we spawn with and the value we search for
 * are then the same identifier by construction, and cannot drift.
 */
export const MITMPROXY_SHARED_CONF_DIR = join(PROXY_EVENTS_DIR, '_shared-conf')

/**
 * The argv token that marks a mitmdump as started by Agent Code for this
 * state directory. mitmdump receives it as `--set confdir=<dir>`, which
 * `ps -o args=` prints verbatim.
 *
 * WHY the confdir and not the addon path or the listen port: the addon path
 * is chosen inside the package (and differs between dev `out/main/` and the
 * packaged asar.unpacked location), so it is not an identifier we control
 * from src. The port is per-session and ephemeral, so it cannot identify a
 * process from a PREVIOUS run. The confdir is per-state-directory, stable
 * across runs, chosen in src, and specific enough (`~/.config/agent-code/
 * proxy/_shared-conf`) that nothing else on the machine carries it.
 */
export function mitmproxyOwnerMarker(confDir: string = MITMPROXY_SHARED_CONF_DIR): string {
  return `confdir=${confDir}`
}

export type ProcessRow = {
  pid: number
  ppid: number
  /** Full command line as `ps -o args=` prints it (argv joined by spaces). */
  args: string
}

/**
 * Parse `ps -o pid=,ppid=,args=` output. Leading whitespace is right-aligned
 * pid padding; everything after the second number is the command line and
 * may itself contain spaces (paths under `Application Support`, a home
 * directory with a space), which is why this is a regex and not a split.
 */
export function parsePsRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] })
  }
  return rows
}

function isWhitespaceAt(text: string, index: number): boolean {
  return index < 0 || index >= text.length || /\s/.test(text[index] ?? '')
}

/**
 * True when `args` carries the marker as a whole argv token. Bounded on both
 * sides by whitespace/end so `confdir=/x/_shared-conf` does not match a
 * process using `confdir=/x/_shared-conf-2` (a different state directory —
 * a sibling install or a test harness — is exactly the kind of process we
 * must not touch).
 */
export function hasMitmproxyOwnerMarker(args: string, marker: string): boolean {
  if (marker.length === 0) return false
  let from = 0
  for (;;) {
    const at = args.indexOf(marker, from)
    if (at === -1) return false
    if (isWhitespaceAt(args, at - 1) && isWhitespaceAt(args, at + marker.length)) return true
    from = at + 1
  }
}

function hasListenPort(args: string, port: number): boolean {
  return hasMitmproxyOwnerMarker(args, `--listen-port ${port}`)
}

export type OwnershipContext = {
  marker: string
  /** The Agent Code main pid — `process.pid` in production. */
  selfPid: number
  isPidRunning: (pid: number) => boolean
}

export type StaleSelection = {
  /** Marked, and the parent is init/launchd or no longer running. Kill. */
  stale: ProcessRow[]
  /** Marked, parented by this process. Live sessions — keep. */
  ownedBySelf: ProcessRow[]
  /**
   * Marked, parent is alive but is not us. Kept deliberately — see the WHY in
   * selectStaleMitmproxyProcesses. Reported so the journal shows if this
   * ever happens in practice.
   */
  keptLiveForeignOwner: ProcessRow[]
}

/**
 * The stale-process policy, as a pure function over `ps` rows so it can be
 * tested without spawning anything.
 *
 * A marked process is stale when its owner is dead. "Owner" is the kernel's
 * ppid, because the launcher spawns mitmdump directly from the Electron main
 * (no shell, no wrapper): at spawn time ppid IS the Agent Code main pid, and
 * when that main dies the kernel reparents the child to init/launchd (pid 1)
 * or, on Linux with a subreaper, to that subreaper.
 *
 * WHY a live foreign ppid is KEPT rather than killed: the state-process lock
 * guarantees at most one Agent Code main per state directory, so in practice
 * a marked child with a live parent that is not us belongs to the previous
 * instance in its last milliseconds of teardown (it released the lock in
 * will-quit and is exiting), or has been reparented to a Linux subreaper we
 * cannot see through. Killing the former is harmless but pointless; killing
 * the latter requires proving the subreaper is not an Agent Code process,
 * which is a heuristic over command lines. The issue's rule (d) — never kill
 * what Agent Code did not start — is best honoured by the conservative
 * reading: only act when the owner is provably gone.
 *
 * WHY `ppid <= 1` is treated as dead without consulting isPidRunning: pid 1
 * is always running, and `kill(1, 0)` answers EPERM, which the liveness
 * helper (correctly, for lock purposes) reports as "alive". Reparenting to
 * pid 1 is precisely the orphan signal we are looking for.
 */
export function selectStaleMitmproxyProcesses(
  rows: readonly ProcessRow[],
  ctx: OwnershipContext,
): StaleSelection {
  const selection: StaleSelection = { stale: [], ownedBySelf: [], keptLiveForeignOwner: [] }
  for (const row of rows) {
    if (!hasMitmproxyOwnerMarker(row.args, ctx.marker)) continue
    if (row.ppid === ctx.selfPid) {
      selection.ownedBySelf.push(row)
      continue
    }
    if (row.ppid <= 1 || !ctx.isPidRunning(row.ppid)) {
      selection.stale.push(row)
      continue
    }
    selection.keptLiveForeignOwner.push(row)
  }
  return selection
}

/** Marked children of THIS process — what a quit-time sweep must terminate. */
export function selectOwnedMitmproxyProcesses(
  rows: readonly ProcessRow[],
  ctx: Pick<OwnershipContext, 'marker' | 'selfPid'>,
): ProcessRow[] {
  return rows.filter(row => row.ppid === ctx.selfPid && hasMitmproxyOwnerMarker(row.args, ctx.marker))
}

const PS_ARGS = ['-e', '-ww', '-o', 'pid=,ppid=,args=']
// ~700 processes × a few hundred bytes on a busy dev machine is well under a
// megabyte; the cap only exists so a pathological host cannot make us buffer
// without bound.
const PS_MAX_BUFFER = 8 * 1024 * 1024

/**
 * Snapshot every process on the machine. `-e` means "all processes" on both
 * BSD ps (macOS, where it is an alias of -A) and procps (Linux); `-ww` lifts
 * the column-width truncation on both, which matters because the argv we
 * match on sits ~100 characters in. Windows has no bundled mitmdump and no
 * `ps`, so the scan is simply empty there.
 */
export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return []
  const { stdout } = await execFileAsync('ps', PS_ARGS, {
    encoding: 'utf8',
    maxBuffer: PS_MAX_BUFFER,
  })
  return parsePsRows(stdout)
}

/** Synchronous twin of listProcesses for the process 'exit' sweep. */
export function listProcessesSync(): ProcessRow[] {
  if (process.platform === 'win32') return []
  return parsePsRows(
    execFileSync('ps', PS_ARGS, {
      encoding: 'utf8',
      maxBuffer: PS_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  )
}

export type TerminateOutcome =
  /** Not running before we sent anything (or gone by the time SIGTERM went out). */
  | 'already-gone'
  /** Exited inside the grace window after SIGTERM. The good path. */
  | 'exited-on-term'
  /** Ignored SIGTERM; gone after SIGKILL. */
  | 'killed'
  /** Still reported running after SIGKILL and its wait. Journal it; nothing more we can do. */
  | 'survived'

export type TerminateDeps = {
  /** Must throw an ErrnoException with code ESRCH when the pid is gone. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  isPidRunning?: (pid: number) => boolean
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number
  /** How long to wait for the kernel to reap after SIGKILL. */
  killWaitMs?: number
  pollMs?: number
}

// The package's own stop() gives SIGTERM 2 s before SIGKILL; matching it
// keeps "how long can a session teardown take" a single number to reason
// about. mitmdump handles SIGTERM by cancelling its asyncio loop and exits in
// well under a second when healthy.
export const DEFAULT_TERMINATE_GRACE_MS = 2_000
export const DEFAULT_TERMINATE_KILL_WAIT_MS = 2_000
export const DEFAULT_TERMINATE_POLL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Send a signal; false when the pid is already gone, rethrow anything else. */
function signalOrGone(
  kill: NonNullable<TerminateDeps['kill']>,
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    kill(pid, signal)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw err
  }
}

/**
 * Wait up to `totalMs`, polling every `pollMs`, for the pid to stop running.
 * Counted in poll rounds rather than wall-clock so the sequence is exact
 * under fake timers and immune to a mocked Date.
 */
async function waitForExit(
  pid: number,
  isPidRunning: (pid: number) => boolean,
  totalMs: number,
  pollMs: number,
): Promise<boolean> {
  const rounds = Math.max(1, Math.ceil(totalMs / pollMs))
  for (let round = 0; round < rounds; round++) {
    await sleep(pollMs)
    if (!isPidRunning(pid)) return true
  }
  return false
}

/**
 * SIGTERM, wait for the grace window, SIGKILL, wait for the reap. This is
 * the sequence (b) in #767 asks for, kept separate from the package's
 * `ProxyServer.stop()` because that one is tied to a ChildProcess handle we
 * do not have for orphans from a previous run, and because it cannot be
 * driven from a pid alone.
 *
 * ESRCH at any step is success (the process is gone), never an error: on the
 * startup path the process may have exited between the `ps` snapshot and
 * our signal, and on the quit path the package's own stop() may have won
 * the race. Any other error (EPERM: not our process after all) propagates so
 * the caller can count it — we do not want to silently claim we reaped
 * something we could not signal.
 */
export async function terminateProcessWithGrace(
  pid: number,
  deps: TerminateDeps = {},
): Promise<TerminateOutcome> {
  const kill = deps.kill ?? process.kill.bind(process)
  const isPidRunning = deps.isPidRunning ?? defaultIsPidRunning
  const graceMs = deps.graceMs ?? DEFAULT_TERMINATE_GRACE_MS
  const killWaitMs = deps.killWaitMs ?? DEFAULT_TERMINATE_KILL_WAIT_MS
  const pollMs = deps.pollMs ?? DEFAULT_TERMINATE_POLL_MS

  if (!isPidRunning(pid)) return 'already-gone'
  if (!signalOrGone(kill, pid, 'SIGTERM')) return 'already-gone'
  if (await waitForExit(pid, isPidRunning, graceMs, pollMs)) return 'exited-on-term'
  // Gone between the last poll and the SIGKILL: it did honour SIGTERM,
  // just slowly. Report it as such so the journal does not over-count kills.
  if (!signalOrGone(kill, pid, 'SIGKILL')) return 'exited-on-term'
  if (await waitForExit(pid, isPidRunning, killWaitMs, pollMs)) return 'killed'
  return 'survived'
}

export type ReapDeps = {
  listProcesses?: () => Promise<ProcessRow[]>
  marker?: string
  selfPid?: number
  isPidRunning?: (pid: number) => boolean
  terminate?: (pid: number) => Promise<TerminateOutcome>
}

export type ReapedProcess = {
  pid: number
  ppid: number
  outcome: TerminateOutcome | 'error'
  error?: string
}

export type StaleReapReport = {
  /** Rows the scan saw in total (all processes, not just marked ones). */
  scanned: number
  /** Marked rows whose owner was dead — every one of these was signalled. */
  stale: number
  /** Of `stale`, how many are gone now (exited-on-term + killed + already-gone). */
  reaped: number
  /** Of `stale`, how many are still running after SIGKILL or could not be signalled. */
  survived: number
  keptOwnedBySelf: number
  keptLiveForeignOwner: number
  processes: ReapedProcess[]
}

async function terminateAll(
  rows: readonly ProcessRow[],
  terminate: (pid: number) => Promise<TerminateOutcome>,
): Promise<ReapedProcess[]> {
  // Parallel on purpose: each terminate spends most of its time sleeping in
  // the grace window, and twenty orphans serially would be forty seconds.
  return await Promise.all(
    rows.map(async (row): Promise<ReapedProcess> => {
      try {
        return { pid: row.pid, ppid: row.ppid, outcome: await terminate(row.pid) }
      } catch (err) {
        return {
          pid: row.pid,
          ppid: row.ppid,
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )
}

function countReaped(processes: readonly ReapedProcess[]): { reaped: number; survived: number } {
  let reaped = 0
  let survived = 0
  for (const entry of processes) {
    if (entry.outcome === 'survived' || entry.outcome === 'error') survived += 1
    else reaped += 1
  }
  return { reaped, survived }
}

/**
 * Startup reaper: find marked mitmdump processes whose owner is dead and
 * terminate them. Returns a report for the caller to journal; this module
 * stays free of journal types so it is trivially testable and reusable from
 * a future periodic sweep.
 *
 * WHY it runs at startup and not only at quit: the leaks this fixes are
 * exactly the deaths that skip quit (SIGKILL, native crash). The next launch
 * is the first moment a living Agent Code process exists to clean up after
 * the dead one, and it is guaranteed to hold the state lock the dead one
 * released, so the ppid reasoning above is sound at that instant.
 */
export async function reapStaleMitmproxyProcesses(deps: ReapDeps = {}): Promise<StaleReapReport> {
  const rows = await (deps.listProcesses ?? listProcesses)()
  const selection = selectStaleMitmproxyProcesses(rows, {
    marker: deps.marker ?? mitmproxyOwnerMarker(),
    selfPid: deps.selfPid ?? process.pid,
    isPidRunning: deps.isPidRunning ?? defaultIsPidRunning,
  })
  const terminate =
    deps.terminate ?? ((pid: number) => terminateProcessWithGrace(pid, { isPidRunning: deps.isPidRunning }))
  const processes = await terminateAll(selection.stale, terminate)
  return {
    scanned: rows.length,
    stale: selection.stale.length,
    ...countReaped(processes),
    keptOwnedBySelf: selection.ownedBySelf.length,
    keptLiveForeignOwner: selection.keptLiveForeignOwner.length,
    processes,
  }
}

export type OwnedReapReport = {
  scanned: number
  /** Marked children of this process still alive when the sweep ran. */
  owned: number
  reaped: number
  survived: number
  processes: ReapedProcess[]
}

/**
 * Quit-time sweep: after SessionManager.killAll() has stopped every session
 * it knew about, terminate any marked child of THIS process that is still
 * running. Anything found here is a real bug elsewhere (a session that was
 * mid-start when the shutdown snapshot was taken, a stop() that gave up), so
 * the caller journals `owned > 0` as a warning rather than a routine event.
 */
export async function reapOwnedMitmproxyProcesses(deps: ReapDeps = {}): Promise<OwnedReapReport> {
  const rows = await (deps.listProcesses ?? listProcesses)()
  const owned = selectOwnedMitmproxyProcesses(rows, {
    marker: deps.marker ?? mitmproxyOwnerMarker(),
    selfPid: deps.selfPid ?? process.pid,
  })
  const terminate =
    deps.terminate ?? ((pid: number) => terminateProcessWithGrace(pid, { isPidRunning: deps.isPidRunning }))
  const processes = await terminateAll(owned, terminate)
  return { scanned: rows.length, owned: owned.length, ...countReaped(processes), processes }
}

export type SyncKillDeps = {
  listProcessesSync?: () => ProcessRow[]
  marker?: string
  selfPid?: number
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Last-resort, synchronous SIGKILL of every marked child of this process.
 * Meant for `process.on('exit')`, where nothing asynchronous will ever run
 * again: `process.exit(1)` from the crash hooks, and whatever share of
 * `app.exit()` paths Electron routes through Node's exit event. It is
 * best-effort by nature — SIGKILL of main and native crashes never reach
 * it, which is what reapStaleMitmproxyProcesses on the next launch is for.
 *
 * No grace here on purpose: an exit handler cannot wait, and a process that
 * is about to lose its parent anyway gains nothing from a polite SIGTERM it
 * would have handled in a few hundred milliseconds we do not have.
 */
export function killOwnedMitmproxyProcessesSync(deps: SyncKillDeps = {}): number {
  const kill = deps.kill ?? process.kill.bind(process)
  let killed = 0
  const rows = (deps.listProcessesSync ?? listProcessesSync)()
  for (const row of selectOwnedMitmproxyProcesses(rows, {
    marker: deps.marker ?? mitmproxyOwnerMarker(),
    selfPid: deps.selfPid ?? process.pid,
  })) {
    try {
      kill(row.pid, 'SIGKILL')
      killed += 1
    } catch {
      // ESRCH (already gone) or EPERM — either way there is nothing more an
      // exiting process can do about it.
    }
  }
  return killed
}

/**
 * Register the synchronous sweep on process exit. Idempotent so hot reloads
 * and tests cannot stack listeners.
 */
let exitSweepInstalled = false
export function installMitmproxyExitSweep(deps: SyncKillDeps = {}): void {
  if (exitSweepInstalled) return
  exitSweepInstalled = true
  process.on('exit', () => {
    try {
      killOwnedMitmproxyProcessesSync(deps)
    } catch {
      // An exit handler must never throw: it would mask the real exit reason
      // and there is no one left to handle it.
    }
  })
}

export type StoppableProxyServer = {
  stop(): Promise<void>
  info: { proxyPort: number }
}

export type ProxyStopDeps = ReapDeps & {
  deadlineMs?: number
}

export type ProxyStopResult = {
  outcome:
    /** The package's stop() resolved inside the deadline. */
    | 'stopped'
    /** stop() did not resolve; we found our child by port and terminated it. */
    | 'escalated'
    /** stop() did not resolve and no matching child exists — it was already dead (the package hang). */
    | 'escalated-not-found'
  processes: ReapedProcess[]
}

// Three times the package's own TERM→KILL budget (2 s). A healthy mitmdump
// exits within ~200 ms of SIGTERM, so hitting this means the child is either
// already dead (stop() will never resolve — see the module header) or truly
// wedged; in both cases waiting longer only delays quit.
export const DEFAULT_PROXY_STOP_DEADLINE_MS = 6_000

/**
 * Run the package's `ProxyServer.stop()` under a deadline and, when it does
 * not resolve, locate the child ourselves (marker + `--listen-port <port>` +
 * ppid === this process) and terminate it with grace.
 *
 * WHY discover by port at escalation time rather than record the pid at
 * spawn: ProxyServer keeps its ChildProcess private and exposes no pid, and
 * reading it through a cast would tie us to the package's internals. One
 * `ps` on the slow path only — the normal stop pays nothing extra — keeps
 * the contract with the package limited to its public `info.proxyPort`.
 *
 * WHY the ppid check even here: the port is ours for this run, but a marked
 * process with the same port and ppid 1 is a leftover from a PREVIOUS run
 * that happened to get the same ephemeral port. It is not the child we are
 * stopping (it belongs to the startup reaper), and terminating the wrong
 * process from a session teardown is exactly the confusion this keeps out.
 */
export async function stopProxyServerWithDeadline(
  proxy: StoppableProxyServer,
  deps: ProxyStopDeps = {},
): Promise<ProxyStopResult> {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROXY_STOP_DEADLINE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const stopPromise = proxy.stop()
  const timedOut = await Promise.race([
    stopPromise.then(() => false),
    new Promise<true>(resolve => {
      timer = setTimeout(() => resolve(true), deadlineMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  if (!timedOut) return { outcome: 'stopped', processes: [] }

  // We are abandoning a promise that may never settle (the package hang) or
  // may reject later (a kill that throws). Neither outcome matters any more,
  // and an unhandled rejection from it would be pure noise in the journal.
  stopPromise.catch(() => undefined)

  const marker = deps.marker ?? mitmproxyOwnerMarker()
  const selfPid = deps.selfPid ?? process.pid
  const rows = await (deps.listProcesses ?? listProcesses)()
  const matches = selectOwnedMitmproxyProcesses(rows, { marker, selfPid }).filter(row =>
    hasListenPort(row.args, proxy.info.proxyPort),
  )
  if (matches.length === 0) return { outcome: 'escalated-not-found', processes: [] }
  const terminate =
    deps.terminate ?? ((pid: number) => terminateProcessWithGrace(pid, { isPidRunning: deps.isPidRunning }))
  return { outcome: 'escalated', processes: await terminateAll(matches, terminate) }
}
