import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { CommandContext } from '@renderer/features/command-palette/types'
import type { Workspace } from '@renderer/workspace/hook'
import { CLIPBOARD_WRITE_FAILED } from '@renderer/lib/clipboardFailure'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// #1250 row 9: Copy Last Response wrote to the clipboard fire-and-forget and
// said "Copied to clipboard" whatever happened, so a refused write (Electron
// refuses when the document is not focused) was silent under a toast that said
// the opposite. The resume-command copy did catch, but showed the raw
// DOMException text (q22).
//
// The runtime entries are a RECORDED session (a Codex rendering bundle). The
// clipboard is the one replaced edge: its rejection is the case under test.

const bundle = JSON.parse(readFileSync('testing/fixtures/rendering-bundles/2026-05-20T19-11-51-193-d4a44a16.json', 'utf8')) as {
  input: { provider: string; entries: unknown[] }
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(writeText) } })
}

function context(kind: string) {
  const toasts: string[] = []
  const ctx = {
    workspace: {
      state: {
        activeTabId: 'tab',
        stage: oneLaneStage('agent'),
        pinnedSessionIds: [],
        sessions: { agent: { cwd: '/projects/app', kind, providerSessionId: 'provider-abc', projectId: 'tab', joinedAt: 0 } },
        tabs: [{ id: 'tab' }],
      },
      getRuntime: () => ({ ...emptyRuntime(), entries: bundle.input.entries }),
      showPaneToast: (_sessionId: string, message: string) => { toasts.push(message) },
    } as unknown as Workspace,
    ui: { closePalette: vi.fn() },
    flags: {},
  } as unknown as CommandContext
  return { ctx, toasts }
}

const copyLast = paneCommands.find(command => command.id === 'copy-last-assistant')!
const copyResume = sessionCommands.find(command => command.id === 'copy-resume-command')!

describe('copy commands and a refused clipboard', () => {
  const refused = () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'))

  it('says a refused Copy Last Response did not copy, and never claims it did', async () => {
    stubClipboard(refused)
    const { ctx, toasts } = context(bundle.input.provider)
    await copyLast.run(ctx)
    // The literal words (#1421 review b, c): comparing against the constant
    // alone would let the advice be reworded away unnoticed.
    expect(toasts).toEqual(["Couldn't copy to the clipboard. Click into the app and try again."])
    expect(CLIPBOARD_WRITE_FAILED).toBe(toasts[0])
  })

  // #1421 review a: the command's promise is the dispatcher's single-flight
  // and outcome; it must not resolve (or say anything) before the write does.
  it('stays pending, and silent, until the clipboard write settles', async () => {
    let finish!: () => void
    stubClipboard(() => new Promise<void>(resolve => { finish = resolve }))
    const { ctx, toasts } = context(bundle.input.provider)
    let settled = false
    const running = Promise.resolve(copyLast.run(ctx)).then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    expect(toasts).toEqual([])
    finish()
    await running
    expect(toasts).toEqual(['Copied to clipboard'])
  })

  it('says Copied only after the clipboard took the recorded response', async () => {
    let written = ''
    stubClipboard(async text => { written = text })
    const { ctx, toasts } = context(bundle.input.provider)
    await copyLast.run(ctx)
    expect(written.length).toBeGreaterThan(0)
    expect(toasts).toEqual(['Copied to clipboard'])
  })

  it('says a refused resume-command copy in fixed words, not the browser text', async () => {
    stubClipboard(refused)
    const { ctx, toasts } = context('claude')
    expect(copyResume.when?.(ctx)).toBe(true)
    await copyResume.run(ctx)
    expect(toasts).toEqual([CLIPBOARD_WRITE_FAILED])
    expect(toasts.join(' ')).not.toContain('not focused')
  })
})
