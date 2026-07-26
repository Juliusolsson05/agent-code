import { describe, expect, it } from 'vitest'

import { CLOSE_GRANT_TTL_MS, createCloseGrantStore } from '@mcp/shared/closeGrant'

// ---------------------------------------------------------------------------
// The plan's line is "Prose is not an enforceable grant." These assert the
// properties that make this one enforceable: it is scoped to an exact pair,
// it expires, and it cannot be spent twice.
// ---------------------------------------------------------------------------

const NOW = 1_000_000

describe('close grant', () => {
  it('authorizes exactly the caller/target pair it was issued for', () => {
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    expect(store.peek('caller', 'target', NOW)).toBe(true)
  })

  it('does not authorize a different target', () => {
    // The failure the prose rule could not prevent: a model told to close agent
    // X deciding agent Y also looks stale.
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    expect(store.consume('caller', 'other-target', NOW)).toBe(false)
  })

  it('does not authorize a different caller', () => {
    // One agent's authorization is not another's, even for the same victim.
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    expect(store.consume('other-caller', 'target', NOW)).toBe(false)
  })

  it('refuses when no grant was ever issued', () => {
    // The default is DENY. A model that decides on its own to close an agent
    // hits this, regardless of what it inferred from age or transcript.
    const store = createCloseGrantStore()
    expect(store.consume('caller', 'target', NOW)).toBe(false)
  })

  it('is single-use', () => {
    // "The user asked me to close agent X" is true about one moment. A reusable
    // grant would let a later turn spend authorization given once.
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    expect(store.consume('caller', 'target', NOW)).toBe(true)
    expect(store.consume('caller', 'target', NOW)).toBe(false)
  })

  it('expires', () => {
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    expect(store.consume('caller', 'target', NOW + CLOSE_GRANT_TTL_MS + 1)).toBe(false)
  })

  it('is still valid one millisecond before expiry', () => {
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    expect(store.consume('caller', 'target', NOW + CLOSE_GRANT_TTL_MS - 1)).toBe(true)
  })

  it('removes an expired grant on the attempt that finds it dead', () => {
    // Otherwise a caller could poll until a clock race let it through.
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    store.consume('caller', 'target', NOW + CLOSE_GRANT_TTL_MS + 1)
    expect(store.size()).toBe(0)
  })

  it('revokes grants naming a session that went away, in either direction', () => {
    // A grant naming a dead caller could be replayed by a session that reused
    // the id; one naming a dead target is meaningless.
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    store.issue('other', 'caller', NOW)
    store.issue('unrelated', 'elsewhere', NOW)
    store.revokeForSession('caller')
    expect(store.size()).toBe(1)
    expect(store.peek('unrelated', 'elsewhere', NOW)).toBe(true)
  })

  it('lets a fresh issue replace a spent one', () => {
    // A user who genuinely asks twice gets authorized twice.
    const store = createCloseGrantStore()
    store.issue('caller', 'target', NOW)
    store.consume('caller', 'target', NOW)
    store.issue('caller', 'target', NOW)
    expect(store.consume('caller', 'target', NOW)).toBe(true)
  })
})
