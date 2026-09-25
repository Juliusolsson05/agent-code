import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stubbed `Menu`/`BrowserWindow` in the style of browserPocket/nativeMenus.test.ts:
// what is under test is the template we hand Electron and the promise's
// settle rules, not Electron's menu rendering.
const native = vi.hoisted(() => ({
  build: vi.fn(),
  popup: vi.fn(),
  window: null as unknown,
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => native.window },
  Menu: { buildFromTemplate: native.build },
}))
import { popupMenuTemplate, showPopupMenu, validatePopupMenu } from './popupMenu'
import type { PopupMenuItem } from '@shared/types/popupMenu'

type Template = Electron.MenuItemConstructorOptions[]

const click = (item: Electron.MenuItemConstructorOptions | undefined) =>
  item!.click!({} as never, {} as never, {} as never)

beforeEach(() => {
  native.build.mockReset().mockImplementation(() => ({ popup: native.popup }))
  native.popup.mockReset()
  native.window = new EventEmitter()
})

describe('validatePopupMenu', () => {
  it('keeps only known fields, so a staged role or click cannot reach Electron', () => {
    const items = validatePopupMenu([
      { type: 'item', id: 'quit', label: 'Innocent', role: 'quit', click: 'x', extra: 1 },
    ])
    expect(items).toEqual([{ type: 'item', id: 'quit', label: 'Innocent' }])
  })

  it('rejects nesting past two levels, too many items, and unknown shapes', () => {
    const leaf = { type: 'item', id: 'a', label: 'A' }
    expect(() => validatePopupMenu([{ type: 'submenu', label: 'S', items: [leaf] }])).not.toThrow()
    expect(() => validatePopupMenu([
      { type: 'submenu', label: 'S', items: [{ type: 'submenu', label: 'T', items: [leaf] }] },
    ])).toThrow(/nesting/)
    expect(() => validatePopupMenu(Array.from({ length: 61 }, () => leaf))).toThrow(/more than 60/)
    // Items inside submenus count toward the same cap: a wide submenu is not
    // a way around it.
    expect(() => validatePopupMenu([
      { type: 'submenu', label: 'S', items: Array.from({ length: 60 }, () => leaf) },
    ])).toThrow(/more than 60/)
    expect(() => validatePopupMenu([{ type: 'role', id: 'a', label: 'A' }])).toThrow(/unknown item type/)
    expect(() => validatePopupMenu([{ type: 'item', id: 3, label: 'A' }])).toThrow(/id/)
    expect(() => validatePopupMenu([{ type: 'item', id: 'a', label: '' }])).toThrow(/label/)
    expect(() => validatePopupMenu([{ type: 'item', id: 'a', label: 'A', enabled: 'yes' }])).toThrow(/enabled/)
    expect(() => validatePopupMenu('nope')).toThrow(/array/)
  })
})

describe('popupMenuTemplate', () => {
  it('maps every clickable item, including inside a submenu, back to its id', () => {
    const choose = vi.fn()
    const items: PopupMenuItem[] = [
      { type: 'item', id: 'reload-agent', label: 'Reload Agent', accelerator: 'Command+R' },
      { type: 'separator' },
      { type: 'submenu', label: 'Colour Flag', items: [
        { type: 'item', id: 'flag:red', label: '● Red', checked: true },
        { type: 'item', id: 'flag:none', label: 'None', checked: false },
      ] },
      { type: 'item', id: 'close-pane', label: 'Close Agent', enabled: false },
    ]
    const template = popupMenuTemplate(items, choose)

    click(template[0])
    click((template[2]!.submenu as Template)[1])
    expect(choose.mock.calls).toEqual([['reload-agent'], ['flag:none']])
    // Display-only shortcut: never registered as a global accelerator.
    expect(template[0]).toMatchObject({ accelerator: 'Command+R', registerAccelerator: false })
    expect((template[2]!.submenu as Template)[0]).toMatchObject({ type: 'checkbox', checked: true })
    expect(template[3]).toMatchObject({ enabled: false })
    // A plain item carries no checkbox type.
    expect(template[0]!.type).toBeUndefined()
  })
})

describe('showPopupMenu', () => {
  const sender = {} as Electron.WebContents
  const items: PopupMenuItem[] = [{ type: 'item', id: 'pin-agent', label: 'Pin Session' }]

  it('resolves with the clicked id, then ignores the close callback that follows', async () => {
    const result = showPopupMenu(sender, { items, x: 10.4, y: 20 })
    const template = native.build.mock.lastCall![0] as Template
    const options = native.popup.mock.lastCall![0] as Electron.PopupOptions
    expect(options).toMatchObject({ x: 10, y: 20 })

    click(template[0])
    options.callback!()
    await expect(result).resolves.toBe('pin-agent')
  })

  it('resolves null when dismissed, and when the window closes under the menu', async () => {
    const dismissed = showPopupMenu(sender, { items })
    ;(native.popup.mock.lastCall![0] as Electron.PopupOptions).callback!()
    await expect(dismissed).resolves.toBeNull()

    const orphaned = showPopupMenu(sender, { items })
    ;(native.window as EventEmitter).emit('closed')
    await expect(orphaned).resolves.toBeNull()
  })

  it('opens at the cursor when no point is given, and not at all without a window', async () => {
    void showPopupMenu(sender, { items, x: Number.NaN })
    expect(native.popup.mock.lastCall![0]).toMatchObject({ x: undefined, y: undefined })

    native.window = null
    await expect(showPopupMenu(sender, { items })).resolves.toBeNull()
  })

  it('rejects a malformed template before building anything', () => {
    expect(() => showPopupMenu(sender, { items: [{ type: 'item', role: 'quit' } as never] })).toThrow()
    expect(native.build).not.toHaveBeenCalled()
  })
})
