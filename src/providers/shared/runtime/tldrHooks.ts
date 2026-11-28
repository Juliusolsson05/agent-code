import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { NativeStartupReceipt } from '@providers/codex/runtime/nativeStartupReceipt.js'
import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'

// Provider turn hooks that make TLDR reporting enforceable (#917).
//
// Everything here is launch-scoped: hooks are injected through the same
// process-local configuration Agent Code already uses for MCP, never written to
// the user's or a project's hook files, and never persisted past the process.

// A hook that has not answered in this long is not going to. Waiting longer
// would hold the user's turn open on a reporting nudge.
const HOOK_TIMEOUT_SECONDS = 10

/**
 * Provider event → the host route segment that handles it.
 *
 * WHY every hook is synchronous, including PostToolUse whose answer never
 * changes the turn: Codex 0.154.0 discards async hooks outright ("async hooks
 * are not supported yet") while still listing them, so an async PostToolUse was
 * silently never run. Tool use would then go unrecorded and the stale-TLDR check
 * could never fire. A loopback request per tool call is the price of the check
 * working at all; verified against the binary's own `hooks/list`.
 */
const EVENTS = [
  { provider: 'UserPromptSubmit', label: 'user_prompt_submit', route: 'user-prompt-submit' },
  { provider: 'PostToolUse', label: 'post_tool_use', route: 'post-tool-use' },
  { provider: 'Stop', label: 'stop', route: 'stop' },
] as const

