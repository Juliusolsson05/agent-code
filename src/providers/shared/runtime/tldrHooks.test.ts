import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'
import {
  CLAUDE_TLDR_HOOK_TOKEN_ENV,
  CODEX_SESSION_FLAGS_HOOK_SOURCE,
  claudeTldrHookSettings,
  codexHookTrustHash,
  createCodexTldrHooks,
  tldrHookServer,
} from './tldrHooks'

const baseUrl = 'http://127.0.0.1:4321/hooks/tldr'
const server = (overrides: Partial<BuiltInMcpServerConfig> = {}): BuiltInMcpServerConfig => ({
  name: 'agent_code', url: 'http://127.0.0.1:4321/mcp', bearerToken: 'session-secret-token', headers: {},
  tldrHooks: { baseUrl }, ...overrides,
})

describe('Codex hook trust hash', () => {
  it('matches the hash Codex itself reports for the injected hook', () => {
    // Vector captured from Codex 0.154.0's app-server `hooks/list` with this
    // exact hook injected through `-c` (currentHash field). Injecting the same
    // value as hooks.state trusted_hash flipped trustStatus to "trusted". If a
    // Codex release changes its normalization, this is the test that says so.
    expect(codexHookTrustHash('stop', {
      type: 'command',
      command: 'curl -fsS -H @/tmp/agent-code-tldr-probe/header --data-binary @- http://127.0.0.1:4321/hooks/tldr/stop',
      timeout: 10,
      async: false,
    })).toBe('sha256:0e633bb5909fb1ed645ecd1f64cc3bc5eca570b3c287453f60b45293739c4c38')
  })
})

describe('provider launch hooks', () => {
  it('gives Claude http hooks for every turn event with the bearer only as an env reference', () => {
    const settings = claudeTldrHookSettings(baseUrl)
    expect(Object.keys(settings.hooks)).toEqual(['UserPromptSubmit', 'PostToolUse', 'Stop'])
    const routes = { UserPromptSubmit: 'user-prompt-submit', PostToolUse: 'post-tool-use', Stop: 'stop' }
    for (const [event, route] of Object.entries(routes)) {
      expect(settings.hooks[event]).toEqual([{ hooks: [{
        type: 'http', url: `${baseUrl}/${route}`, timeout: 10,
        headers: { Authorization: `Bearer $${CLAUDE_TLDR_HOOK_TOKEN_ENV}` },
        // Claude interpolates only variables named here; without it the header
        // would be sent empty and every hook would fail as unauthorized.
        allowedEnvVars: [CLAUDE_TLDR_HOOK_TOKEN_ENV],
      }] }])
    }
  })

  it('pre-trusts exactly the Codex hooks it injects and keeps the bearer out of argv', async () => {
    const hooks = await createCodexTldrHooks([server()])
    expect(hooks).not.toBeNull()
    try {
      expect(hooks!.args.join(' ')).not.toContain('session-secret-token')
      expect(hooks!.args.filter(arg => arg === '--config')).toHaveLength(4)
      const values = hooks!.args.filter(arg => arg !== '--config')
      const byEvent = Object.fromEntries(values.filter(arg => !arg.startsWith('hooks.state=')).map(arg => {
        const [key] = arg.split('=', 1)
        const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(arg)![1]!) as string
        const async = /async=(true|false)/.exec(arg)![1] === 'true'
        return [key, { command, async }]
      }))
      expect(Object.keys(byEvent)).toEqual(['hooks.UserPromptSubmit', 'hooks.PostToolUse', 'hooks.Stop'])
      // Codex discards async hooks without running them, so an async
      // PostToolUse would silently disable the stale-report check.
      for (const handler of Object.values(byEvent)) expect(handler.async).toBe(false)

      const state = values.find(arg => arg.startsWith('hooks.state='))!
      const labels = { 'hooks.UserPromptSubmit': 'user_prompt_submit', 'hooks.PostToolUse': 'post_tool_use', 'hooks.Stop': 'stop' }
      for (const [key, handler] of Object.entries(byEvent)) {
        const label = labels[key as keyof typeof labels]
        const hash = codexHookTrustHash(label, { type: 'command', command: handler.command, timeout: 10, async: handler.async })
        expect(state).toContain(`"${CODEX_SESSION_FLAGS_HOOK_SOURCE}:${label}:0:0"={trusted_hash="${hash}"}`)
      }

      const headerPath = /-H @'([^']+)'/.exec(byEvent['hooks.Stop']!.command)![1]!
      expect(await readFile(headerPath, 'utf8')).toBe('Authorization: Bearer session-secret-token\n')
      expect((await stat(headerPath)).mode & 0o777).toBe(0o600)
      await hooks!.dispose()
      await expect(stat(dirname(headerPath))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await hooks?.dispose()
    }
  })

  it('injects nothing for sessions without TLDR hooks or a bearer', async () => {
    expect(await createCodexTldrHooks([server({ tldrHooks: undefined })])).toBeNull()
    expect(tldrHookServer([server({ bearerToken: undefined })])).toBeUndefined()
  })
})
