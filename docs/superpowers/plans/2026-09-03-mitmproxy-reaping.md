# Proxy: reap mitmproxy children on stop and quit, kill stale ones at startup

Refs #767 (item 5, the process-hygiene half). Refs #495 (A9 rollback), #119.

## Problem

Every Claude session with `useProxyStreaming` spawns its own `mitmdump`
(`src/providers/claude/runtime/claudeSession.ts` → `createProxyServer` in
`packages/claude-code-headless/src/proxy/proxyServer.ts`). The audit of the
previous two-day run found **20 `mitmdump` processes with ppid 1, two days
old** (ports 49386–60792, `_shared-conf` in their argv) next to 12 live ones.
Each idle mitmdump is a Python process holding ~60–100 MB RSS and a bound
port, on a 16 GB laptop that already swaps.

Where the lifecycle leaks, confirmed by reading the launcher:

- **Spawn shape.** `ProxyServer.startUnlocked` calls `child_process.spawn`
  with `stdio: ['ignore', 'pipe', 'pipe']`, no `detached`, no process group,
  no parent-death guard. When the Electron main process dies without running
  its handlers — SIGKILL / Force Quit, a native crash, `process.exit(1)` from
  `installProcessCrashHooks`, `app.exit(1)` in startup — the child is
  reparented to launchd (ppid 1) and keeps running. mitmdump does not notice
  its stdout/stderr pipes closing because it only writes on traffic, and there
  is none.
- **Normal stop.** `ProxyServer.stop()` sends SIGTERM, arms a 2 s SIGKILL,
  and awaits `child.once('exit')`. That is the right sequence, but it never
  resolves if the child already exited on its own (the `exit` event has
  already fired, `kill()` returns `false` without throwing). A mitmdump that
  died mid-session therefore turns `claudeSession.stop()` → `killAll()` →
  the will-quit gate into a hang, and the user's only way out is Force Quit —
  which orphans every *other* session's proxy.
- **Startup.** Nothing looks for leftovers from a previous run. Orphans
  accumulate until the user notices or reboots.
