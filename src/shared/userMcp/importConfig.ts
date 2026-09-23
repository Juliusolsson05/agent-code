import { hasInputReference } from './inputs.js'
import type {
  UserMcpImportCandidate,
  UserMcpImportResult,
  UserMcpInput,
  UserMcpServerEntry,
} from './types.js'
import {
  coerceInputs,
  isPlainObject,
  isStringRecord,
  normalizeEntry,
  referencedInputIds,
  transportOf,
  validateServer,
} from './validate.js'

/**
 * Turn a pasted config snippet into candidate servers.
 *
 * Accepted shapes, in detection order:
 *  1. `{"mcpServers": {...}}` — Claude Code / Claude Desktop / Cursor, and what
 *     almost every server README publishes.
 *  2. `{"servers": {...}, "inputs": [...]}` — VS Code's mcp.json.
 *  3. `{"<name>": {command|url…}, …}` — the inner map on its own, which is what
 *     people copy when they grab "just the server part".
 *  4. `{command|url…}` — one bare entry; the caller supplies the name.
 *
 * WHY every literal env/header value becomes a secret input: we cannot tell a
 * token from a log level by looking at the key (`KEY`, `AUTH`, `X-Api-Key`,
 * `DATABASE_URL`…), and guessing wrong in the permissive direction writes a
 * credential into a plaintext JSON file. The built-in launcher made the same
 * call for the same reason (builtInMcpLaunch.ts: "avoids having to guess which
 * future header names are sensitive"). A user can edit a non-sensitive value
 * back to a literal afterwards; the reverse mistake cannot be undone.
 */
export function importUserMcpConfig(text: string, fallbackName = 'server'): UserMcpImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'Paste a JSON object.' }

  let format: 'mcpServers' | 'vscode' | 'map' | 'entry'
  let rawServers: Record<string, unknown>
  let vscodeInputs: UserMcpInput[] = []
  if (isPlainObject(parsed.mcpServers)) {
    format = 'mcpServers'
    rawServers = parsed.mcpServers
  } else if (isPlainObject(parsed.servers)) {
    format = 'vscode'
    rawServers = parsed.servers
    vscodeInputs = vscodeInputDefinitions(parsed.inputs)
  } else if (transportOf(parsed) !== null || 'command' in parsed || 'url' in parsed) {
    format = 'entry'
    rawServers = { [fallbackName]: parsed }
  } else if (Object.values(parsed).length > 0 && Object.values(parsed).every(isPlainObject)) {
    format = 'map'
    rawServers = parsed
  } else {
    return {
      ok: false,
      error: 'No MCP server found. Paste an "mcpServers" block, a VS Code "servers" block, or one server entry.',
    }
  }

  const names = Object.keys(rawServers)
  if (names.length === 0) return { ok: false, error: 'The config contains no servers.' }

  const candidates: UserMcpImportCandidate[] = []
  for (const name of names) {
    const raw = rawServers[name]
    if (!isPlainObject(raw)) continue
    candidates.push(candidateFor(name, raw, vscodeInputs, candidates))
  }
  return { ok: true, candidates, format }
}

function candidateFor(
  name: string,
  raw: Record<string, unknown>,
  vscodeInputs: readonly UserMcpInput[],
  earlier: readonly UserMcpImportCandidate[],
): UserMcpImportCandidate {
  const inputs: UserMcpInput[] = []
  const pendingSecrets: Record<string, string> = {}
  const takenIds = new Set<string>(vscodeInputs.map(input => input.id))
  const entry: Record<string, unknown> = { ...raw }

  const liftRecord = (field: 'env' | 'headers') => {
    const record = entry[field]
    if (!isStringRecord(record)) return
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(record)) {
      if (value === '' || hasInputReference(value)) {
        next[key] = value
        continue
      }
      const id = uniqueInputId(`${name}-${key}`, takenIds)
      // `Authorization: Bearer <token>` is the dominant header shape, and the
      // scheme word is not secret. Keeping it in the entry means the stored
      // secret is exactly what the server's settings page hands the user.
      const scheme = /^(Bearer|Token|Basic)\s+(.+)$/i.exec(value)
      next[key] = scheme ? `${scheme[1]} \${input:${id}}` : `\${input:${id}}`
      const secret = scheme ? scheme[2]! : value
      inputs.push({ id, description: `${field === 'env' ? 'Environment variable' : 'Header'} ${key}` })
      // README placeholders ("YOUR_TOKEN_HERE", "<api-key>") are not secrets.
      // Storing them would make the server look configured and then fail at
      // tool-call time; leaving the input empty shows "secret not set" instead.
      if (!isPlaceholder(secret)) pendingSecrets[id] = secret
    }
    entry[field] = next
  }
  liftRecord('env')
  liftRecord('headers')

  // VS Code inputs referenced by this entry come along as secret inputs.
  const referencedVscode = vscodeInputs.filter(input =>
    JSON.stringify(entry).includes(`\${input:${input.id}}`))
  inputs.unshift(...referencedVscode)
  // Any other `${input:id}` reference gets a definition too (review round 2):
  // a hand-written reference, or our own sanitized text being re-parsed after
  // the user edited it, used to import with no input at all and then fail
  // save with "no secret named …".
  for (const id of referencedInputIds(entry as UserMcpServerEntry)) {
    if (!inputs.some(input => input.id === id)) inputs.push({ id, description: 'Secret' })
  }

  const normalized = normalizeEntry(entry as UserMcpServerEntry)
  const problems = validateServer(
    { name, entry: normalized, inputs },
    earlier.map(candidate => ({ id: candidate.name, name: candidate.name })),
  )
  return { name, entry: normalized, inputs, pendingSecrets, problems }
}

function vscodeInputDefinitions(value: unknown): UserMcpInput[] {
  if (!Array.isArray(value)) return []
  // Every VS Code input becomes a secret regardless of `password`: the value
  // is supplied by the user at setup time either way, and treating it as a
  // secret only costs a masked field.
  return coerceInputs(value.map(input =>
    isPlainObject(input)
      ? { id: input.id, description: typeof input.description === 'string' ? input.description : '' }
      : input))
}

function uniqueInputId(seed: string, taken: Set<string>): string {
  const base = seed.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'secret'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

// `${VAR}` / `${env:VAR}` (review round 1): Claude/Cursor configs reference
// the user's environment this way. Stored as a secret it would be sent
// literally, so the server looks configured and fails at tool-call time.
const PLACEHOLDER = /^(<[^>]*>|\[[^\]]*\]|\.\.\.|x{3,}|your[\s_-].*|.*[\s_-]here|changeme|replace[\s_-]?me|token|api[\s_-]?key|\$\{[^}]+\})$/i

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim())
}
