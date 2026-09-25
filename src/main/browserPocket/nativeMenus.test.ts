import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ build: vi.fn(), popup: vi.fn(), external: vi.fn(), copy: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  Menu: { buildFromTemplate: native.build }, clipboard: { writeText: native.copy }, shell: { openExternal: native.external }, dialog: {},
}))
import { attachGuestContextMenu, pocketMenuTemplate } from './nativeMenus'

describe('native browser controls', () => {
  it('keeps removal separate from closing, and delegates device choices through typed actions', () => {
    const choose = vi.fn()
    const template = pocketMenuTemplate({ viewport: 'fill', colorScheme: 'system', zoom: 1, profile: 'lane', hasPage: false, canGoBack: false, canGoForward: false }, choose)
    expect(template.find(i => i.label === 'Forward')?.enabled).toBe(false)
    expect(template.find(i => i.label === 'Open in Default Browser')?.enabled).toBe(false)
    const viewport = template.find(i => i.label === 'Viewport')!.submenu as Electron.MenuItemConstructorOptions[]
    expect(viewport[0]).toMatchObject({ checked: true, type: 'radio' })
    viewport[1]!.click!({} as never, {} as never, {} as never)
    expect(choose).toHaveBeenCalledWith(expect.stringMatching(/^device:/))
    expect(template.at(-1)!.label).toMatch(/private storage/i)
  })

  it('uses native edit roles and the clicked guest history; refuses external non-web link schemes', () => {
    native.build.mockImplementation(() => ({ popup: native.popup }))
    const back = vi.fn()
    const guest = Object.assign(new EventEmitter(), { hostWebContents: {}, isDestroyed: () => false, isLoading: () => false, navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: back } })
    attachGuestContextMenu(guest as unknown as Electron.WebContents)
    guest.emit('context-menu', {}, { isEditable: true, selectionText: 'selected', editFlags: { canCopy: true, canCut: false, canPaste: true }, linkURL: 'javascript:alert(1)' })
    const template = native.build.mock.lastCall![0] as Electron.MenuItemConstructorOptions[]
    expect(template.find(i => i.role === 'copy')).toMatchObject({ enabled: true })
    expect(template.find(i => i.role === 'cut')).toMatchObject({ enabled: false })
    // Case-insensitive: the labels are Title Case ("Open Link in…"), and a
    // case-sensitive 'link' would pass vacuously against every label.
    expect(template.some(i => /link/i.test(i.label ?? ''))).toBe(false)
    template.find(i => i.label === 'Back')!.click!({} as never, {} as never, {} as never)
    expect(back).toHaveBeenCalledOnce()
    expect(native.external).not.toHaveBeenCalled()
    expect(native.popup).toHaveBeenCalledOnce()
  })
})

it('a native Stop item keeps its meaning if loading finishes before selection', () => {
  native.build.mockImplementation(() => ({ popup: native.popup }))
  let loading = true
  const stop = vi.fn(), reload = vi.fn()
  const guest = Object.assign(new EventEmitter(), { hostWebContents: {}, isDestroyed: () => false, isLoading: () => loading, stop, reload, navigationHistory: { canGoBack: () => false, canGoForward: () => false } })
  attachGuestContextMenu(guest as unknown as Electron.WebContents)
  guest.emit('context-menu', {}, { editFlags: {} })
  const template = native.build.mock.lastCall![0] as Electron.MenuItemConstructorOptions[]
  loading = false
  template.find(i => i.label === 'Stop')!.click!({} as never, {} as never, {} as never)
  expect(stop).toHaveBeenCalledOnce()
  expect(reload).not.toHaveBeenCalled()
})
