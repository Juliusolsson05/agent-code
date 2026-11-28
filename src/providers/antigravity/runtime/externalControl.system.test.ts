import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AntigravitySession } from './antigravitySession.js'
import { AntigravityTerminalSession } from './antigravityTerminalSession.js'
import { replayAntigravityConversation } from './antigravityHistory.js'
import { AntigravityConversationSource } from '@main/conversations/sources/antigravity.js'

let home: string, globalConfig: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agy-launch-policy-'))
  const configDir = join(home, '.gemini/config')
  await mkdir(configDir, { recursive: true })
  globalConfig = join(configDir, 'mcp_config.json')
  vi.stubEnv('HOME', home)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
const writeConflict = () => writeFile(globalConfig, '{"mcpServers":{"agent-code-control":{"command":"/usr/bin/true"}}}')

it('blocks native preallocation, rendered launch, history replay and catalog before starting a subprocess', async () => {
  await writeConflict()
  const allocate = vi.fn()
  const spawn = vi.fn()
  const acp = new AntigravitySession({ cwd: home }, { spawn, mcpProxyScript: 'unused', scriptRunner: 'unused' })
  const terminal = new AntigravityTerminalSession({ cwd: home }, { allocate })
  const source = new AntigravityConversationSource({ binary: spawn })
  try {
    await expect(acp.start()).rejects.toThrow(/agent-code-control/)
    await expect(terminal.start()).rejects.toThrow(/agent-code-control/)
    await expect(replayAntigravityConversation('unused', home, { spawn })).rejects.toThrow(/agent-code-control/)
    expect(await source.discover({ scope: 'everywhere', family: { matches: () => true } } as Parameters<typeof source.discover>[0])).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(allocate).not.toHaveBeenCalled()
    expect(terminal.getProcessPid()).toBeNull()
  } finally { await Promise.all([acp.stop(), terminal.stop()]) }
})

it('rechecks the native launch when the config changes during preallocation', async () => {
  const allocate = vi.fn(async () => { await writeConflict(); return 'unused' })
  const terminal = new AntigravityTerminalSession({ cwd: home }, { allocate })
  try {
    await expect(terminal.start()).rejects.toThrow(/agent-code-control/)
    expect(allocate).toHaveBeenCalledOnce()
    expect(terminal.getProcessPid()).toBeNull()
  } finally { await terminal.stop() }
})