export function tldrHookServer(
  servers: readonly BuiltInMcpServerConfig[],
): (BuiltInMcpServerConfig & { tldrHooks: { baseUrl: string }; bearerToken: string }) | undefined {
  return servers.find((server): server is BuiltInMcpServerConfig & { tldrHooks: { baseUrl: string }; bearerToken: string } =>
    Boolean(server.tldrHooks && server.bearerToken))
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

export const CLAUDE_TLDR_HOOK_TOKEN_ENV = 'AGENT_CODE_TLDR_HOOK_TOKEN'

/**
 * Claude settings fragment for the launch-only `--settings` source.
 *
 * WHY `http` hooks: Claude posts the hook input itself, so there is no script to
 * ship and no shell involved. The bearer is interpolated from an environment
 * variable Claude may read only because it is listed in `allowedEnvVars`; the
 * settings JSON — which is argv — carries the variable's name, never its value.
 */
export function claudeTldrHookSettings(baseUrl: string): { hooks: Record<string, unknown[]> } {
  return {
    hooks: Object.fromEntries(EVENTS.map(event => [event.provider, [{
      hooks: [{
        type: 'http',
        url: `${baseUrl}/${event.route}`,
        timeout: HOOK_TIMEOUT_SECONDS,
        headers: { Authorization: `Bearer $${CLAUDE_TLDR_HOOK_TOKEN_ENV}` },
        allowedEnvVars: [CLAUDE_TLDR_HOOK_TOKEN_ENV],
      }],
    }]])),
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Codex keys session-flag hooks to this synthetic path (codex-rs hooks
 * discovery.rs `config_toml_source_path` for `ConfigLayerSource::SessionFlags`). */
export const CODEX_SESSION_FLAGS_HOOK_SOURCE = '/<session-flags>/config.toml'

type CodexCommandHandler = { type: 'command'; command: string; timeout: number; async: boolean }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  }
  return value
}

/**
 * The trust hash Codex compares before it will run a non-managed hook.
 *
 * Mirrors codex-rs config/src/fingerprint.rs `version_for_toml` over the
 * normalized identity in hooks discovery.rs `hook_hash`: sha256 of the
 * key-sorted, compact JSON of `{event_name, hooks: [normalized handler]}`, where
 * unset optional fields are omitted. Verified against Codex 0.154.0's own
 * `hooks/list` report — see the pinned vector in tldrHooks.test.ts.
 *
 * WHY replicate an internal hash instead of passing
 * `--dangerously-bypass-hook-trust`: the bypass trusts every enabled hook for
 * the invocation, including the user's and any project's. Agent Code may vouch
 * for its own hook; it has no business vouching for theirs.
 *
 * If Codex ever changes this normalization, the hook becomes "modified" and
 * silently stops running. The TLDR peek's enforcement status is what turns that
 * silent failure into a visible one.
 */
export function codexHookTrustHash(label: string, handler: CodexCommandHandler): string {
  const identity = canonical({ event_name: label, hooks: [handler] })
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type PrivateCodexLaunchHooks = {
  args: string[]
  startup?: NativeStartupReceipt
  dispose(): Promise<void>
}

/**
 * Combine the launch's reporting and optional root identity hooks into a single
 * session-flags trust table. Assigning hooks.state twice would drop the earlier
 * launch grants. Lower-priority personal/project hooks retain their own source.
 *
 * WHY `curl` reading a header file: Codex's `mcp_tool` hook handler would call
 * the MCP server directly, but a hook-only tool on that server is also listed to
 * the model. A command hook keeps the tool surface unchanged. The bearer lives in
 * a mode-0600 file named by path, so neither Codex's argv nor curl's contains it.
 * `-f` turns any HTTP failure into empty output, which Codex treats as allow.
 *
 * Callers own `dispose()` on normal stop and on every partial-start rollback,
 * matching the private Claude MCP config file's lifecycle.
 */
export async function createCodexLaunchHooks(
  servers: readonly BuiltInMcpServerConfig[],
  root: string,
  captureStartup = false,
): Promise<PrivateCodexLaunchHooks | null> {
  const server = tldrHookServer(servers)
  if (!server && !captureStartup) return null
  // `root` is app-owned rather than os.tmpdir(): this file must outlive days of
  // idleness, and macOS clears its temp directory after three. See
  // TLDR_HOOK_RUNTIME_DIR. 0700 because every entry holds a live bearer.
  let directory: string
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    directory = await mkdtemp(join(root, 'codex-'))
  } catch (error) {
    if (server) throw error
    // A host identity hint is optional. A read-only state directory must not
    // take away a native terminal which could previously launch without TLDR.
    console.warn('[codex] Could not create the launch directory for transcript identity')
    return null
  }
  const headerPath = join(directory, 'authorization')
  try {
    if (server) await writeFile(headerPath, `Authorization: Bearer ${server.bearerToken}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const args: string[] = []
  const trusted: string[] = []
  const events = server ? EVENTS.map(event => ({
    ...event,
    command: `curl -fsS -H @${shellQuote(headerPath)} --data-binary @- ${shellQuote(`${server.tldrHooks.baseUrl}/${event.route}`)}`,
  })) : []
  const startup = captureStartup ? new NativeStartupReceipt(directory) : undefined
  const startupEvent = {
    provider: 'SessionStart',
    label: 'session_start',
    // A unique, atomically published receipt also survives startup preceding
    // the host watcher. Other hooks and panes cannot overwrite this launch.
    command: `f=$(/usr/bin/mktemp ${shellQuote(join(directory, 'start.XXXXXXXX'))}) && /bin/cat > "$f" && /bin/mv "$f" "$f.json"`,
  }
  for (const event of startup ? [...events, startupEvent] : events) {
    const handler: CodexCommandHandler = {
      type: 'command', command: event.command, timeout: HOOK_TIMEOUT_SECONDS, async: false,
    }
    args.push('--config', `hooks.${event.provider}=[{hooks=[{type="command",command=${JSON.stringify(handler.command)},timeout=${handler.timeout},async=${handler.async}}]}]`)
    const key = `${CODEX_SESSION_FLAGS_HOOK_SOURCE}:${event.label}:0:0`
    trusted.push(`${JSON.stringify(key)}={trusted_hash=${JSON.stringify(codexHookTrustHash(event.label, handler))}}`)
  }
  // One table value rather than dotted keys: every trust key contains
  // `config.toml`, and Codex splits override keys on dots.
  args.push('--config', `hooks.state={${trusted.join(',')}}`)
  return {
    args,
    startup,
    dispose: async () => { startup?.stop(); await rm(directory, { recursive: true, force: true }) },
  }
}

/**
 * Delete hook credential files left by an earlier app run.
 *
 * Every bearer they hold was revoked when that run's MCP host stopped, so they
 * are dead weight rather than live credentials. Crashes can leave a receipt
 * or credential file behind. Call only before any session registers.
 */
export async function sweepStaleTldrHookFiles(root: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(entries.map(entry => rm(join(root, entry), { recursive: true, force: true })))
}
