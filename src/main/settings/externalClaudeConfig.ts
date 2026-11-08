import { isDeepStrictEqual } from 'node:util'
import { EXTERNAL_OPERATOR_SERVER_NAME } from '@providers/shared/runtime/externalControlExclusion.js'

type Connection = { url: string; token: string }
type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

// WHY ownership is proven by SHAPE rather than by a marker (the Codex TOML
// transform hashes its own block): ~/.claude.json is plain JSON that Claude
// re-serializes on every save, so neither comments nor key order survive.
// The only thing we can recognise later is the value itself.
//
// The shape is exactly what Agent Code ever writes, what Settings' "Copy JSON
// Config" pastes, and what `claude mcp add --transport http agent-code-control
// <url> --header "Authorization: Bearer …"` stores. Adopting a hand-pasted
// copy of OUR connection is therefore correct, not a takeover: the user was
// working around the missing integration (#1539). Anything else under the
// reserved name — stdio, a remote URL, extra keys like `oauth` or
// `headersHelper` — is a server the user built and is never touched.
const managedUrl = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/
const managedAuthorization = /^Bearer [a-f0-9]{64}$/
function isManagedEntry(entry: unknown): boolean {
  if (!isObject(entry) || !isObject(entry.headers)) return false
  return Object.keys(entry).length === 3 && entry.type === 'http'
    && typeof entry.url === 'string' && managedUrl.test(entry.url)
    && Object.keys(entry.headers).length === 1
    && typeof entry.headers.Authorization === 'string' && managedAuthorization.test(entry.headers.Authorization)
}

/**
 * Returns the next file text, or `existing` itself when nothing needs to change
 * (callers compare by identity/equality to skip a write and keep the lock hold
 * short).
 *
 * Only top-level `mcpServers["agent-code-control"]` is ours. Project-scoped
 * servers (`projects[path].mcpServers`) are deliberately not used: an operator
 * drives the app from whatever directory it was started in, and a user-scope
 * entry is what `claude mcp add --scope user` produces.
 */
export function reconcileExternalClaudeConfig(existing: string | null, connection: Connection | null): string | null {
  let config: Json = {}
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown
    // Claude's own file holds OAuth account data and per-project history. A
    // parser diagnostic can quote a fragment of it and this message reaches
    // Settings and operation history, so never include the cause.
    try { parsed = JSON.parse(existing) } catch { throw new Error('Claude config (.claude.json) is not valid JSON; fix or remove it, then retry') }
    if (!isObject(parsed)) throw new Error('Claude config (.claude.json) is not a JSON object')
    config = parsed
  }
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) {
    throw new Error('Claude config mcpServers is not an object; refusing to extend it')
  }
  const servers = (config.mcpServers ?? {}) as Json
  const current = Object.hasOwn(servers, EXTERNAL_OPERATOR_SERVER_NAME) ? servers[EXTERNAL_OPERATOR_SERVER_NAME] : undefined
  if (current !== undefined && !isManagedEntry(current)) {
    throw new Error(`Claude already has an unmanaged ${EXTERNAL_OPERATOR_SERVER_NAME} connection; remove it or rename it, then retry`)
  }

  const desired = connection
    ? { type: 'http', url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } }
    : undefined
  if (isDeepStrictEqual(current, desired)) return existing
  // We never CREATE Claude's global config. A missing file means Claude Code
  // was never started with this config dir, or its file was lost. In the
  // second case Claude offers to restore it from ~/.claude/backups on its next
  // start, and a file holding only our server would suppress that offer.
  // Disabling against a missing file is simply already done.
  if (existing === null) {
    if (desired === undefined) return null
    throw new Error('Claude Code has no global config yet (.claude.json); start Claude Code once, then retry')
  }

  const nextServers: Json = { ...servers }
  if (desired) nextServers[EXTERNAL_OPERATOR_SERVER_NAME] = desired
  else delete nextServers[EXTERNAL_OPERATOR_SERVER_NAME]
  // Spreading `config` keeps every other key in its original order, and the
  // 2-space indent plus no trailing newline matches Claude's own saveConfig
  // (vendor utils/config.ts jsonStringify(…, null, 2)), so a reconcile shows
  // up in a diff of the file as only our entry. We keep an emptied
  // `mcpServers: {}` instead of deleting it: Claude's defaults include that
  // key, so removing it would be a second, unrelated change.
  return JSON.stringify({ ...config, mcpServers: nextServers }, null, 2)
}
