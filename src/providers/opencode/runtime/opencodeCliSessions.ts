import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { mkdtemp, open, rm, rmdir, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_EXPORT_BYTES = 256 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

export type OpencodeCliSessionOptions = {
  binary: string
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** A stuck CLI must not hold startup or a transcript transform indefinitely. */
  timeoutMs?: number
}

/**
 * Read one native session through OpenCode's supported export boundary.
 *
 * WHY the host shells out instead of reaching into OpenCode's database: the
 * database is an implementation detail with migrations and project scoping,
 * while `export` is the compatibility surface OpenCode itself uses for moving
 * sessions between installations. Agent Code needs exactly that portability
 * contract for provider switching, duplicate, and rewind.
 */
export async function exportOpencodeSession(
  options: OpencodeCliSessionOptions,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await runOpencode(options, ['export', sessionId])
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error(
      `OpenCode export for ${sessionId} did not return valid JSON (${Buffer.byteLength(stdout)} bytes captured).`,
    )
  }
  if (!isRecord(value)) {
    throw new Error(`OpenCode export for ${sessionId} did not return an object.`)
  }
  return value
}

/** Import one projected OpenCode export and return its stable session id. */
export async function importOpencodeSession(
  options: OpencodeCliSessionOptions,
  value: Record<string, unknown>,
): Promise<string> {
  const sessionId = opencodeExportSessionId(value)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-code-opencode-import-'))
  const exportPath = join(temporaryDirectory, `${sessionId}.json`)
  try {
    // WHY mode 0600 even though the file is short-lived: exported histories can
    // contain source code, prompts, and tool output. The OS temp directory is
    // shared infrastructure, so relying only on eventual cleanup leaves a
    // needless observation window for other local users.
    await writeFile(exportPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await runOpencode(options, ['import', exportPath])
    return sessionId
  } finally {
    // This directory is uniquely minted above and contains only our one import
    // payload. Cleanup failure is intentionally non-fatal after a successful
    // import; the provider session is the requested durable result.
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Resolve OpenCode's fully merged configuration for the target project. */
export async function readResolvedOpencodeConfig(
  options: OpencodeCliSessionOptions,
): Promise<Record<string, unknown>> {
  const { stdout } = await runOpencode(options, ['debug', 'config', '--pure'])
  const value = JSON.parse(stdout) as unknown
  if (!isRecord(value)) throw new Error('OpenCode resolved configuration was not an object.')
  return value
}

/** Return the model ids exposed by the installed OpenCode provider set. */
export async function listOpencodeModels(
  options: OpencodeCliSessionOptions,
): Promise<string[]> {
  const { stdout } = await runOpencode(options, ['models'])
  return stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => /^[^/\s]+\/.+/u.test(line))
}

/**
 * Create the empty native session a terminal TUI will resume.
 *
 * OpenCode chooses a fresh id internally when launched without `--session`,
 * but it does not print that id as a machine-readable startup event. Preseeding
 * a supported import gives Agent Code the durable id before the PTY starts.
 * That identity is what makes reload, switching, recovery, and transcript MCP
 * work for a terminal-flavoured pane instead of treating it as forever empty.
 */
export async function createEmptyOpencodeSession(
  options: OpencodeCliSessionOptions,
): Promise<string> {
  const sessionId = `ses_${randomUUID().replaceAll('-', '')}`
  const now = Date.now()
  await importOpencodeSession(options, {
    info: {
      id: sessionId,
      slug: 'agent-code-terminal',
      projectID: 'agent-code-terminal',
      directory: options.cwd,
      path: '',
      title: 'Agent Code terminal session',
      version: '0.0.0-agent-code',
      time: { created: now, updated: now },
    },
    messages: [],
  })
  return sessionId
}

export function opencodeExportSessionId(value: Record<string, unknown>): string {
  const info = isRecord(value.info) ? value.info : null
  const sessionId = info && typeof info.id === 'string' ? info.id : null
  if (!sessionId || !sessionId.startsWith('ses_')) {
    throw new Error('Projected OpenCode export did not contain a valid `ses_` session id.')
  }
  return sessionId
}

async function runOpencode(
  options: OpencodeCliSessionOptions,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  let directory: string | undefined
  let output: FileHandle | undefined
  try {
    // Checked before minting the capture directory so an already-stopped
    // caller creates nothing on disk. It sits inside this try (as it did when
    // runOpencode still used execFile) so cancellation keeps the same wrapped
    // `OpenCode <command> failed: ...` shape as every other failure.
    options.signal?.throwIfAborted()
    directory = await mkdtemp(join(tmpdir(), 'agent-code-opencode-output-'))
    const outputPath = join(directory, 'stdout')
    // OpenCode 1.18.30 writes stdout, then process.exit() without awaiting the
    // pipe flush (cli/cmd/export.ts + index.ts). Raising execFile.maxBuffer
    // cannot recover bytes the producer never delivered: a real 14.6 MB export
    // stopped at 64 KiB. A regular-file stdout descriptor avoids that async-pipe
    // exit race. Keep this at the CLI boundary: resolved config can be large too.
    // The same rule applies to any new OpenCode command: output that always
    // fits one pipe buffer (`db path` in opencode-terminal-headless,
    // `--version` in setup/cliVersion) is safe on a pipe, because a write
    // smaller than the buffer completes before exit; anything that can exceed
    // ~64 KiB must go through this capture.
    //
    // WHY the capture is unlinked, and its private directory removed, BEFORE
    // the child starts: the child inherits the descriptor, not the path, and
    // this handle is all the parent needs to poll and read it. A file with no
    // name is freed by the kernel when its last descriptor closes, so an app
    // quit, a main-process crash or an orphaned child can no longer leave a
    // plaintext copy of a transcript in the temp directory. Before this, only
    // the async finally below deleted it, and an ordinary quit does not wait
    // for that: finite CLI commands are not part of any shutdown drain. The
    // remaining window is mkdtemp -> open -> unlink, a few syscalls before any
    // byte is written, inside a 0700 directory with a 0600 file.
    // `wx+` rather than `wx`: the parent reads the result back through this
    // same handle (see readCapture).
    //
    // Out of scope: the payload importOpencodeSession writes is handed to
    // `opencode import <path>` BY PATH, so it must keep a name while the child
    // runs and is still removed only by that function's finally.
    output = await open(outputPath, 'wx+', 0o600)
    await unlink(outputPath)
    await rmdir(directory)
    // Cleared only once nothing is left on disk. While it is still set, the
    // finally below removes whatever a failed setup step left behind.
    directory = undefined
    const fd = output.fd
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    let stderrTruncated = false
    const stderrText = () => Buffer.concat(stderrChunks).toString('utf8') + (stderrTruncated ? '\n[stderr truncated]' : '')
    const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000)
    await new Promise<void>((resolve, reject) => {
      // Two changes met here when #846 was merged with main. Main (e9ac8bdf,
      // Refs #864) bounded every CLI call with execFile's `timeout` plus an
      // owned abort listener, both SIGKILL, so a hung empty-session import
      // cannot hold OpenCode Terminal startup or survive stop(). This branch
      // (#845) replaced execFile with spawn so stdout can be a regular file.
      //
      // WHY the deadline and the abort are owned here instead of passed as
      // spawn's own `timeout` / `signal` / `killSignal` options (Node 24's
      // spawn does accept all three, an earlier version of this comment said
      // otherwise and was wrong):
      // - The deadline records a distinct `timed out after N ms` failure. With
      //   spawn's timeout, `close` would only report signal SIGKILL, which is
      //   indistinguishable from an external kill or the OOM killer.
      // - spawn's `signal` path emits an AbortError `error` and, for an
      //   already-aborted signal, kills on nextTick. Owning the listener keeps
      //   ONE cancellation outcome, `OpenCode command cancelled`, which
      //   OpencodeTerminalSession relies on to treat stop() as expected.
      // - None of spawn's built-in kill paths destroy stdio or reach
      //   descendants (execFile's kill did destroy stdio, which the merge
      //   first lost), so none of them would bound settlement when a
      //   descendant holds stderr. terminate() below does both.
      //
      // The invariant from main still holds: this promise settles ONLY from
      // `close`, never from the abort or timeout event. Rejecting earlier
      // would let importOpencodeSession's finally delete the import payload
      // while the child is still reading it, and would return a capture the
      // child is still writing. terminate() is what keeps that wait bounded.
      const child = spawn(options.binary, args, {
        cwd: options.cwd, env: options.env ?? process.env,
        stdio: ['ignore', fd, 'pipe'],
        // WHY a private process group (detached, deliberately WITHOUT unref)
        // on POSIX: the `opencode` on PATH or in the cached tool path can be
        // OpenCode's npm launcher (packages/opencode/bin/opencode, v1.18.30).
        // It is a Node script that spawns the native binary as ITS child with
        // `stdio: "inherit"` and only forwards SIGINT/SIGTERM/SIGHUP. SIGKILL
        // cannot be forwarded, so killing only the direct child left the
        // native process alive, still holding the stdout capture and the
        // stderr pipe: `close` never arrived and the timeout, stop and
        // overflow bounds all hung while the native CLI kept exporting or
        // mutating provider state. In its own group, terminate() reaches the
        // whole tree with one signal. Skipping unref() keeps the parent
        // tracking the child exactly as before; on POSIX `detached` only
        // means setsid().
        //
        // Why not resolve and exec the native binary instead: the launcher
        // picks it from OPENCODE_BIN_PATH, a cached copy, or one of several
        // platform/arch/AVX2-baseline/musl optional packages. Re-deriving that
        // couples Agent Code to OpenCode's private install layout (npm, brew,
        // curl installer all differ) and still would not cover a native CLI
        // or plugin that starts helpers of its own. A group does not care how
        // the tree was formed.
        //
        // Consequences: the child has no controlling terminal (these commands
        // are non-interactive and stdin is ignored), and a Ctrl+C in a dev
        // terminal no longer reaches it directly; it runs to its own end or to
        // the deadline. On Windows `detached` would open a console window and
        // there is no process-group kill, so it keeps the direct-child kill.
        detached: process.platform !== 'win32',
      })
      let failure: Error | undefined
      // WHY the lifecycle listeners come first, before timers and stdio: on
      // EMFILE/ENFILE Node's spawn() returns early with no pid and NO stderr
      // stream, then emits `error` (and `close`) on the next tick. Descriptor
      // exhaustion is reachable in a busy Electron main process even though
      // open() above succeeded, because the stderr pipe and the exec need more
      // descriptors. The old order dereferenced `child.stderr!` first: that
      // threw inside this executor, so the promise rejected with a TypeError,
      // the timers and abort listener were never cleared, and the next-tick
      // `error` had no listener. An unhandled ChildProcess `error` is an
      // uncaught exception, and installCrashHooks exits the app on those.
      // Nothing below this point may be allowed to run before these exist.
      //
      // Node also emits error when a kill fails, not just on failed spawn.
      // Retain capture ownership until close (which follows spawn errors too),
      // otherwise cleanup could unlink output while its producer is alive.
      child.on('error', error => { failure ??= error })
      child.once('close', (code, signal) => {
        // Referencing the timers declared below is safe: `close` is always
        // emitted asynchronously, after this executor has run to completion.
        clearInterval(sizeGuard)
        clearTimeout(deadline)
        options.signal?.removeEventListener('abort', abort)
        if (options.signal?.aborted) reject(new Error('OpenCode command cancelled'))
        else if (failure) reject(failure)
        else if (code !== 0) reject(new Error(stderrText().trim() || `exited with ${signal ?? code}`))
        else resolve()
      })
      // ONE termination path for the deadline, stop() and the size guard, so
      // the three bounds cannot drift apart again.
      // (a) Destroy stderr first. Settlement waits for `close`, and `close`
      //     waits for stderr EOF. A descendant that inherited fd 2 and left
      //     the process group (so (b) cannot reach it) would otherwise hold
      //     the promise open for as long as it lives. This mirrors execFile's
      //     own kill(), which destroyed stdout/stderr before signalling. Only
      //     diagnostics written after the outcome was decided are lost.
      //     stdout is a plain descriptor, not a stream: nothing to destroy.
      // (b) SIGKILL the whole group via the negative pid. A group outlives its
      //     leader while any member lives, so this still reaches the native
      //     descendant after the launcher has died, and POSIX does not reuse a
      //     pid while a group with that id exists. The `pid > 0` check is
      //     load-bearing: process.kill(-0) would signal Agent Code's OWN group.
      //     If the group is already gone (ESRCH) or cannot be signalled, fall
      //     back to the direct child, which is all Node's kill paths ever did.
      // Timers and the abort listener are cleared at `close`, so this never
      // runs against a pid that has already been released.
      const terminate = () => {
        child.stderr?.destroy()
        if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
          try {
            process.kill(-child.pid, 'SIGKILL')
            return
          } catch {
            // Group already gone or not signalable: fall through.
          }
        }
        child.kill('SIGKILL')
      }
      const deadline = setTimeout(() => {
        failure ??= new Error(`timed out after ${timeoutMs} ms`)
        terminate()
      }, timeoutMs)
      // No `failure` is recorded for abort: close checks `signal.aborted`
      // first, so cancellation wins over any overflow or timeout that raced it.
      // That matches the execFile version, which callers such as
      // OpencodeTerminalSession treat as an expected stop, not a failure.
      const abort = () => { terminate() }
      options.signal?.addEventListener('abort', abort, { once: true })
      // Detect overflow while the producer runs, then check its final size
      // before allocating a string. Polling is a soft disk bound, not a hard
      // quota. Overflow fails the command; never parse a truncated prefix.
      // Killing the whole tree is what makes the disk bound real: before the
      // group kill, a surviving native writer kept growing the file after
      // `failure` had already switched this guard off.
      const sizeGuard = setInterval(() => {
        if (failure) return
        try {
          if (fstatSync(fd).size > MAX_EXPORT_BYTES) throw new Error('output exceeds the 256 MiB capture limit')
        } catch (error) {
          failure = error instanceof Error ? error : new Error('Cannot inspect CLI output')
          terminate()
        }
      }, 100)
      sizeGuard.unref()
      // Optional: absent when spawn failed before stdio setup (see above).
      child.stderr?.on('data', (chunk: Buffer) => {
        const keep = Math.min(chunk.length, MAX_STDERR_BYTES - stderrBytes)
        if (keep > 0) { stderrChunks.push(Buffer.from(chunk.subarray(0, keep))); stderrBytes += keep }
        if (keep < chunk.length) stderrTruncated = true
      })
      // The signal may have fired while the capture was being minted, before
      // the listener existed; `once` listeners are not replayed for past aborts.
      if (options.signal?.aborted) abort()
    })
    // fstat through the retained handle: the capture has no path to stat.
    const { size } = await output.stat()
    if (size > MAX_EXPORT_BYTES) throw new Error('output exceeds the 256 MiB capture limit')
    return { stdout: await readCapture(output, size), stderr: stderrText() }
  } catch (error) {
    throw new Error(
      `OpenCode ${args[0] ?? 'command'} failed: ${errorMessage(error)}`,
    )
  } finally {
    // Reached only after `close`, or before anything was spawned. Closing the
    // last descriptor Agent Code owns frees the unnamed capture. `directory`
    // is still set only when setup failed between mkdtemp and rmdir; removal
    // failure stays non-fatal, matching the import payload policy, and native
    // history is never touched.
    try { await output?.close() }
    finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
  }
}

/**
 * Read the whole unnamed capture through its retained handle.
 *
 * WHY positional reads rather than `handle.readFile()`: the child's stdout is a
 * dup of this very descriptor, so both share one file offset, and the child's
 * writes left it at end-of-file. FileHandle.readFile reads from the current
 * offset and would return an empty string for a complete export. Positional
 * reads ignore the shared offset. `size` is the fstat that enforced the limit,
 * so the allocation stays bounded even if a stray writer appended afterwards.
 */
async function readCapture(handle: FileHandle, size: number): Promise<string> {
  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.toString('utf8', 0, offset)
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
