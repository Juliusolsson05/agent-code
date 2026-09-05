import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parse } from '@iarna/toml'

const begin = '# agent-code-external-control:v1 '
const end = '# /agent-code-external-control\n'
const serverName = 'agent-code-control'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
type Config = ReturnType<typeof parse>
type Connection = { url: string; token: string }
const serverAt = (config: Config) => (config.mcp_servers as Record<string, Record<string, unknown>> | undefined)?.[serverName]

function parseConfig(text: string): Config {
  try { return parse(text) }
  // Parser diagnostics may quote the bearer line. This error reaches Settings
  // and operation history, so it must never include the parser's input/cause.
  catch { throw new Error('Codex config.toml is invalid or uses a table shape that cannot be extended safely') }
}

function pruneEmptyTables(config: Config) {
  const servers = config.mcp_servers as Record<string, unknown> | undefined
  if (!servers) return
  const server = serverAt(config)
  if (server && Object.keys(server).length === 0) delete servers[serverName]
  if (Object.keys(servers).length === 0) delete config.mcp_servers
}

// WHY this is a pure, local ownership transform: the file installer retains its
// compare-before-replace and skill ownership checks; the listener never learns
// TOML. #817 was caused by treating Codex's per-tool policy as connection bytes.
// We own only the hash-proven connection prefix, preserving the exact suffix
// and its complete parsed meaning rather than serializing a user's config.
export function reconcileExternalCodexConfig(existing: string, connection: Connection | null): string {
  const original = parseConfig(existing)
  const offset = existing.indexOf(begin)
  let before = existing
  let after = ''
  let oldUrl: string | undefined
  let remaining = original
  if (offset >= 0) {
    const edited = () => new Error('Managed Codex connection was edited; preserve or remove that block manually')
    const bodyStart = existing.indexOf('\n', offset) + 1
    const endStart = existing.indexOf(end, bodyStart)
    const marker = existing.slice(offset + begin.length, bodyStart - 1)
    if ((offset > 0 && existing[offset - 1] !== '\n') || !bodyStart || endStart < bodyStart
      || !/^[a-f0-9]{64}$/.test(marker) || existing.indexOf(begin, bodyStart) >= 0
      || existing.indexOf(end) !== endStart) throw edited()

    // The captured incident retains our original three connection lines and
    // appends tool tables before the end marker. Recover that *exact* original
    // prefix using its existing digest, never by trusting a familiar URL or by
    // blessing the entire edited block with a new hash. Incremental hashing is
    // linear even when a configuration contains many tool policy lines.
    const hash = createHash('sha256')
    let ownedEnd = -1
    for (let lineStart = bodyStart; lineStart < endStart;) {
      const lineEnd = existing.indexOf('\n', lineStart) + 1
      if (!lineEnd || lineEnd > endStart) break
      hash.update(existing.slice(lineStart, lineEnd))
      if (hash.copy().digest('hex') === marker) { ownedEnd = lineEnd; break }
      lineStart = lineEnd
    }
    if (ownedEnd < 0) throw edited()
    const owned = parseConfig(existing.slice(bodyStart, ownedEnd))
    const ownedServer = serverAt(owned)
    if (!ownedServer || typeof ownedServer.url !== 'string'
      || Object.keys(owned).some(key => key !== 'mcp_servers')
      || Object.keys(owned.mcp_servers!).some(key => key !== serverName)
      || Object.keys(ownedServer).some(key => !['url', 'http_headers', 'enabled'].includes(key))) throw edited()
    oldUrl = ownedServer.url
    before = existing.slice(0, offset)
    after = existing.slice(ownedEnd, endStart) + existing.slice(endStart + end.length)
    remaining = parseConfig(before + after)

    // Comments can occur inside TOML multiline strings, and removing a parent
    // header can reparent later bare keys. Hash matching alone cannot prove
    // ownership: removing precisely our keys must explain the *entire* parsed
    // change. Everything else (including quoted/nested tool tables) must agree.
    const expected = structuredClone(original)
    const expectedServer = serverAt(expected)
    if (!expectedServer) throw new Error('Codex connection ownership markers are outside the expected table')
    for (const key of Object.keys(ownedServer)) {
      if (!isDeepStrictEqual(expectedServer[key], ownedServer[key])) throw edited()
      delete expectedServer[key]
    }
    pruneEmptyTables(expected)
    pruneEmptyTables(remaining)
    if (!isDeepStrictEqual(expected, remaining)) throw new Error('Removing the managed connection would change unrelated Codex configuration')
  } else if (serverAt(original) !== undefined) {
    throw new Error(`Codex already has an unmanaged ${serverName} connection`)
  }

  const retained = serverAt(remaining)
  let body = ''
  if (connection) {
    body = `[mcp_servers.agent-code-control]\nurl = ${JSON.stringify(connection.url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${connection.token}`)} }\n`
  } else if (retained) {
    // A policy-only server has no transport and is not a valid Codex server
    // definition. Keep an explicitly disabled URL-only definition while policy
    // exists. No credential survives disable, and re-enable has an ownership
    // proof without claiming the policy or dropping the user's preferences.
    body = `[mcp_servers.agent-code-control]\nurl = ${JSON.stringify(oldUrl)}\nenabled = false\n`
  }
  const next = body ? `${before}${before && !before.endsWith('\n') ? '\n' : ''}${begin}${sha(body)}\n${body}${end}${after}` : before + after
  const parsedNext = parseConfig(next)
  const expectedNext = structuredClone(remaining)
  if (body) {
    const ownedServer = serverAt(parseConfig(body))!
    // This also catches collisions with user-owned parent settings. Updating
    // URL/auth/disabled state must never silently override an unrelated key.
    if (retained && Object.keys(ownedServer).some(key => Object.hasOwn(retained, key))) {
      throw new Error('Managed connection conflicts with user-owned Codex server settings')
    }
    const servers = (expectedNext.mcp_servers ??= {}) as Record<string, unknown>
    servers[serverName] = { ...retained, ...ownedServer }
  }
  pruneEmptyTables(parsedNext)
  pruneEmptyTables(expectedNext)
  if (!isDeepStrictEqual(expectedNext, parsedNext)) throw new Error('Updating the managed connection would change unrelated Codex configuration')
  return next
}
