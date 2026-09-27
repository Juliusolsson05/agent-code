import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parseLsofListen, parsePsTable, type Listener, type ProbeResult } from './core/lanePorts.js'

const run = promisify(execFile)

/**
 * Platform I/O for LanePortWatcher. macOS only in v1: the parsers are tested
 * against recordings made on macOS, and Linux `/proc/net/tcp` / Windows
 * `netstat -ano` output has not been recorded yet (decomposition U1). On
 * those platforms the watcher reports no ports, so no chip ever lies.
 */
export const PORT_SCAN_SUPPORTED = process.platform === 'darwin'

export async function listProcesses(): Promise<Map<number, number>> {
  // pid and ppid only: no command/args columns, which would carry prompts and
  // project paths (the same rule as NativeProcessSampler).
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 3000, maxBuffer: 8 * 1024 * 1024 })
  return new Map(parsePsTable(stdout).map(r => [r.pid, r.ppid]))
}

export async function listListeners(pids: number[]): Promise<Listener[]> {
  if (pids.length === 0) return []
  try {
    // -a ANDs the filters (without it lsof ORs them and lists every
    // listener on the machine); -F pcn is the recorded machine format.
    const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn', '-p', pids.join(',')], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 })
    return parseLsofListen(stdout)
  } catch (error) {
    return listenersFromLsofError(error)
  }
}

/**
 * Exit status 1 is lsof's "nothing matched" (recorded), not a failure, and
 * its stdout is still the answer. Anything else is a failed observation: a
 * timeout (execFile kills the child, so `killed`/`signal` is set and `code`
 * is null), a signal, or a missing binary (`code: 'ENOENT'`). Those throw.
 * Before #1452 they became `[]`, which LanePortWatcher read as "every server
 * stopped". That pruned a settled dev server, and with the settle window its
 * chip then stayed hidden for another 5 s after lsof recovered (review A).
 */
export function listenersFromLsofError(error: unknown): Listener[] {
  const e = error as { code?: unknown; killed?: boolean; signal?: unknown; stdout?: string }
  if (e.code === 1 && !e.killed && !e.signal) return parseLsofListen(e.stdout ?? '')
  throw error
}

/**
 * The User-Agent every lane port probe sends (#1409).
 *
 * WHY name ourselves: the probe lands in a developer's own server. A log line
 * that says `AgentCode-LanePortProbe` explains itself; Node's default `node`
 * does not. It is also the one exact thing a long-lived test that counts
 * requests can excuse. The settle window (PROBE_SETTLE_MS in
 * LanePortWatcher.ts) keeps short tests from ever seeing the probe, but a
 * harness that outlives the window still can. Excusing "any `GET /`" (#1406)
 * would also excuse a real regression that requests `/`. Keep this stable:
 * tests match it verbatim.
 */
export const LANE_PORT_PROBE_USER_AGENT = 'AgentCode-LanePortProbe/1'

/**
 * One `GET /` on loopback. Only ever called for listeners inside a watched
 * lane's own process tree; `redirect: 'manual'` so a redirect is classified,
 * not followed; one second, because a dev server that cannot answer that fast
 * is still listed (as "other").
 */
export async function probe(port: number): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', headers: { 'user-agent': LANE_PORT_PROBE_USER_AGENT }, signal: AbortSignal.timeout(1000) })
    await res.body?.cancel().catch(() => {})
    return { status: res.status, contentType: res.headers.get('content-type') }
  } catch {
    return { status: null, contentType: null }
  }
}
