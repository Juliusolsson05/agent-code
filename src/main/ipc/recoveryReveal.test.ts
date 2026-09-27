import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #1424 review a: the recovery snapshot keeps the state-file path it found at
// load, and shell.showItemInFolder answers nothing. A file removed since then
// used to report ok with nothing revealed. All three reveal handlers now check
// the file first. Real files in a scratch directory; Electron's ipcMain is
// captured and showItemInFolder is the replaced edge (the OS).

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
const shell = vi.hoisted(() => ({ showItemInFolder: vi.fn(), openPath: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  shell,
  BrowserWindow: { getAllWindows: () => [] },
}))

import { registerAgentCodeConventionsIpc } from './agentCodeConventions'
import { registerAgentCodeCustomSkillsIpc } from './agentCodeCustomSkills'
import { registerAgentCodeInstalledSkillsIpc } from './agentCodeInstalledSkills'

let dir: string
let statePath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recovery-reveal-'))
  statePath = join(dir, 'conventions.json')
  handlers.clear()
  shell.showItemInFolder.mockReset()
  const service = { resolveRecoveryFile: async () => statePath } as never
  registerAgentCodeConventionsIpc(service)
  registerAgentCodeCustomSkillsIpc(service)
  registerAgentCodeInstalledSkillsIpc(service)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const channels = ['agent-code-conventions:reveal-recovery', 'agent-code-custom-skills:reveal-recovery', 'agent-code-installed-skills:reveal-recovery']

describe('recovery-file reveal', () => {
  it.each(channels)('%s refuses a state file that is no longer there', async channel => {
    expect(await handlers.get(channel)!({})).toEqual({ ok: false, message: 'The state file is no longer there. Refresh to check again.' })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(channels)('%s reveals a state file that exists', async channel => {
    await writeFile(statePath, 'not json')
    expect(await handlers.get(channel)!({})).toEqual({ ok: true })
    expect(shell.showItemInFolder).toHaveBeenCalledWith(statePath)
  })
})
