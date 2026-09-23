import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FRAME_REQUEST_METHODS } from './frameProtocol'

// The frame allow-list (frameRequestSchema) and the view bootstrap that sends
// requests (main's frameDocument.ts) are written in two files, in two tsc
// projects. A method the bootstrap exposes but the union omits can never
// succeed from a view: the broker answers it with "Unknown extension API
// request." (see frameHost.renderer.test.ts for that behaviour). That is how
// api.net.fetch and api.services.expose were broken in views until #1150.
//
// What the schemas accept argument by argument is zod's job and is not
// re-tested here; this pins the one contract zod cannot state: membership.
//
// The bootstrap is read as TEXT rather than imported: it lives in the node
// project, and a type import across the project boundary would not compile.
// Parsing its `request('<method>'` calls keeps the list derived, not mirrored.
const bootstrap = readFileSync(new URL('../../../../main/extensions/frameDocument.ts', import.meta.url), 'utf8')
const sentMethods = [...new Set([...bootstrap.matchAll(/\brequest\('([a-zA-Z.]+)'/g)].map(match => match[1]))]

describe('view frame request allow-list', () => {
  it('finds the bootstrap\'s request calls (guards the parser, not the protocol)', () => {
    expect(sentMethods).toEqual(expect.arrayContaining(['storage.get', 'net.fetch', 'service.expose', 'secrets.set']))
  })

  it('admits every method the view bootstrap sends', () => {
    expect(sentMethods.filter(method => !FRAME_REQUEST_METHODS.has(method))).toEqual([])
  })
})
