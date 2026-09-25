import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agentCodeBridge from 'pi-terminal-headless/bridge/extension'
import { BridgeServer } from 'pi-terminal-headless/live/BridgeServer'
import { loadLiveFixture, toJsonl } from 'pi-terminal-headless/testing/index'

import { addPiBuiltInMcpLaunchConfig } from '@providers/shared/runtime/builtInMcpLaunch.js'

// A Pi pane's Agent Code tools, end to end minus the model: the REAL built-in
// MCP host (bearer auth, per-request stateless server, SSE replies) serving
// the REAL tool implementations, handed to the REAL bridge extension through
// the exact launch environment PiSession builds. Pi itself is faked with the
// ExtensionAPI surface the bridge uses; the live tier puts the same bridge
// inside the real pi. The tool exercised reads a recorded Pi session, so the
// answer proves the call reached the host's implementation.

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))
const { BuiltInMcpHttpHost } = await import('@mcp/runtime/BuiltInMcpHttpHost.js')

const STATE_KEY = Symbol.for('agent-code.pi-bridge')
type Handler = (event: any, ctx: any) => unknown
class FakePi {
  handlers = new Map<string, Handler[]>()
  tools = new Map<string, any>()
  on(name: string, handler: Handler): () => void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
    return () => undefined
  }
  registerTool(tool: any): void { this.tools.set(tool.name, tool) }
  sendUserMessage(): void {}
  fire(name: string, event: any, ctx: any): unknown[] {
    return (this.handlers.get(name) ?? []).map(handler => handler({ type: name, ...event }, ctx))
  }
}
const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => 's', getSessionFile: () => '/s.jsonl', getLeafId: () => null } }

let dir: string
let bridge: BridgeServer
let host: InstanceType<typeof BuiltInMcpHttpHost>
const launchVariables: string[] = []

beforeEach(async () => {
  delete (globalThis as any)[STATE_KEY]
  dir = mkdtempSync(join(tmpdir(), 'pi-mcp-'))
  const socketDir = mkdtempSync('/tmp/acpi-a-')
  const token = randomBytes(16).toString('hex')
  bridge = new BridgeServer(join(socketDir, 's'), token)
  await bridge.listen()
  process.env.AGENT_CODE_PI_BRIDGE_SOCKET = join(socketDir, 's')
  process.env.AGENT_CODE_PI_BRIDGE_TOKEN = token
  host = new BuiltInMcpHttpHost()
  await host.start()
})

afterEach(async () => {
  await bridge.close()
  await host.stop()
  delete (globalThis as any)[STATE_KEY]
  for (const key of ['AGENT_CODE_PI_BRIDGE_SOCKET', 'AGENT_CODE_PI_BRIDGE_TOKEN', ...launchVariables.splice(0)]) delete process.env[key]
  rmSync(dir, { recursive: true, force: true })
})

describe('Agent Code built-in MCP in a Pi pane', () => {
  it('the launch env carries no bearer in its JSON; the bridge registers the host’s tools and a call runs the real tool', async () => {
    const servers = host.registerSession({ sessionId: 'pi-pane', cwd: dir, providerKind: 'pi', domains: ['agent_transcripts'] })
    expect(servers).toHaveLength(1)
    const env: Record<string, string> = {}
    addPiBuiltInMcpLaunchConfig(servers, env)
    expect(env.AGENT_CODE_PI_MCP_SERVERS).not.toContain(servers[0]!.bearerToken!)
    expect(Object.values(env)).toContain(`Bearer ${servers[0]!.bearerToken}`)
    launchVariables.push(...Object.keys(env))
    Object.assign(process.env, env)

    const pi = new FakePi()
    agentCodeBridge(pi)
    // Read and scrubbed at load: the model's bash tool inherits this env.
    for (const key of Object.keys(env)) expect(process.env[key]).toBeUndefined()
    pi.fire('session_start', { reason: 'startup' }, ctx)
    await Promise.all(pi.fire('before_agent_start', { prompt: 'x', systemPrompt: '', systemPromptOptions: {} }, ctx))

    const readTool = [...pi.tools.keys()].find(name => name.endsWith('__agent_transcript_read_file'))
    expect(readTool).toMatch(/^mcp__[A-Za-z0-9_-]+__agent_transcript_read_file$/)
    expect([...pi.tools.keys()].every(name => name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name))).toBe(true)

    const file = join(dir, 'tool.jsonl')
    writeFileSync(file, toJsonl(Object.values(loadLiveFixture('tool').files)[0]!))
    const result = await pi.tools.get(readTool!).execute('call-1', { path: file, projection: 'final' }, undefined)
    const payload = JSON.parse(result.content[0].text)
    expect(payload).toMatchObject({ ok: true, provider: 'pi' })
    expect(payload.items.at(-1)).toMatchObject({ kind: 'assistant_message', text: 'Tool finished. Done.' })
  })

  it('a revoked registration (the pane was closed) fails the call instead of reaching the tool', async () => {
    const servers = host.registerSession({ sessionId: 'pi-closing', cwd: dir, providerKind: 'pi', domains: ['agent_transcripts'] })
    const env: Record<string, string> = {}
    addPiBuiltInMcpLaunchConfig(servers, env)
    launchVariables.push(...Object.keys(env))
    Object.assign(process.env, env)
    const pi = new FakePi()
    agentCodeBridge(pi)
    pi.fire('session_start', { reason: 'startup' }, ctx)
    await Promise.all(pi.fire('before_agent_start', { prompt: 'x', systemPrompt: '', systemPromptOptions: {} }, ctx))
    const readTool = [...pi.tools.keys()].find(name => name.endsWith('__agent_transcript_read_file'))!
    host.revokeSession('pi-closing')
    await expect(pi.tools.get(readTool).execute('call-2', { path: join(dir, 'x.jsonl') }, undefined)).rejects.toThrow(/HTTP 40[13]/)
  })
})
