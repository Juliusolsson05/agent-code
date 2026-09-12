// Process-tree fault injection shaped like OpenCode's npm launcher
// (packages/opencode/bin/opencode at anomalyco/opencode v1.18.30): a Node
// script that spawns the native executable with `stdio: "inherit"` and only
// forwards SIGINT/SIGTERM/SIGHUP. SIGKILL cannot be forwarded, so killing the
// launcher alone leaves the "native" descendant holding the stdout capture and
// the stderr pipe. Both roles hang, so a CLI call can only settle if Agent Code
// terminates the tree, or at least stops waiting on the inherited stderr.
//
// NODE_OPTIONS preloads this file as the launcher, like abruptCli.mjs. The
// descendant runs the same file as its main module with the preload cleared,
// so it cannot recursively become another launcher.
//
// OPENCODE_LAUNCHER_DESCENDANT selects the descendant's behaviour:
// - hang: stays in the launcher's process group and never exits.
// - overflow: as hang, after growing stdout past the 256 MiB capture limit.
// - escaped: starts its own session, like a plugin helper that daemonizes, so
//   a process-group kill cannot reach it and only releasing stderr lets the
//   launcher's `close` arrive.
// - escaped-exit: as escaped, but the launcher then exits 0 at once, like a CLI
//   whose root finished while a daemonized helper still holds stderr. The
//   parent reaps the launcher long before `close`, and the launcher's group id
//   is released while the command is still pending.
import { spawn } from 'node:child_process'
import { ftruncateSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const behaviour = process.env.OPENCODE_LAUNCHER_DESCENDANT
const statusFile = process.env.OPENCODE_LAUNCHER_STATUS
if (process.env.OPENCODE_LAUNCHER_ROLE === 'descendant') {
  // The status file is the tree's readiness signal. It carries the launcher
  // pid the launcher itself passed down: process.ppid is not reliable, because
  // an escaped descendant whose launcher already exited has been reparented.
  // Status comes before overflow so the test learns both pids before the size
  // guard kills the tree.
  writeFileSync(`${statusFile}.tmp`, JSON.stringify({ pid: process.pid, launcherPid: Number(process.env.OPENCODE_LAUNCHER_PID) }))
  renameSync(`${statusFile}.tmp`, statusFile)
  // Sparse, as in abruptCli.mjs: over the limit without writing 256 MiB.
  if (behaviour === 'overflow') ftruncateSync(1, 256 * 1024 * 1024 + 1)
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, NODE_OPTIONS: '', OPENCODE_LAUNCHER_ROLE: 'descendant', OPENCODE_LAUNCHER_PID: String(process.pid) },
    stdio: 'inherit',
    detached: behaviour === 'escaped' || behaviour === 'escaped-exit',
  })
  // spawn() has already forked and exec'd, so the helper keeps its inherited
  // descriptors after this exit.
  if (behaviour === 'escaped-exit') process.exit(0)
}
// Neither role exits on SIGTERM, so only a SIGKILL path can end them.
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
// As the preload, this also stops Node from resolving the CLI "command name"
// (`export`) as a script to run.
await new Promise(() => {})
