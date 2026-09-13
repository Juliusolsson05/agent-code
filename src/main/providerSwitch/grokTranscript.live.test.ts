import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { decodeGrokConversation, projectGrokNativeResume } from 'agent-transcript-parser'
import { GrokHeadless } from 'grok-code-headless'
import { readGrokTranscript, writeProjectedGrokSession } from './grokTranscript.js'

// This launches the installed CLI, not Electron or the Agent Code app. Unlike
// the parser's native probe, the production APP publisher creates the files.
// The backend is loopback fixture replay; no production auth/home is inherited.
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
  try {
    const path = await writeProjectedGrokSession(root, projected)
    await writeFile(join(home, 'config.toml'), '[cli]\nauto_update = false\n')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback address')
    const base = `http://127.0.0.1:${address.port}/v1`
    const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
    Object.assign(env, { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, '.config'), XAI_API_KEY: 'fixture-only-not-a-real-key', GROK_MODELS_BASE_URL: base, GROK_XAI_API_BASE_URL: base, GROK_CLI_CHAT_PROXY_BASE_URL: base, OTEL_TRACES_EXPORTER: 'none' })
    runtime = new GrokHeadless({ cwd: root, grokHome: home, grokBinary: binary, resumeSessionId: sessionId, env })
    runtime.on('exit', () => { exited = true })
    let painted = false
    let appended = false
    runtime.on('screen', () => { painted = true })
    runtime.on('grok-entry', event => { if (!event.replay && event.item.type === 'assistant' && event.item.content === 'PAPAYA') appended = true })
    await vi.waitFor(() => expect(painted && !exited).toBe(true), { timeout: 15000 })
    // Controlled input in this specific native-load probe is not a general
    // composer-readiness contract. That requires separate modal/draft evidence.
    runtime.sendPrompt('What command did we previously run? Reply PAPAYA without using tools.')
    await vi.waitFor(() => expect(importedContext && nativeSystem && appended).toBe(true), { timeout: 45000 })
    await runtime.dispose()
    expect((await readGrokTranscript(root, sessionId)).entries.some(entry => entry.kind === 'message' && entry.role === 'assistant' && entry.content.some(part => part.kind === 'text' && part.text === 'PAPAYA'))).toBe(true)
    expect(await readFile(path, 'utf8')).toContain('PAPAYA')
    expect(existsSync(join(root, 'PERMISSION_PROBE.txt')), 'importing historical tool calls must not execute them').toBe(false)
  } finally {
    try { await runtime?.dispose() }
    finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      vi.unstubAllEnvs()
      if (!runtime || exited) await rm(root, { recursive: true, force: true })
    }
  }
}, 75000)
