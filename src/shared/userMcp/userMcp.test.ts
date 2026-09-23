import { describe, expect, it } from 'vitest'

import { importUserMcpConfig } from './importConfig.js'
import { substituteInputs } from './inputs.js'
import { userMcpOverrideKey, userMcpOverridesFrom } from './types.js'
import {
  coerceUserMcpDocument,
  providerSupport,
  summarizeEntry,
  transportOf,
  userMcpDestination,
  validateServer,
} from './validate.js'

// Verbatim from https://developers.beeper.com/desktop-api/mcp/ (2026-09-22).
// Real published snippets are the fixture on purpose: the import path exists
// to accept exactly what server READMEs print, not a shape we imagined.
const BEEPER_HTTP_TOKEN = `{ "mcpServers": { "beeper": { "url": "http://localhost:23373/v0/mcp",
  "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" } } } }`
const BEEPER_STDIO_TOKEN = `{ "mcpServers": { "beeper": { "command": "npx",
  "args": ["-y", "@beeper/mcp-remote", "--header", "Authorization: Bearer \${ACCESS_TOKEN}"],
  "env": { "ACCESS_TOKEN": "YOUR_TOKEN_HERE" } } } }`
const BEEPER_VSCODE = `{ "servers": { "beeper": { "type": "http", "url": "http://localhost:23373/v0/mcp" } } }`

describe('importUserMcpConfig', () => {
  it('imports the Beeper HTTP snippet as an http server whose token is a secret input', () => {
    const result = importUserMcpConfig(BEEPER_HTTP_TOKEN)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.format).toBe('mcpServers')
    const [beeper] = result.candidates
    expect(beeper!.name).toBe('beeper')
    expect(beeper!.entry).toEqual({
      type: 'http',
      url: 'http://localhost:23373/v0/mcp',
      headers: { Authorization: 'Bearer ${input:beeper-authorization}' },
    })
    expect(beeper!.inputs.map(input => input.id)).toEqual(['beeper-authorization'])
    // The README placeholder is not a secret: storing it would make the server
    // look configured and fail at tool-call time.
    expect(beeper!.pendingSecrets).toEqual({})
    expect(beeper!.problems).toEqual([])
  })

  it('lifts a real token out of the stored entry entirely', () => {
    const result = importUserMcpConfig(BEEPER_HTTP_TOKEN.replace('YOUR_TOKEN_HERE', 'bpr_live_9f3a'))
    if (!result.ok) throw new Error(result.error)
    const [beeper] = result.candidates
    expect(JSON.stringify(beeper!.entry)).not.toContain('bpr_live_9f3a')
    expect(beeper!.pendingSecrets).toEqual({ 'beeper-authorization': 'bpr_live_9f3a' })
  })

  it('imports the mcp-remote stdio snippet, keeping the server-expanded ${VAR} in args', () => {
    const result = importUserMcpConfig(BEEPER_STDIO_TOKEN.replace('YOUR_TOKEN_HERE', 'tok'))
    if (!result.ok) throw new Error(result.error)
    const [beeper] = result.candidates
    expect(transportOf(beeper!.entry)).toBe('stdio')
    expect((beeper!.entry as { args: string[] }).args[3]).toBe('Authorization: Bearer ${ACCESS_TOKEN}')
    expect((beeper!.entry as { env: Record<string, string> }).env).toEqual({
      ACCESS_TOKEN: '${input:beeper-access_token}',
    })
    expect(beeper!.pendingSecrets).toEqual({ 'beeper-access_token': 'tok' })
    expect(beeper!.problems).toEqual([])
  })

  it('accepts the VS Code servers form and carries its password inputs', () => {
    expect(importUserMcpConfig(BEEPER_VSCODE)).toMatchObject({ ok: true, format: 'vscode' })
    const withInputs = importUserMcpConfig(JSON.stringify({
      inputs: [{ type: 'promptString', id: 'gh-token', description: 'GitHub PAT', password: true }],
      servers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${input:gh-token}' } } },
    }))
    if (!withInputs.ok) throw new Error(withInputs.error)
    expect(withInputs.candidates[0]!.inputs).toEqual([{ id: 'gh-token', description: 'GitHub PAT' }])
    expect(withInputs.candidates[0]!.problems).toEqual([])
  })

  it('accepts a bare map and a single bare entry', () => {
    const map = importUserMcpConfig('{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}')
    expect(map).toMatchObject({ ok: true, format: 'map', candidates: [{ name: 'playwright' }] })
    const entry = importUserMcpConfig('{"url":"https://mcp.linear.app/sse","type":"sse"}', 'linear')
    expect(entry).toMatchObject({ ok: true, format: 'entry', candidates: [{ name: 'linear' }] })
  })

  it('reports malformed JSON as a result, not a throw', () => {
    expect(importUserMcpConfig('{ "mcpServers": ')).toMatchObject({ ok: false })
    expect(importUserMcpConfig('[1,2]')).toMatchObject({ ok: false })
  })
})

