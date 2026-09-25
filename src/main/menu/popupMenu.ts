import { BrowserWindow, Menu } from 'electron'

import {
  POPUP_MENU_MAX_DEPTH,
  POPUP_MENU_MAX_ITEMS,
  type PopupMenuItem,
  type PopupMenuRequest,
} from '@shared/types/popupMenu.js'

type Item = Electron.MenuItemConstructorOptions

const MAX_LABEL = 200
const MAX_ID = 200
const MAX_ACCELERATOR = 64

/**
 * Re-derive a template from untrusted IPC input, keeping only known fields.
 *
 * WHY rebuild instead of checking and passing the object through: anything
 * that reaches `Menu.buildFromTemplate` is interpreted, and the dangerous
 * fields (`role`, `click`, `submenu` with roles inside) are ones the TYPE
 * already forbids — so the only way they arrive is a renderer that is not
 * running our code. Copying field by field makes "unknown field" impossible to
 * forward by accident, where a deny-list would have to anticipate every
 * Electron option that exists now and later.
 *
 * Throws on malformed input rather than dropping the bad item: the renderer
 * builds this template from a pure, tested function, so a malformed one is a
 * bug worth a rejected invoke (visible in the renderer console), not a menu
 * that silently lacks an item.
 */
export function validatePopupMenu(input: unknown): PopupMenuItem[] {
  let count = 0
  const walk = (value: unknown, depth: number): PopupMenuItem[] => {
    if (!Array.isArray(value)) throw new Error('popup menu: items must be an array')
    return value.map((raw): PopupMenuItem => {
      count += 1
      if (count > POPUP_MENU_MAX_ITEMS) throw new Error(`popup menu: more than ${POPUP_MENU_MAX_ITEMS} items`)
      if (!raw || typeof raw !== 'object') throw new Error('popup menu: item must be an object')
      const item = raw as Record<string, unknown>
      if (item.type === 'separator') return { type: 'separator' }
      const label = boundedString(item.label, MAX_LABEL, 'label')
      if (item.type === 'submenu') {
        // Depth counts menus: the top level is 1, its submenus are 2.
        if (depth >= POPUP_MENU_MAX_DEPTH) throw new Error(`popup menu: nesting deeper than ${POPUP_MENU_MAX_DEPTH}`)
        return { type: 'submenu', label, items: walk(item.items, depth + 1) }
      }
      if (item.type !== 'item') throw new Error(`popup menu: unknown item type ${String(item.type)}`)
      const out: PopupMenuItem = { type: 'item', id: boundedString(item.id, MAX_ID, 'id'), label }
      if (item.enabled !== undefined) out.enabled = boolean(item.enabled, 'enabled')
      if (item.checked !== undefined) out.checked = boolean(item.checked, 'checked')
      if (item.accelerator !== undefined) out.accelerator = boundedString(item.accelerator, MAX_ACCELERATOR, 'accelerator')
      return out
    })
  }
  return walk(input, 1)
}

function boundedString(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`popup menu: ${field} must be a non-empty string of at most ${max} characters`)
  }
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`popup menu: ${field} must be a boolean`)
  return value
}

function coordinate(value: unknown): number | undefined {
  // A non-finite coordinate would make Electron fall back to the cursor
  // anyway; dropping it here keeps that explicit instead of accidental.
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

/** Validated items → Electron template. Exported for tests. */
export function popupMenuTemplate(items: PopupMenuItem[], choose: (id: string) => void): Item[] {
  return items.map((item): Item => {
    if (item.type === 'separator') return { type: 'separator' }
    if (item.type === 'submenu') return { label: item.label, submenu: popupMenuTemplate(item.items, choose) }
    return {
      label: item.label,
      enabled: item.enabled ?? true,
      // `checkbox` only when checked is stated, so an ordinary item does not
      // reserve check-mark space on platforms that draw it.
      ...(item.checked !== undefined ? { type: 'checkbox' as const, checked: item.checked } : {}),
      ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
      click: () => choose(item.id),
    }
  })
}

/**
 * Show the menu on the sender's window; resolve with the chosen id or null.
 *
 * Always settles: dismissal resolves null through the popup callback, and a
 * window closed while the menu is open resolves null through `closed` (the
 * pocket menu's rule — an invoke that never settles leaks its renderer
 * promise and, here, leaves the row's "menu open" highlight on for good).
 */
export function showPopupMenu(sender: Electron.WebContents, request: PopupMenuRequest): Promise<string | null> {
  const items = validatePopupMenu(request?.items)
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || items.length === 0) return Promise.resolve(null)
  return new Promise(resolve => {
    // Same settle shape as the pocket menu (showPocketMenu): a click resolves
    // with its id, and the close callback resolves null. A promise settles
    // once, so whichever runs first wins — and Electron's macOS menu
    // controller posts the close callback as a task precisely so that
    // `itemSelected` runs before it (menu_controller.mm, menuDidClose), which
    // makes "click first" the order this relies on.
    const menu = Menu.buildFromTemplate(popupMenuTemplate(items, id => resolve(id)))
    const closed = () => resolve(null)
    window.once('closed', closed)
    menu.popup({
      window,
      x: coordinate(request.x),
      y: coordinate(request.y),
      callback: () => {
        window.removeListener('closed', closed)
        resolve(null)
      },
    })
  })
}
