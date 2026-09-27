import { expect, it } from 'vitest'

import { LAYERS } from './layers'

// #512: the ORDER of the layers is the contract (a toast under the dialog
// scrim was invisible; a menu at the dialog's own z painted by DOM accident).
const z = (cls: string) => Number(/^z-\[?(\d+)\]?$/.exec(cls)?.[1])

it('spells every layer as a literal z class Tailwind can see', () => {
  for (const cls of Object.values(LAYERS)) expect(Number.isFinite(z(cls))).toBe(true)
})

it('orders the pane layers, then the app layers, lowest first', () => {
  const order = [
    LAYERS.paneOverlay, LAYERS.paneTakeover,
    LAYERS.paneDialogScrim, LAYERS.paneDialogContent, LAYERS.paneDialogFeedback,
    LAYERS.dialog, LAYERS.menu, LAYERS.toast, LAYERS.debugOverlay,
  ].map(z)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(new Set(order).size).toBe(order.length)
})

// Review a (#1398): the migration promised the SAME classes at every site;
// order alone would let a band drift (z-[1100] -> z-[1101]) unnoticed.
it('keeps the exact classes the sites used before the migration', () => {
  expect(LAYERS).toEqual({
    paneOverlay: 'z-40',
    paneTakeover: 'z-50',
    paneDialogScrim: 'z-[60]',
    paneDialogContent: 'z-[61]',
    paneDialogFeedback: 'z-[62]',
    inSurfacePopover: 'z-50',
    dialog: 'z-[1100]',
    menu: 'z-[1150]',
    toast: 'z-[1200]',
    debugOverlay: 'z-[10000]',
  })
})
