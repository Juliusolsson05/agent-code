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
