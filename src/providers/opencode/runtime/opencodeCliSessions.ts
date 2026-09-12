import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises'
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
    output = await open(outputPath, 'wx', 0o600)
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
      // spawn has no `timeout`/`killSignal`, and its own `signal` option sends
      // SIGTERM, which a wedged CLI can ignore (the system test's fake CLI
      // does exactly that). So both bounds are rebuilt by hand on SIGKILL.
      //
      // The invariant from main still holds: this promise settles ONLY from
      // `close`, never from the abort or timeout event. Rejecting earlier
      // would let the finally blocks here and in importOpencodeSession delete
      // the capture and the import payload while the child is still alive and
      // writing or reading them.
      const child = spawn(options.binary, args, {
        cwd: options.cwd, env: options.env ?? process.env,
        stdio: ['ignore', fd, 'pipe'],
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
      const deadline = setTimeout(() => {
        failure ??= new Error(`timed out after ${timeoutMs} ms`)
        child.kill('SIGKILL')
      }, timeoutMs)
      // No `failure` is recorded for abort: close checks `signal.aborted`
      // first, so cancellation wins over any overflow or timeout that raced it.
      // That matches the execFile version, which callers such as
      // OpencodeTerminalSession treat as an expected stop, not a failure.
      const abort = () => { child.kill('SIGKILL') }
      options.signal?.addEventListener('abort', abort, { once: true })
      // Detect overflow while the producer runs, then check its final size
      // before allocating a string. Polling is a soft disk bound, not a hard
      // quota. Overflow fails the command; never parse a truncated prefix.
      const sizeGuard = setInterval(() => {
        if (failure) return
        try {
          if (fstatSync(fd).size > MAX_EXPORT_BYTES) throw new Error('output exceeds the 256 MiB capture limit')
        } catch (error) {
          failure = error instanceof Error ? error : new Error('Cannot inspect CLI output')
          child.kill('SIGKILL')
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
    if ((await output.stat()).size > MAX_EXPORT_BYTES) throw new Error('output exceeds the 256 MiB capture limit')
    return { stdout: await readFile(outputPath, 'utf8'), stderr: stderrText() }
  } catch (error) {
    throw new Error(
      `OpenCode ${args[0] ?? 'command'} failed: ${errorMessage(error)}`,
    )
  } finally {
    // Wait for process/stdio completion before closing and deleting the private
    // capture. Match import cleanup policy without ever touching native history.
    // `directory` is unset only when the pre-abort check or mkdtemp threw.
    try { await output?.close() }
    finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
