import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

// Both views send Root Management prompts through the same SessionManager
// entry. The fitted Terminal view can give Codex 40 columns, whereas the
// headless Agent view usually gives it enough space for the full shortcut hint.
// Vitest runs in Node. SessionManager also resolves its bundled helpers at
// spawn, which requires Electron's app path even for a Codex-only fixture.
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => process.env.HOME } }))

const live = it.skipIf(process.env.CODEX_ROOT_PROMPT_LIVE !== '1')

live.each([24, 40, 120])('delivers into an empty %i-column native Codex pane and preserves a real draft', async cols => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'codex-root-prompt-')))
  const config = join(home, '.codex')
  const cwd = join(home, 'workspace')
  const prompt = 'Root prompt local fixture'
  let manager: import('@main/sessionManager').SessionManager | undefined
  try {
    vi.stubEnv('HOME', home)
    vi.stubEnv('CODEX_HOME', config)
    vi.stubEnv('CODEX_ROOT_PROMPT_FIXTURE_KEY', 'local-fixture')
    await Promise.all([mkdir(cwd), mkdir(config)])
    await writeFile(join(config, 'config.toml'), [
      'model = "gpt-6-sol"', 'model_provider = "local_fixture"',
      '[model_providers.local_fixture]', 'name = "Local fixture"', 'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"', 'env_key = "CODEX_ROOT_PROMPT_FIXTURE_KEY"',
      `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"',
    ].join('\n'))
    const { SessionManager } = await import('@main/sessionManager')
    manager = new SessionManager()
    const host = manager
    function replyToTerminalQueries(sessionId: string, data: string) {
      if (data.includes('\x1b[6n')) host.write(sessionId, '\x1b[1;1R')
      if (data.includes('\x1b[c')) host.write(sessionId, '\x1b[?1;2c')
    }
    host.on('agent-pty-data', ({ sessionId, data }) => replyToTerminalQueries(sessionId, data))
    for (const hasDraft of [true, false]) {
      const { sessionId } = await host.spawn({ kind: 'codex', cwd, cols, rows: 44, useProxy: false })
      replyToTerminalQueries(sessionId, host.attachAgentPty(sessionId) ?? '')
      const screen = () => host.getScreenSnapshot(sessionId)?.plain ?? ''
      await vi.waitFor(() => expect(screen()).toMatch(/^  ← for agents\b/m), { timeout: 15_000 })
      const placeholder = /^› (.+)$/m.exec(screen())?.[1]?.trim()
      if (!placeholder) throw new Error('Expected the native Codex placeholder at the editor cursor')
      if (hasDraft) {
        // The same words can be either a dim suggestion or human-entered text.
        // Wait for Codex's hint to leave so the subsequent receipt is decisive.
        host.write(sessionId, placeholder)
        await vi.waitFor(() => {
          expect(screen()).toContain(`› ${placeholder}`)
          expect(screen()).not.toMatch(/^  ← for agents\b/m)
        })
      }

      const result = await host.deliverPromptToAgent(sessionId, prompt)
      if (hasDraft) {
        expect(result).toMatchObject({
          ok: false, stage: 'before-write', code: 'not-ready', disposition: 'retry-after-resolve',
          promptWritten: false, enterWritten: false,
        })
        expect(screen()).toContain(`› ${placeholder}`)
        expect(screen()).not.toContain(prompt)
      } else {
        expect(result, JSON.stringify({ result, footer: screen().split('\n').filter(Boolean).slice(-4) })).toMatchObject({ ok: true, acceptance: { kind: 'transport' } })
        // A transport receipt alone cannot establish that Codex committed the
        // text. Its local rollout does, independent of the fixture's closed
        // endpoint and independent of Agent Code's transcript attachment.
        const sessionsDir = join(config, 'sessions')
        await vi.waitFor(async () => {
          const names = await readdir(sessionsDir, { recursive: true })
          const records = await Promise.all(names.filter(name => name.endsWith('.jsonl'))
            .map(name => readFile(join(sessionsDir, name), 'utf8')))
          expect(records.some(data => data.split('\n').some(line => {
            if (!line.includes(prompt)) return false
            try {
              const row = JSON.parse(line)
              return row.type === 'response_item' && row.payload?.role === 'user' &&
                row.payload.content?.some((block: { text?: string }) => block.text === prompt)
            } catch { return false }
          }))).toBe(true)
        }, { timeout: 8_000 })
      }
      await host.kill(sessionId)
    }
  } finally {
    await manager?.killAll()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 55_000)