- **Failed start.** Already handled: `rollbackStart()` tears the proxy down
  when the PTY spawn or `headless.start()` throws (#495 A9). Not a source of
  the orphans.

Codex is not affected: its `ResponsesProxy` is an in-process HTTP server,
not a child process.

## Design

The launcher lives in the `claude-code-headless` submodule. This PR stays in
`src/` and does everything that can be done from the host side; the
submodule follow-ups are listed at the end.

### Ownership marker instead of a bare name

Agent Code already controls one argv token of every mitmdump it starts:
`--set confdir=<STATE_DIR>/proxy/_shared-conf` (passed explicitly from
`claudeSession.ts`). That token is
- specific to this app *and* this state directory, so a Homebrew mitmdump the
  user runs by hand, or another app's mitmproxy, never matches;
- visible in `ps -o args=` on macOS and Linux without any bookkeeping;
- stable across runs, which a port or a pid file is not.

A new module `src/main/proxy/mitmproxyReaper.ts` owns the constant
`MITMPROXY_SHARED_CONF_DIR` and `claudeSession.ts` passes *that* constant to
`createProxyServer`, so the marker we search for and the argv we spawn with
cannot drift.

Why not identify by name (`mitmdump`): the user may legitimately run their
own mitmproxy; (d) in the issue forbids touching it. Why not a pid registry
on disk: pids are recycled and the registry needs its own hygiene; the argv
marker plus the kernel's ppid is self-describing.

### Who owns a marked process

Only one Agent Code main process can own a state directory at a time
(`acquireStateProcessLock` refuses a second instance), so for a marked
process:
- `ppid === process.pid` → ours, alive, keep.
- `ppid === 1` (reparented to launchd/init) or `ppid` not running → the
  owner is dead, stale, kill.
- any other live `ppid` → a previous instance still in its last milliseconds
  of teardown, or a Linux subreaper we cannot see through. Keep, and count it
  in the journal event so we learn if it happens in practice. Never killing
  what we cannot prove we own is the conservative side of (d).

`selectStaleMitmproxyProcesses(rows, ctx)` is a pure function over
`{pid, ppid, args}` rows with an injected `isPidRunning`, so the policy is
unit-testable without spawning anything.

### Killing with a grace period

`terminateProcessWithGrace(pid, deps)`: SIGTERM, poll liveness every 100 ms
for the grace window (2 s, matching the package), then SIGKILL and poll until
gone (bounded). Signals and the clock are injected so the sequence is
testable with fake timers. ESRCH at any step means "already gone" and is
success, not an error.

### Three places it is used

1. **Session stop** (`claudeSession.teardownProxy`): `proxy.stop()` is raced
   against a deadline (`stopProxyServerWithDeadline`). On timeout the
   mitmdump is located by marker + `--listen-port <port>` + `ppid ===
   process.pid` and terminated with grace. Bounded teardown means a wedged or
   already-dead child can no longer hang quit.
2. **will-quit sweep**: after `SessionManager.killAll()` resolves, scan once
   for marked children with `ppid === process.pid` and terminate them. This
   catches anything a session did not own at snapshot time. Wired in
   `index.ts` by composing the manager handed to the shutdown gate; the gate
   itself does not learn about proxies.
3. **Startup reaper**: after the state lock and journal are up, scan for
   stale marked processes and terminate them. Fire-and-forget; never blocks
   boot. Records `proxy.mitmdump.stale_reaped` in the app-run journal (always
   on) and in the performance service when perf is enabled, with the counts
   scanned / killed / kept-owned / kept-live-foreign-owner and the pids.

A fourth, best-effort layer: a synchronous `process.on('exit')` sweep that
SIGKILLs marked children with `ppid === process.pid`. It covers the
`process.exit(1)` crash-hook path (Node runs `exit` handlers there) and
costs one `ps` at exit. It cannot cover SIGKILL of main or native crashes —
that is what the startup reaper is for.

### Alternatives rejected for this PR

- `detached: true` + `process.kill(-pgid)`: the right fix for the parent
  side, but the spawn is in the submodule. Detaching without the group kill
  makes orphaning *worse*, so it must land together in `claude-code-headless`.
- Addon-side parent watchdog (`mitmAddon.py` polling `os.getppid()` and
  exiting when it becomes 1): the true parent-death guard, works even for
  SIGKILL. Submodule; follow-up.
- Periodic reaping while running: not needed once the three layers above
  exist; can be added to the startup reaper's caller later if a case shows up.

## Not in scope

- Any change under `packages/` (spawn flags, exposing the child pid, the
  `stop()` hang when the child already exited, addon watchdog).
- One shared proxy for all sessions (issue #767 "consider").
- Batching addon writes (#767 item 5, first half).
- Windows: mitmdump is not bundled there; the scanner returns nothing.

## Verification

- `src/main/proxy/mitmproxyReaper.test.ts` (vitest unit project):
  - stale filter: marker + ppid 1 → kill; marker + dead owner → kill;
    marker + live foreign owner → keep; marker + ppid self → keep; no
    marker → keep even if named mitmdump; marker as a prefix of a longer
    path → keep.
  - `ps` row parsing with spaces in args.
  - grace sequence with fake timers: TERM only when the process exits within
    the grace; TERM then KILL at the grace boundary; already-gone sends
    nothing.
  - `stopProxyServerWithDeadline`: resolves without escalation when
    `stop()` resolves; escalates by port when `stop()` never resolves.
  - startup reaper end-to-end with injected process list, journals counts.
- `npx tsc -b --pretty false`.
- `npx vitest run --project unit src/main/proxy src/providers/claude/runtime`.
- Manual: `ps -e -o pid=,ppid=,args= | grep _shared-conf` before and after a
  Force Quit + relaunch — the ppid-1 rows should be gone after relaunch and
  `events.jsonl` should carry `proxy.mitmdump.stale_reaped` with the count.
