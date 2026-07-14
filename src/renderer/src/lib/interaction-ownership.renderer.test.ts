import { afterEach, describe, expect, it } from 'vitest'

import {
  APP_INTERACTION_OWNER_ATTRIBUTE,
  APP_INTERACTION_OWNER_SELECTOR,
  APP_INTERACTION_OWNER_VALUE,
  hasAppInteractionOwner,
} from './interaction-ownership'

describe('app interaction ownership', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('does not confuse ARIA dialog semantics with the input-routing contract', () => {
    const semanticDialog = document.createElement('div')
    semanticDialog.setAttribute('role', 'dialog')
    document.body.append(semanticDialog)

    expect(hasAppInteractionOwner()).toBe(false)
  })

  it('recognizes a mounted app owner through the canonical marker', () => {
    const owner = document.createElement('div')
    owner.setAttribute(APP_INTERACTION_OWNER_ATTRIBUTE, APP_INTERACTION_OWNER_VALUE)
    document.body.append(owner)

    expect(owner.matches(APP_INTERACTION_OWNER_SELECTOR)).toBe(true)
    expect(hasAppInteractionOwner()).toBe(true)
  })

  it('can query an explicit root for isolated surfaces and tests', () => {
    const outside = document.createElement('div')
    outside.setAttribute(APP_INTERACTION_OWNER_ATTRIBUTE, APP_INTERACTION_OWNER_VALUE)
    document.body.append(outside)

    const isolatedRoot = document.createElement('section')
    expect(hasAppInteractionOwner(isolatedRoot)).toBe(false)

    const inside = document.createElement('div')
    inside.setAttribute(APP_INTERACTION_OWNER_ATTRIBUTE, APP_INTERACTION_OWNER_VALUE)
    isolatedRoot.append(inside)
    expect(hasAppInteractionOwner(isolatedRoot)).toBe(true)
  })
})
