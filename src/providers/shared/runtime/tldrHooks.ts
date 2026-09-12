import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

export type PrivateCodexTldrHooks = {
  args: string[]
  dispose(): Promise<void>
}

/**
 * Materialize Codex's TLDR hooks: `--config` arguments plus a private header file.
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
export async function createCodexTldrHooks(
  servers: readonly BuiltInMcpServerConfig[],
): Promise<PrivateCodexTldrHooks | null> {
  const server = tldrHookServer(servers)
  if (!server) return null
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-hooks-'))
  const headerPath = join(directory, 'authorization')
  try {
    await writeFile(headerPath, `Authorization: Bearer ${server.bearerToken}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const args: string[] = []
  const trusted: string[] = []
  for (const event of EVENTS) {
    const handler: CodexCommandHandler = {
      type: 'command',
      command: `curl -fsS -H @${shellQuote(headerPath)} --data-binary @- ${shellQuote(`${server.tldrHooks.baseUrl}/${event.route}`)}`,
      timeout: HOOK_TIMEOUT_SECONDS,
      async: false,
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
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}
