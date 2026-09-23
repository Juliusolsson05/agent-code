import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { preparePiTerminalLaunch } from 'pi-terminal-headless'

import type { AgentTranscriptEntry } from '@shared/types/session.js'

// The Pi provider against the REAL pi, the whole app-side runtime path at
// once: PiSession (the adapter main constructs), the real launch helper, the
// real bridge extension file Agent Code ships, prompt delivery through
// deliverPiPrompt, Agent Code's REAL built-in MCP host serving a real tool,
// /compact through the bridge, and the pane following /new inside the TUI.
//
//   PI_APP_LIVE=1 PI_BINARY=/abs/pi NODE_PTY_PATH=<node-ABI node-pty> npm run test:live -- src/providers/pi/runtime/piSession.live.test.ts
//
// The only edges replaced are the model and the PTY binding. Pi's own faux
// provider (the Stage 0 probe extension, no login or network) is added
// through the launch helper's extraArgs. node-pty comes from a Node-ABI
// build, because the app's copy is compiled for Electron. Everything runs in
// a throwaway HOME and PI_CODING_AGENT_DIR.

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn(), mark: vi.fn(), error: vi.fn(), metric: vi.fn() } }))

const LIVE = process.env.PI_APP_LIVE === '1' && Boolean(process.env.PI_BINARY) && Boolean(process.env.NODE_PTY_PATH)
const PACKAGE = fileURLToPath(new URL('../../../../packages/pi-terminal-headless/', import.meta.url))

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

type Entry = AgentTranscriptEntry & Record<string, any>
const messageText = (entry: Entry) => {
  const content = entry.message?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map((block: any) => block.type === 'text' ? block.text : '').join('') : ''
}

describe.skipIf(!LIVE)('PiSession inside the real pi', () => {
  it('delivers prompts, runs a real Agent Code MCP tool, compacts through the bridge, and follows /new', async () => {
    const { PiSession } = await import('./piSession.js')
    const { deliverPiPrompt } = await import('./promptDelivery.js')
    const { BuiltInMcpHttpHost } = await import('@mcp/runtime/BuiltInMcpHttpHost.js')
    const require = createRequire(import.meta.url)
    const pty = require(process.env.NODE_PTY_PATH!) as typeof import('node-pty')

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-app-live-')))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    for (const dir of ['home', 'agent', 'project']) mkdirSync(join(root, dir), { recursive: true })
    // keepRecentTokens 1: faux replies are a few tokens, and pi refuses to
    // compact a session "too small" (the Stage 0 compaction scenario does the same).
    writeFileSync(join(root, 'agent', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }) + '\n')

    const host = new BuiltInMcpHttpHost()
    await host.start()
    cleanups.push(() => host.stop())
    const servers = host.registerSession({ sessionId: 'live-pane', cwd: join(root, 'project'), providerKind: 'pi', domains: ['agent_transcripts'] })
    expect(servers).toHaveLength(1)

    const session = new PiSession({
      cwd: join(root, 'project'),
      binary: process.env.PI_BINARY!,
      builtInMcpServers: servers,
      env: { HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    } as never, {
      spawnPty: pty.spawn as never,
      bridgeScriptPath: join(PACKAGE, 'src', 'bridge', 'extension.ts'),
      prepareLaunch: options => preparePiTerminalLaunch({
        ...options,
        extraArgs: ['--provider', 'faux', '--model', 'faux-1', '-e', join(PACKAGE, 'scripts', 'probe', 'faux.ts')],
      }),
    })
    const entries: Entry[] = []
    const semantic: string[] = []
    const switches: Array<{ providerSessionId: string; reason: string }> = []
    const diagnostics: Array<Record<string, unknown>> = []
    session.on('jsonl-entry', (entry: AgentTranscriptEntry) => entries.push(entry as Entry))
    session.on('semantic-event', (event: unknown) => { semantic.push((event as { type: string }).type) })
    session.on('provider-session-changed', (change: { providerSessionId: string; reason: string }) => switches.push(change))
    session.on('transcript-diagnostic', (diagnostic: unknown) => { diagnostics.push(diagnostic as Record<string, unknown>) })
    cleanups.push(() => session.stop())
    await session.start()
    await until(() => diagnostics.some(diagnostic => diagnostic.kind === 'pi-terminal-live-state' && diagnostic.connected === true), 'the bridge to connect')
    const firstSession = session.getProviderSessionId()

    const deliver = (prompt: string) => deliverPiPrompt({ session, sessionId: 'live-pane', prompt } as never)
    const turnsDone = () => semantic.filter(type => type === 'turn_completed').length

    // 1. An ordinary prompt: accepted by pi's own evidence, committed, answered.
    const hello = 'hello [probe:app-live]'
    await expect(deliver(hello)).resolves.toMatchObject({ ok: true })
    await until(() => turnsDone() === 1, 'the first turn')
    // The faux model's documented default reply (scripts/probe/faux.ts).
    expect(entries.map(messageText)).toEqual(expect.arrayContaining([hello, `Reply to a ${hello.length}-character prompt.`]))

    // 2. A second ordinary turn, then /compact: pi's own compaction, never a
    //    user message. (Before any [call:] prompt on purpose: pi asks the model
    //    to SUMMARIZE the conversation, and the faux model would answer a
    //    marker it finds in that text with a tool call, which pi rightly
    //    refuses as a summary. That is a limit of the scripted model, not of
    //    the path under test.)
    await expect(deliver('again [probe:app-live]')).resolves.toMatchObject({ ok: true })
    await until(() => turnsDone() === 2, 'the second turn')
    await expect(deliver('/compact')).resolves.toMatchObject({ ok: true })
    await until(() => entries.some(entry => entry.type === 'compaction'), 'the compaction row')
    expect(entries.some(entry => entry.message?.role === 'user' && messageText(entry).includes('/compact'))).toBe(false)

    // 3. A real Agent Code MCP tool, through the bridge's proxy, with the
    //    bearer from the launch env: the transcript inspector, pointed at
    //    this very session's file. The real host's tool then reads a real Pi
    //    transcript with the Pi reader, which is what a parent agent does to
    //    a Pi child.
    const toolName = `mcp__${servers[0]!.name.replace(/[^A-Za-z0-9_-]/g, '_')}__agent_transcript_inspect_file`
    const ownFile = session.getTranscriptFile()!
    await expect(deliver(`inspect yourself [call:${toolName} ${JSON.stringify({ path: ownFile })}]`)).resolves.toMatchObject({ ok: true })
    await until(() => turnsDone() === 3, 'the tool turn')
    const result = entries.find(entry => entry.message?.role === 'toolResult')
    expect(result?.message).toMatchObject({ toolName, isError: false })
    expect(JSON.parse(messageText(result!))).toMatchObject({ ok: true, provider: 'pi' })

    // 4. /new typed into the TUI: the pane follows pi into the new session.
    session.write('/new')
    session.write('\r')
    await until(() => switches.length === 1, 'the session switch')
    expect(switches[0]).toMatchObject({ reason: 'new' })
    expect(switches[0]!.providerSessionId).not.toBe(firstSession)
    expect(session.getProviderSessionId()).toBe(switches[0]!.providerSessionId)
    // …and prompts reach the NEW session.
    const before = entries.length
    await expect(deliver('in the new session')).resolves.toMatchObject({ ok: true })
    await until(() => turnsDone() >= 4 && entries.slice(before).some(entry => messageText(entry) === 'in the new session'), 'a turn in the new session')
  }, 120_000)
})
