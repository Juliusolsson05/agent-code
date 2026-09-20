import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { readOpencodeModelState } from './opencodeCliSessions.js'

// The real reader against the real recorded model.json, placed where
// OpenCode keeps it (`$XDG_STATE_HOME/opencode/model.json`; `opencode debug
// paths` reports ~/.local/state/opencode on macOS). The engine test stubs
// this I/O, so this is the one test of the path and the read (#1034 review).
const fixture = resolve(__dirname, '../../../../testing/fixtures/opencode-model-selection/model.json')
const original = process.env.XDG_STATE_HOME
const dirs: string[] = []
afterEach(async () => {
  if (original === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = original
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('reads recents newest-first and the variant map from $XDG_STATE_HOME/opencode/model.json', async () => {
  const stateHome = await mkdtemp(join(tmpdir(), 'opencode-state-'))
  dirs.push(stateHome)
  await mkdir(join(stateHome, 'opencode'))
  await copyFile(fixture, join(stateHome, 'opencode', 'model.json'))
  process.env.XDG_STATE_HOME = stateHome
  const state = await readOpencodeModelState()
  expect(state.recent[0]).toBe('zai-coding-plan/glm-5.3')
  expect(state.recent).toHaveLength(8)
  expect(state.variants['zai-coding-plan/glm-5.3']).toBe('max')
})

it('a missing file is empty state, never an error', async () => {
  const stateHome = await mkdtemp(join(tmpdir(), 'opencode-state-'))
  dirs.push(stateHome)
  process.env.XDG_STATE_HOME = stateHome
  expect(await readOpencodeModelState()).toEqual({ recent: [], variants: {} })
})
