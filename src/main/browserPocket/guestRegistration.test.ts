import { expect, it } from 'vitest'

import { mayRegisterGuest } from './guestRegistration'

const wc = (type: string, host: number | null, destroyed = false) => ({ getType: () => type, hostWebContents: host === null ? null : { id: host }, isDestroyed: () => destroyed })

it('accepts only a live webview hosted by the requesting window', () => {
  expect(mayRegisterGuest(wc('webview', 7), 7)).toBe(true)
  // The attack: registering the main window (or anything that is not a guest).
  expect(mayRegisterGuest(wc('window', null), 7)).toBe(false)
  // Another window's guest.
  expect(mayRegisterGuest(wc('webview', 8), 7)).toBe(false)
  expect(mayRegisterGuest(wc('webview', 7, true), 7)).toBe(false)
  expect(mayRegisterGuest(null, 7)).toBe(false)
})
