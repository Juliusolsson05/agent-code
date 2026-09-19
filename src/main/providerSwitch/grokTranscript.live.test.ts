import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { decodeGrokConversation, projectGrokNativeResume } from 'agent-transcript-parser'
import { GrokHeadless, GrokNativeControl, GrokTuiSocketGuard, prepareGrokTerminalLaunch } from 'grok-code-headless'
import { readGrokTranscript, writeProjectedGrokSession } from './grokTranscript.js'

// This launches the installed CLI, not Electron or the Agent Code app. Unlike
// the parser's native probe, the production APP publisher creates the files.
// The backend is loopback fixture replay; no production auth/home is inherited.
//
// Migrated to the Stage 3 runtime shape: this side of the package owns every
// process now (leader over control, terminal socket guard, terminal PTY), and
// GrokHeadless only observes. The order below is exactly the app session order
// the recordings pin (leader → session over control → guard → prepared launch
// → PTY → attach → re-seed on terminal-loaded), which is what makes this an
// integration gate for the app's file-set publisher, not just the package.
it('native Grok resumes the app-published file set and sends imported context before appending a reply', async context => {
  if (process.env.GROK_APP_FILES_LIVE !== '1') context.skip('Set GROK_APP_FILES_LIVE=1 for the native app file-set integration gate')
  const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
  if (!existsSync(binary)) context.skip('Installed Grok CLI unavailable')
  const root = await mkdtemp(join(tmpdir(), 'grok-app-native-files-'))
  const home = join(root, 'home')
  await mkdir(home)
  vi.stubEnv('GROK_HOME', home)
  const sessionId = randomUUID()
  const fixtureRoot = new URL('../../../packages/', import.meta.url)
  const recorded = await readFile(new URL('agent-transcript-parser/fixtures/evidence/grok/command.jsonl', fixtureRoot), 'utf8')
  const response = await readFile(new URL('grok-code-headless/testing/fixtures/streaming/native-papaya.sse', fixtureRoot))
  const projected = projectGrokNativeResume(decodeGrokConversation(recorded.trimEnd().split('\n').map(line => JSON.parse(line))), {
    cwd: root, targetSessionId: sessionId, now: new Date().toISOString(), model: 'grok-4.6',
  })
  let importedContext = false
  let nativeSystem = false
  let runtime: GrokHeadless | undefined
  let exited = false
  const server = createServer(async (request, reply) => {
    if (request.url?.startsWith('/v1/models')) {
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify({ data: [{ id: 'grok-4.6', model: 'grok-4.6', api_backend: 'responses', context_window: 500000 }] }))
    } else if (request.url === '/v1/responses') {
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 2 * 1024 * 1024) { reply.writeHead(413); reply.end(); return }
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const input = JSON.stringify(body.input)
        importedContext ||= input.includes('call_fixture') && input.includes('PERMISSION_PROBE.txt') && input.includes('exit: 0')
        nativeSystem ||= body.input?.[0]?.role === 'system' && !input.includes('[Native system instructions omitted]')
        reply.writeHead(200, { 'content-type': 'text/event-stream' })
        reply.end(response)
      } catch { reply.writeHead(400); reply.end() }
    } else { reply.writeHead(200, { 'content-type': 'application/json' }); reply.end('{}') }
  })
  // The app-owned helpers, torn down in reverse order in the finally block.
  let control: GrokNativeControl | undefined
  let guard: GrokTuiSocketGuard | undefined
  let pty: import('node-pty').IPty | undefined
  let ptyExit = Promise.resolve()
  try {
    const path = await writeProjectedGrokSession(root, projected)
    await writeFile(join(home, 'config.toml'), '[cli]\nauto_update = false\n')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback address')
    const base = `http://127.0.0.1:${address.port}/v1`
    // WHY an allowlist rather than the inherited environment: this gate must not
    // touch production auth or caches. The leader env is passed the same way the
    // app session will pass it (inheritEnv: false + explicit values).
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      XAI_API_KEY: 'fixture-only-not-a-real-key',
      GROK_MODELS_BASE_URL: base,
      GROK_XAI_API_BASE_URL: base,
      GROK_CLI_CHAT_PROXY_BASE_URL: base,
      OTEL_TRACES_EXPORTER: 'none',
      GROK_HOME: home,
    }
    control = await GrokNativeControl.start({ binary, cwd: root, env, inheritEnv: false })
    // The conversation already exists on disk (the app publisher wrote it), so
    // this is the resume path: load over control, terminal attaches with
    // --resume, and the headless reader marks first-generation rows as rewrite
    // snapshot content.
    await control.loadSession(sessionId, [])
    guard = await GrokTuiSocketGuard.create({ upstreamPath: control.socketPath, expectedPid: control.pid!, onFault: () => {} })
    const launch = prepareGrokTerminalLaunch({ binary, env, sessionId, guardSocketPath: guard.socketPath })
    const requirePty = await import('node-pty')
    pty = requirePty.spawn(launch.binary, launch.args, { cwd: root, env: launch.env, name: 'xterm-256color', cols: 120, rows: 40 })
    ptyExit = new Promise(resolve => { pty!.onExit(() => resolve()) })
    runtime = new GrokHeadless({ pty, cwd: root, launch, control: { get isClosed() { return control!.isClosed }, rpc: control!, observe: observer => control!.observe(observer) }, guard, resume: true, grokHome: home })
    runtime.on('exit', () => { exited = true })
    let painted = false
    let appended = false
    // First PTY output replaces the legacy screen-paint signal: it proves the
    // terminal reached its UI without resurrecting the screen channel.
    pty.onData(() => { painted = true })
    runtime.on('entry', event => { if (!event.inRewriteSnapshot && event.item.type === 'assistant' && event.item.content === 'PAPAYA') appended = true })
    // The terminal's attach load clears the MCP set; the app re-seeds here. This
    // gate seeds an empty set (no MCP in this probe), but the order is pinned.
    const reseeded = new Promise<void>(resolve => { runtime!.once('terminal-loaded', () => resolve()) })
    await runtime.start()
    await vi.waitFor(() => expect(painted && !exited).toBe(true), { timeout: 15000 })
    await reseeded
    // Controlled input in this specific native-load probe is not a general
    // composer-readiness contract. That requires separate modal/draft evidence.
    // Acceptance-based delivery: submitPrompt resolves when native admits the
    // prompt to its queue, not when bytes are pasted.
    const submitted = await runtime.submitPrompt('What command did we previously run? Reply PAPAYA without using tools.')
    expect(submitted.ok).toBe(true)
    await vi.waitFor(() => expect(importedContext && nativeSystem && appended).toBe(true), { timeout: 45000 })
    expect((await readGrokTranscript(root, sessionId)).entries.some(entry => entry.kind === 'message' && entry.role === 'assistant' && entry.content.some(part => part.kind === 'text' && part.text === 'PAPAYA'))).toBe(true)
    expect(await readFile(path, 'utf8')).toContain('PAPAYA')
    expect(existsSync(join(root, 'PERMISSION_PROBE.txt')), 'importing historical tool calls must not execute them').toBe(false)
  } finally {
    try {
      await runtime?.stop()
      try { pty?.kill() } catch { /* the process may have won the exit race */ }
      try { if (guard) await guard.dispose(() => ptyExit) } catch { /* best-effort socket release */ }
      await control?.dispose()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      vi.unstubAllEnvs()
      if (!runtime || exited) await rm(root, { recursive: true, force: true })
    }
  }
}, 75000)
