import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  // Steering q111: a DIRECTORY at the state-file path is not a state file.
  it.each(channels)('%s refuses a directory where the state file was', async channel => {
    await mkdir(statePath)
    expect(await handlers.get(channel)!({})).toEqual({ ok: false, message: 'The state file is no longer there. Refresh to check again.' })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(channels)('%s reveals a state file that exists', async channel => {
    await writeFile(statePath, 'not json')
    expect(await handlers.get(channel)!({})).toEqual({ ok: true })
    expect(shell.showItemInFolder).toHaveBeenCalledWith(statePath)
  })
})

// Review of #1456 (a), #1427: when shell.openPath fails, Electron returns a
// string such as `Failed to open /Users/…/skills`, and the four Reveal
// handlers returned it as the IPC message the Skills rows show. A real
// directory in the scratch dir; openPath (the OS) is the replaced edge.
describe('target and source reveal', () => {
  const raw = 'Failed to open /Users/Alice/.claude/skills'
  const reveals: Array<[string, unknown[]]> = [
    ['agent-code-conventions:reveal-target', ['claude-personal-skills']],
    ['agent-code-custom-skills:reveal-target', ['skill-1', 'claude-personal-skills']],
    ['agent-code-installed-skills:reveal-target', ['skill-1', 'claude-personal-skills']],
    ['agent-code-installed-skills:reveal-source', ['skill-1']],
  ]
  beforeEach(async () => {
    const target = join(dir, 'skills', 'agent-code-conventions')
    await mkdir(target, { recursive: true })
    handlers.clear()
    shell.openPath.mockReset()
    const service = {
      resolveRevealTarget: async () => target,
      resolveCustomSkillRevealTarget: async () => target,
      resolveInstalledSkillRevealTarget: async () => target,
      resolveInstalledSkillSource: async () => target,
    } as never
    registerAgentCodeConventionsIpc(service)
    registerAgentCodeCustomSkillsIpc(service)
    registerAgentCodeInstalledSkillsIpc(service)
  })

  it.each(reveals)('%s answers a failed open in fixed words and logs Electron\'s text', async (channel, args) => {
    shell.openPath.mockResolvedValue(raw)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await handlers.get(channel)!({}, ...args) as { ok: boolean; message?: string }
      expect(result).toEqual({ ok: false, message: 'Agent Code could not open this folder.' })
      expect(warn).toHaveBeenCalledWith(expect.any(String), raw)
    } finally {
      warn.mockRestore()
    }
  })

  it.each(reveals)('%s reports success when the folder opens', async (channel, args) => {
    shell.openPath.mockResolvedValue('')
    expect(await handlers.get(channel)!({}, ...args)).toEqual({ ok: true })
  })
})
