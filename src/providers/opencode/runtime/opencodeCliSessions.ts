import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_EXPORT_BYTES = 256 * 1024 * 1024

export type OpencodeCliSessionOptions = {
  binary: string
  cwd: string
  env?: NodeJS.ProcessEnv
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
  } catch (error) {
    throw new Error(
      `OpenCode export for ${sessionId} did not return valid JSON: ${errorMessage(error)}`,
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
  try {
    const result = await execFileAsync(options.binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      maxBuffer: MAX_EXPORT_BYTES,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const detail = isRecord(error) && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : ''
    throw new Error(
      `OpenCode ${args[0] ?? 'command'} failed${detail ? `: ${detail}` : `: ${errorMessage(error)}`}`,
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
