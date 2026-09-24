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
    // Exit status 1 with empty output is lsof's "nothing matched" (recorded),
    // not a failure.
    return parseLsofListen((error as { stdout?: string }).stdout ?? '')
  }
}

/**
 * One `GET /` on loopback. Only ever called for listeners inside a watched
 * lane's own process tree; `redirect: 'manual'` so a redirect is classified,
 * not followed; one second, because a dev server that cannot answer that fast
 * is still listed (as "other").
 */
export async function probe(port: number): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
    await res.body?.cancel().catch(() => {})
    return { status: res.status, contentType: res.headers.get('content-type') }
  } catch {
    return { status: null, contentType: null }
  }
}
