// Pure port-attribution core for the lane browser pocket (decomposition
// Stage 2). No Electron, no I/O: LanePortWatcher feeds it command output and
// it answers "which listening ports belong to which session". Every rule here
// was forced by a Stage-1 recording (src/main/browserPocket/__fixtures__/README.md),
// which is why the tests read those files instead of literals.
//
// WHY detection by process tree instead of assigning ports: frameworks
// disagree about PORT (Vite ignores it), agents start servers themselves, and
// products that predicted ports shipped wrong-worktree bugs (Claude Code
// #86039/#90661). Attributing real listening sockets to the owning process tree
// works with any setup (Superset's model).

export type PsRow = { pid: number; ppid: number; comm?: string }
export type Listener = { pid: number; port: number; command?: string }
export type AttributedPort = { pid: number; port: number }
export type ProbeResult = { status: number | null; contentType: string | null }

/**
 * `ps -axo pid=,ppid=[,comm=]`. Comment lines (fixture provenance) and
 * anything not starting with two integers are skipped rather than failing the
 * whole scan: ps occasionally prints a row for a process that died mid-listing.
 */
export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(.+))?$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ...(m[3] ? { comm: m[3].trim() } : {}) })
  }
  return rows
}

/**
 * `lsof -F pcn` (or `-F pn`): a `p<pid>` line opens a process, `c<cmd>` names
 * it, then one `f<fd>` + `n<addr>:<port>` pair per listening fd. Addresses seen
 * in recordings: `127.0.0.1:4173`, `*:49152`; IPv6 `[::1]:5173` ends the same
 * way, so matching the trailing `:<port>` covers all three.
 */
export function parseLsofListen(text: string): Listener[] {
  const out: Listener[] = []
  let pid = 0
  let command: string | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); command = undefined }
    else if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n') && pid > 0) {
      const m = /:(\d+)$/.exec(line)
      if (m) out.push({ pid, port: Number(m[1]), ...(command !== undefined ? { command } : {}) })
    }
  }
  return out
}

/**
 * `tmux list-panes -a -F '#{session_name} #{pane_pid}'`.
 *
 * WHY this exists at all: tmux daemonizes its server (parent = PID 1) and every
 * pane process descends from THAT, not from Electron or from the terminal
 * session's own PTY (recorded 2026-09-22; the tmux process under Electron is
 * only an attached client). The server is also shared by every app instance on
 * the default socket, so callers must filter by the session's own `tmuxName`.
 * A multi-pane session yields its FIRST pane here; every pane is returned by
 * `parseTmuxPanesAll` for callers that need them.
 */
export function parseTmuxPanes(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const [name, pid] of parseTmuxPanesAll(text)) if (!out.has(name)) out.set(name, pid)
  return out
}

export function parseTmuxPanesAll(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (const line of text.split('\n')) {
    const m = /^(\S+) (\d+)$/.exec(line.trim())
    if (m) out.push([m[1]!, Number(m[2])])
  }
  return out
}

export function collectTree(roots: number[], parentOf: Map<number, number>): Set<number> {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parentOf) {
    const list = children.get(ppid)
    if (list) list.push(pid); else children.set(ppid, [pid])
  }
  const seen = new Set<number>()
  const queue = [...roots]
  for (let i = 0; i < queue.length; i++) {
    const pid = queue[i]!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return seen
}

/**
 * A process tree root for one session. `countsOwnListeners` is per ROOT, not
 * per session, because the two kinds disagree (both recorded):
 * - an agent root (claude/codex/opencode binary) must NOT count its own
 *   listeners — OpenCode's process serves its own UI as 200 text/html;
 * - a tmux pane root MUST count them — tmux runs a pane's command directly
 *   when given one, so the pane process can be the dev server itself (the
 *   recorded `python3 -m http.server` pane). An earlier draft excluded every
 *   root on the guess that "a pane root is always an idle shell"; the
 *   recording broke that guess.
 */
export type SessionRoot = { pid: number; countsOwnListeners: boolean }

/**
 * Ports each session's process tree is listening on.
 *
 * Rules, each from a recording:
 * - Descendants only, never ancestors: Electron main holds several listeners
 *   (MCP host, one 200 text/html) and the per-session `mitmdump` proxies are
 *   Electron's children, siblings of the agent — neither belongs to any lane.
 * - Root listeners follow `SessionRoot.countsOwnListeners` (above).
 * - Browser processes are the agent's own automation, not dev servers
 *   (isBrowserProcess, below).
 * - The same pid+port on several fds (IPv4 + IPv6) is one entry.
 * - Two sessions whose trees share a process both see its ports; the UI says
 *   so rather than guessing an owner.
 */
export function attributePorts(input: {
  listeners: Listener[]
  parentOf: Map<number, number>
  roots: Record<string, SessionRoot[]>
}): Record<string, AttributedPort[]> {
  const out: Record<string, AttributedPort[]> = {}
  for (const [sessionId, roots] of Object.entries(input.roots)) {
    const tree = collectTree(roots.map(r => r.pid), input.parentOf)
    const silentRoots = new Set(roots.filter(r => !r.countsOwnListeners).map(r => r.pid))
    const seen = new Set<string>()
    for (const l of input.listeners) {
      if (!tree.has(l.pid) || silentRoots.has(l.pid) || isBrowserProcess(l.command)) continue
      const key = `${l.pid}:${l.port}`
      if (seen.has(key)) continue
      seen.add(key)
      ;(out[sessionId] ??= []).push({ pid: l.pid, port: l.port })
    }
    out[sessionId]?.sort((a, b) => a.port - b.port)
  }
  return out
}

/**
 * A browser process listening inside an agent's tree is that agent's own
 * automation (Playwright / chrome-devtools MCP / Puppeteer), and its port is a
 * remote-debugging endpoint — never the app under development. Recorded: a
 * headless "Google Chrome" under `claude → zsh → node` answering 200 text/html
 * on :9393, which would otherwise be offered as the lane's dev server.
 * Matched on lsof's command name; absent (a `-F pn` scan) means unknown, kept.
 */
export function isBrowserProcess(command: string | undefined): boolean {
  return command !== undefined && /chrom|msedge|brave|firefox|headless_shell|webkit/i.test(command)
}

/**
 * What a `GET /` answer says about a listener.
 *
 * - `html`: 2xx/3xx with text/html — something to show in a pocket.
 * - `ignore`: any 5xx. Recorded: every mitmdump proxy answers 502 text/html,
 *   so "is it HTML" alone would list proxies as dev servers.
 * - `other`: everything else, INCLUDING 404 at `/` (a real Vite dev server
 *   with a custom base did that) and no answer at all. Listed, sorted last.
 */
export function classifyProbe(probe: ProbeResult): 'html' | 'other' | 'ignore' {
  if (probe.status !== null && probe.status >= 500) return 'ignore'
  const html = probe.contentType?.toLowerCase().includes('text/html') ?? false
  if (probe.status !== null && probe.status >= 200 && probe.status < 400 && html) return 'html'
  return 'other'
}