describe('validateServer', () => {
  const http = { type: 'http' as const, url: 'http://localhost:23373/v0/mcp' }

  it('rejects names that would break Codex -c paths or collide with Agent Code', () => {
    expect(validateServer({ name: 'my.server', entry: http, inputs: [] })[0]?.kind).toBe('invalid-name')
    expect(validateServer({ name: 'AGENT_CODE', entry: http, inputs: [] })[0]?.kind).toBe('reserved-name')
    expect(validateServer({ name: 'agent-code-control', entry: http, inputs: [] })[0]?.kind).toBe('reserved-name')
    expect(
      validateServer({ name: 'Beeper', entry: http, inputs: [] }, [{ id: 'x', name: 'beeper' }])[0]?.kind,
    ).toBe('duplicate-name')
  })

  it('allows secrets only where they can travel through the environment', () => {
    const inputs = [{ id: 't', description: '' }]
    expect(validateServer({ name: 'a', entry: { command: 'srv', env: { T: '${input:t}' } }, inputs }, [])).toEqual([])
    expect(validateServer({ name: 'a', entry: { ...http, headers: { A: 'Bearer ${input:t}' } }, inputs }, [])).toEqual([])
    const inArgs = validateServer({ name: 'a', entry: { command: 'srv', args: ['--key', '${input:t}'] }, inputs }, [])
    expect(inArgs.map(problem => problem.kind)).toEqual(['secret-in-forbidden-field'])
    const inUrl = validateServer({ name: 'a', entry: { type: 'http', url: 'https://x.dev/?k=${input:t}' }, inputs }, [])
    expect(inUrl.map(problem => problem.kind)).toContain('secret-in-forbidden-field')
  })

  it('flags references to secrets that were never defined', () => {
    const problems = validateServer({ name: 'a', entry: { ...http, headers: { A: '${input:nope}' } }, inputs: [] })
    expect(problems.map(problem => problem.kind)).toEqual(['unknown-input'])
  })

  it('rejects mixed and empty transports', () => {
    expect(validateServer({ name: 'a', entry: { command: 'x', url: 'http://y' } as never, inputs: [] })[0]?.kind)
      .toBe('invalid-entry')
    expect(validateServer({ name: 'a', entry: {} as never, inputs: [] })[0]?.kind).toBe('invalid-entry')
  })
})

describe('providerSupport', () => {
  it('keeps SSE servers Claude-only because Codex has no SSE transport', () => {
    expect(providerSupport('sse').codex).toEqual({ ok: false, reason: 'Codex does not support SSE servers' })
    expect(providerSupport('sse').claude).toEqual({ ok: true })
    expect(providerSupport('http').codex).toEqual({ ok: true })
  })
})

