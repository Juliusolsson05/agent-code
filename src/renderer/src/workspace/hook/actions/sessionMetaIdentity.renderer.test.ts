import { describe, expect, it } from 'vitest'

// The behaviour under test is a private helper, so this exercises the SHAPE
// rule it enforces rather than importing it: after a wake that changed
// nothing, the session-meta object must keep its identity.
//
// WHY that matters at all — it is not an optimisation:
//
// deliverTextToSession's isCurrent(), and both prompt-template insertion
// paths, use the meta object's IDENTITY as their "is my target still the same
// pane?" token across an await. ensureSessionLive committed its recovered meta
// unconditionally, so ANY wake replaced that object even when every field was
// identical, and those guards read it as "the pane changed underneath me" and
// cancelled. Inserting a template or a vault key into a pane that was exited,
// parked, or still spawning therefore ALWAYS failed the first time with
// "target pane is gone", and always worked on the retry.
//
// The trap this file exists to pin: `builtInMcpDomains` is rebuilt on every
// wake (resolveSessionBuiltInMcpDomains ends in a filter, so it returns a
// fresh array with identical contents). A reference-equality comparison
// reports "changed" for it every single time, which would leave the bug fixed
// only for plain terminals — the one population that does not carry the field.

type Meta = Record<string, unknown>

function metaValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  }
  return false
}

function metaIsUnchanged(current: Meta, next: Meta): boolean {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  for (const key of keys) if (!metaValuesEqual(current[key], next[key])) return false
  return true
}

describe('session meta no-op detection', () => {
  it('treats a rebuilt but identical domain array as unchanged', () => {
    const current = { cwd: '/recorded', kind: 'claude', builtInMcpDomains: ['workflows'] }
    // A different array object with the same contents — exactly what every
    // wake produces for an agent pane.
    const next = { cwd: '/recorded', kind: 'claude', builtInMcpDomains: ['workflows'] }

    expect(next.builtInMcpDomains).not.toBe(current.builtInMcpDomains)
    expect(metaIsUnchanged(current, next)).toBe(true)
  })

  it('sees a real change to the domain list', () => {
    expect(metaIsUnchanged(
      { builtInMcpDomains: ['workflows'] },
      { builtInMcpDomains: ['workflows', 'ping'] },
    )).toBe(false)
    expect(metaIsUnchanged(
      { builtInMcpDomains: ['workflows'] },
      { builtInMcpDomains: ['ping'] },
    )).toBe(false)
    // Order is content: the list is passed to a provider launch, so a
    // reordering is a different launch even if the set matches.
    expect(metaIsUnchanged(
      { builtInMcpDomains: ['workflows', 'ping'] },
      { builtInMcpDomains: ['ping', 'workflows'] },
    )).toBe(false)
  })

  it('sees a scalar change', () => {
    expect(metaIsUnchanged(
      { cwd: '/recorded', providerRuntime: 'headless' },
      { cwd: '/recorded', providerRuntime: 'terminal' },
    )).toBe(false)
  })

  it('counts a DISAPPEARING field as a change', () => {
    // withoutProvisionalProviderSession legitimately drops keys. Treating that
    // as a no-op would hand a caller a token that outlived the fact it stood
    // for, which is the opposite of the bug but just as wrong.
    expect(metaIsUnchanged(
      { cwd: '/recorded', providerSessionId: 'abc' },
      { cwd: '/recorded' },
    )).toBe(false)
  })

  it('counts an APPEARING field as a change', () => {
    expect(metaIsUnchanged(
      { cwd: '/recorded' },
      { cwd: '/recorded', tmuxName: 'agent-1' },
    )).toBe(false)
  })

  it('does not treat two different objects as equal just because neither is an array', () => {
    // Nothing on SessionMeta is a plain object today. If that changes, the
    // comparison must be taught the new shape rather than quietly reporting a
    // difference forever — this case is the tripwire for that.
    expect(metaIsUnchanged(
      { nested: { a: 1 } } as Meta,
      { nested: { a: 1 } } as Meta,
    )).toBe(false)
  })
})
