import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APP_STORE_STORAGE_KEY,
  PROMPT_TEMPLATES_STORAGE_KEY,
} from '@renderer/app-state/localStorageMigration'

type StorageMock = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
}

function createStorageMock(seed: Record<string, string> = {}): StorageMock {
  const data = new Map(Object.entries(seed))
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: key => {
      data.delete(key)
    },
    clear: () => {
      data.clear()
    },
  }
}

describe('useAppStore prompt template migration', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates legacy standalone prompt templates into persisted settings during a version upgrade', async () => {
    const storage = createStorageMock({
      [APP_STORE_STORAGE_KEY]: JSON.stringify({
        state: { settings: {} },
        version: 5,
      }),
      [PROMPT_TEMPLATES_STORAGE_KEY]: JSON.stringify([
        {
          id: 'custom:legacy',
          title: 'Legacy Prompt',
          body: 'Goal: {{goal}}',
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    })
    vi.stubGlobal('localStorage', storage)

    const { useAppStore } = await import('@renderer/app-state/store')
    await useAppStore.persist.rehydrate()

    expect(useAppStore.getState().settings.savedPromptTemplates).toHaveLength(1)
    expect(useAppStore.getState().settings.savedPromptTemplates[0]?.title).toBe('Legacy Prompt')
  })

  it('backfills built-in MCP defaults when hydrating a version-7 settings blob', async () => {
    const storage = createStorageMock({
      [APP_STORE_STORAGE_KEY]: JSON.stringify({
        state: { settings: {} },
        version: 7,
      }),
    })
    vi.stubGlobal('localStorage', storage)

    const { useAppStore } = await import('@renderer/app-state/store')
    await useAppStore.persist.rehydrate()

    expect(useAppStore.getState().settings.defaultBuiltInMcpDomains).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Palette sub-mode as store state.
//
// This is the invariant that fixes nine commands which did nothing from a
// keybinding or the native menu — Resume Session (Cmd+Shift+R) and Prompt
// Template (Alt+P) shipped default chords that were silent no-ops.
//
// The mode used to be `useState` on the palette component. A chord does not
// open the palette; it sets a pending invocation, which mounts the palette
// INVISIBLY, runs the command, and unmounts it in the same commit. Two
// independent mechanisms then destroyed the mode: the unmount itself, and the
// mount-time reset effect, which is passive and therefore runs AFTER the layout
// effect that dispatched.
//
// Testing the STORE rather than the component is deliberate. The old bug was
// not a rendering bug — it was that this state had a component lifecycle it
// should never have had. State without that lifecycle cannot be lost the same
// way, and that property is what these cases pin.
// ---------------------------------------------------------------------------
describe('palette sub-mode', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', createStorageMock())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts in the command list', async () => {
    const { useAppStore } = await import('@renderer/app-state/store')
    expect(useAppStore.getState().paletteMode).toBe('commands')
  })

  it('makes the palette visible when a mode is entered', async () => {
    // THE fix. Every mode-entering command wanted the palette up; the ones
    // invoked by chord had no way to say so. Coupling the two in the action
    // means a future mode cannot forget it.
    const { useAppStore } = await import('@renderer/app-state/store')
    useAppStore.getState().closeCommandPalette()
    expect(useAppStore.getState().commandPaletteOpen).toBe(false)

    useAppStore.getState().setPaletteMode('prompt-template')

    expect(useAppStore.getState().paletteMode).toBe('prompt-template')
    expect(useAppStore.getState().commandPaletteOpen).toBe(true)
  })

  it('resets to the command list on close, so reopening never resumes a sub-flow', async () => {
    const { useAppStore } = await import('@renderer/app-state/store')
    useAppStore.getState().setPaletteMode('resume')
    useAppStore.getState().closeCommandPalette()
    expect(useAppStore.getState().paletteMode).toBe('commands')

    useAppStore.getState().openCommandPalette()
    expect(useAppStore.getState().paletteMode).toBe('commands')
  })

  it('survives the close-after-run rule that used to kill it', async () => {
    // The chord sequence, in store terms. `closeAfterRun` is captured as
    // `!commandPaletteOpen` when the invocation is requested, so it is true
    // here. The palette host now skips the close when the command turned the
    // palette on — it previously consulted a hardcoded id list holding only
    // `open-command-palette`, which could never have covered these nine.
    const { useAppStore } = await import('@renderer/app-state/store')
    useAppStore.getState().closeCommandPalette()
    useAppStore.getState().requestCommandInvocation('prompt-template', 'keybinding')
    const pending = useAppStore.getState().pendingCommandInvocation
    expect(pending?.closeAfterRun).toBe(true)

    // What the command's `run` does.
    useAppStore.getState().setPaletteMode('prompt-template')
    useAppStore.getState().clearCommandInvocation()

    const shouldClose = pending!.closeAfterRun && !useAppStore.getState().commandPaletteOpen
    expect(shouldClose).toBe(false)
    expect(useAppStore.getState().paletteMode).toBe('prompt-template')
  })

  it('still closes after a command that opened nothing', async () => {
    // The rule must not become "never close" — an ordinary chord still returns
    // the user to where they were.
    const { useAppStore } = await import('@renderer/app-state/store')
    useAppStore.getState().closeCommandPalette()
    useAppStore.getState().requestCommandInvocation('split-vertical', 'keybinding')
    const pending = useAppStore.getState().pendingCommandInvocation
    useAppStore.getState().clearCommandInvocation()

    const shouldClose = pending!.closeAfterRun && !useAppStore.getState().commandPaletteOpen
    expect(shouldClose).toBe(true)
  })
})