describe('coerceUserMcpDocument', () => {
  it('keeps unknown entry keys and malformed servers instead of dropping user work', () => {
    const doc = coerceUserMcpDocument({
      version: 1,
      servers: [
        { id: 'a1', name: 'beeper', enabled: true, providers: { claude: true }, entry: { url: 'http://x', oauth: { clientId: 'c' } }, inputs: [] },
        { id: 'b2', name: 'bad name!', entry: 'nonsense' },
        { name: 'no id at all' },
      ],
    })
    expect(doc.servers.map(server => server.id)).toEqual(['a1', 'b2'])
    expect(doc.servers[0]!.entry).toMatchObject({ oauth: { clientId: 'c' } })
    expect(doc.servers[0]!.providers).toEqual({ claude: true, codex: false })
    expect(doc.servers[1]!.entry).toEqual({})
  })

  it('treats anything that is not a document as empty', () => {
    expect(coerceUserMcpDocument(null)).toEqual({ version: 1, servers: [] })
    expect(coerceUserMcpDocument({ servers: 'x' })).toEqual({ version: 1, servers: [] })
  })
})

describe('substituteInputs', () => {
  it('refuses a partially resolved value rather than emitting an empty credential', () => {
    expect(substituteInputs('Bearer ${input:t}', { t: 'abc' })).toBe('Bearer abc')
    expect(substituteInputs('Bearer ${input:t}', {})).toBeNull()
    expect(substituteInputs('Bearer ${input:t}', { t: '' })).toBeNull()
  })
})

describe('user override keys', () => {
  it('extracts only well-formed user: keys from a pane override map', () => {
    expect(userMcpOverridesFrom({
      tldr: true,
      [userMcpOverrideKey('abc-123')]: false,
      'user:bad id': true,
      'user:x': 'yes',
    })).toEqual({ 'abc-123': false })
  })
})

describe('review round 1 model rules', () => {
  it('rejects env and header names Codex cannot address', () => {
    expect(validateServer({ name: 'a', entry: { command: 'x', env: { 'java.home': '/opt' } }, inputs: [] })[0]?.message).toMatch(/java\.home/)
    expect(validateServer({ name: 'a', entry: { type: 'http', url: 'https://x.dev/mcp', headers: { 'X-Foo.Bar': 'v' } }, inputs: [] })[0]?.message).toMatch(/X-Foo\.Bar/)
  })

  it('treats the ${VAR} environment idiom as a placeholder, not a secret value', () => {
    const result = importUserMcpConfig('{"mcpServers":{"gh":{"command":"npx","env":{"GITHUB_TOKEN":"${GITHUB_TOKEN}"}}}}')
    if (!result.ok) throw new Error(result.error)
    expect(result.candidates[0]!.pendingSecrets).toEqual({})
  })

  it('never shows a credential-looking URL path or query in summaries', () => {
    expect(summarizeEntry({ type: 'http', url: 'https://mcp.zapier.com/api/mcp/s/abcdefghijklmnopqrstuvwxyz0123456789/mcp' }))
      .toBe('mcp.zapier.com/api/mcp/s/…/mcp')
    expect(summarizeEntry({ type: 'http', url: 'https://x.dev/mcp?key=secret' })).toBe('x.dev/mcp?…')
    expect(summarizeEntry({ type: 'http', url: 'http://localhost:23373/v0/mcp' })).toBe('localhost:23373/v0/mcp')
  })
})


describe('review round 2 model rules', () => {
  it('gives a hand-written ${input:} reference a secret field instead of failing save', () => {
    const result = importUserMcpConfig('{"mcpServers":{"b":{"url":"http://localhost:23373/v0/mcp","headers":{"Authorization":"Bearer ${input:b-auth}"}}}}')
    if (!result.ok) throw new Error(result.error)
    expect(result.candidates[0]!.inputs.map(input => input.id)).toEqual(['b-auth'])
    expect(result.candidates[0]!.problems).toEqual([])
  })

  it('elides the value that follows a sensitive flag', () => {
    expect(summarizeEntry({ command: 'srv', args: ['--api-key', 'd6f8g2h9', '--port', '8080'] })).toBe('srv … … --port 8080')
  })

  it('counts every literal as part of where secrets go, but not which secret a value references', () => {
    const base = { command: 'npx', env: { T: '${input:a}' } }
    expect(userMcpDestination(base)).toBe(userMcpDestination({ command: 'npx', env: { T: '${input:b}' } }))
    expect(userMcpDestination(base)).not.toBe(userMcpDestination({ command: 'npx', env: { T: '${input:a}', NODE_OPTIONS: '--require x' } }))
  })
})
