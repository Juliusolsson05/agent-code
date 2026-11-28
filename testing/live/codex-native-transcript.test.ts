import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { asRecord } from '@shared/lib/asRecord'
import type { CodexSession } from '@providers/codex/runtime/codexSession'

// Only local fake-provider traffic. The two real TUIs share a trusted cwd and
// Codex home, just like neighbouring terminal panes; only the launch differs.
it.skipIf(process.env.CODEX_NATIVE_TRANSCRIPT_LIVE !== '1')('attaches each native pane to its own user turn and preserves personal hooks', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'codex-identity-live-')))
  const configDir = join(home, '.codex')
  const cwd = join(home, 'workspace')
  const configPath = join(configDir, 'config.toml')
  const userLog = join(home, 'user-hooks')
  const sessions: CodexSession[] = []
  try {
    vi.stubEnv('HOME', home)
    vi.stubEnv('CODEX_HOME', configDir)
    vi.stubEnv('CODEX_NATIVE_FIXTURE_KEY', 'local-fixture')
    await Promise.all([mkdir(cwd), mkdir(configDir)])
    const { CodexSession } = await import('@providers/codex/runtime/codexSession')
    const { codexHookTrustHash } = await import('@providers/shared/runtime/tldrHooks')
    const userHook = { type: 'command' as const, command: `echo called >> '${userLog}'`, timeout: 10, async: false }
    await writeFile(configPath, [
      'model = "gpt-6-sol"', 'model_provider = "local_fixture"',
      '[model_providers.local_fixture]', 'name = "Local fixture"', 'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"', 'env_key = "CODEX_NATIVE_FIXTURE_KEY"',
      `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"',
      '[hooks]', `SessionStart=[{hooks=[{type="command",command=${JSON.stringify(userHook.command)},timeout=10,async=false}]}]`,
      `[hooks.state.${JSON.stringify(`${configPath}:session_start:0:0`)}]`,
      `trusted_hash=${JSON.stringify(codexHookTrustHash('session_start', userHook))}`,
    ].join('\n'))
    const panes = ['first native smoke', 'second native smoke'].map(marker => {
      const session = new CodexSession({ cwd, cols: 120, rows: 40, useProxy: false })
      sessions.push(session)
      const ids = new Set<string>()
      const prompts = new Set<string>()
      session.on('pty-data', data => {
        if (data.includes('\x1b[6n')) session.write('\x1b[1;1R')
        if (data.includes('\x1b[c')) session.write('\x1b[?1;2c')
      })
      session.on('jsonl-entry', (entry) => {
        const payload = asRecord(entry.payload)
        if (!payload) return
        if (entry.type === 'session_meta' && typeof payload.id === 'string') ids.add(payload.id)
        if (entry.type === 'response_item' && payload.role === 'user' && Array.isArray(payload.content)) {
          for (const item of payload.content) {
            const part = asRecord(item)
            if (part?.type === 'input_text' && typeof part.text === 'string' && /native smoke$/.test(part.text)) prompts.add(part.text)
          }
        }
      })
      return { session, marker, ids, prompts }
    })
    await Promise.all(panes.map(async ({ session, marker }) => {
      await session.start()
      await vi.waitFor(() => expect(session.snapshotScreen()).toMatch(/for shortcuts/), { timeout: 20_000 })
      session.write(marker)
      await vi.waitFor(() => expect(session.snapshotScreen()).toContain(marker), { timeout: 5_000 })
      session.write('\r')
    }))
    for (const pane of panes) {
      await vi.waitFor(() => expect([...pane.prompts]).toEqual([pane.marker]), { timeout: 20_000 })
      expect(pane.ids.size).toBe(1)
    }
    expect(new Set(panes.flatMap(pane => [...pane.ids])).size).toBe(2)
    expect((await readFile(userLog, 'utf8')).trim().split('\n')).toHaveLength(2)
  } finally {
    await Promise.allSettled(sessions.map(session => session.stop()))
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 65_000)
