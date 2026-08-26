import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { CodexPromptInputProfile } from 'codex-headless'
import { CodexSession } from './codexSession.js'

const appServerFixture = fileURLToPath(new URL(
  '../../../../packages/codex-headless/testing/fixtures/prompt-input/' +
    'codex-01491-app-server-fixture.mjs',
  import.meta.url,
))
const baseMarker = '--recorded-parent-base-argument'

type PromptProfileInternals = {
  preparePromptInputProfile(
    baseArgs: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<CodexPromptInputProfile | null>
}

function sessionAndEnv(mode: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  env.CODEX_PROFILE_FIXTURE_MODE = mode
  env.CODEX_PROFILE_REQUIRED_ARG = baseMarker
  const session = new CodexSession({
    binary: process.execPath,
    cwd: process.cwd(),
    env,
  })
  return { session, env }
}

describe('CodexSession prompt profile launch binding', () => {
  it('attests the exact parent argument prefix before returning launch authority', async () => {
    const { session, env } = sessionAndEnv('recorded-safe')
    const profile = await (session as unknown as PromptProfileInternals)
      .preparePromptInputProfile([appServerFixture, baseMarker], env)

    expect(profile?.cliArgs).toEqual([
      '--config', 'tui.keymap.composer.submit="enter"',
      '--config', 'tui.keymap.composer.queue="tab"',
      '--config', 'tui.vim_mode_default=false',
      '--config', 'tui.keymap.global.toggle_vim_mode=[]',
    ])
  })

  it('keeps terminal launch available but withholds authority on conflict', async () => {
    const { session, env } = sessionAndEnv('conflicting-binding')
    const errors: Error[] = []
    session.on('jsonl-error', error => errors.push(error))
    const profile = await (session as unknown as PromptProfileInternals)
      .preparePromptInputProfile([appServerFixture, baseMarker], env)

    expect(profile).toBeNull()
    expect(errors.map(error => error.message)).toEqual([
      'Codex prompt evidence disabled: effective-config-unverified',
    ])
    // WHY the adapter reports a content-safe refusal and returns null; start()
    // owns the following PTY spawn and deliberately continues with the caller's
    // untouched keymap. Throwing here would recreate the recorded no-composer
    // startup outage instead of merely disabling transcript ownership.
    expect(typeof session.start).toBe('function')
  })
})
