import { describe, expect, it } from 'vitest'

import { revealRecoveryFile } from './recoveryStateActions'

// The helper's contract, branch by branch (#1424 review c), and its ordering
// rule (review b): a successful reveal clears only the reveal's OWN earlier
// message, never a newer, more important one such as a failed Reset.

function row(initial: string | null = null) {
  let error = initial
  const setError = (next: string | null | ((current: string | null) => string | null)) => {
    error = typeof next === 'function' ? next(error) : next
  }
  return { setError, error: () => error }
}

describe('revealRecoveryFile', () => {
  it('shows main\'s refusal message, or the fallback when it has none', async () => {
    const a = row()
    await revealRecoveryFile(async () => ({ ok: false, message: 'No managed skill recovery file exists.' }), a.setError)
    expect(a.error()).toBe('No managed skill recovery file exists.')
    const b = row()
    await revealRecoveryFile(async () => ({ ok: false }), b.setError)
    expect(b.error()).toBe("Couldn't reveal the state file.")
    const c = row()
    await revealRecoveryFile(async () => ({ ok: false }), c.setError, "Couldn't reveal that folder.")
    expect(c.error()).toBe("Couldn't reveal that folder.")
  })

  it('says a rejected request in fixed words, never the IPC text', async () => {
    const a = row()
    await revealRecoveryFile(async () => { throw new Error("Error invoking remote method: EACCES '/Users/someone/state.json'") }, a.setError)
    expect(a.error()).toBe("Couldn't reveal the state file.")
  })

  it('clears its own earlier message on a later success', async () => {
    const a = row()
    await revealRecoveryFile(async () => ({ ok: false, message: 'gone' }), a.setError)
    await revealRecoveryFile(async () => ({ ok: true }), a.setError)
    expect(a.error()).toBeNull()
  })

  it('never clears a newer error it did not set', async () => {
    const a = row('Couldn\'t reset the state. Try again.')
    await revealRecoveryFile(async () => ({ ok: true }), a.setError)
    expect(a.error()).toBe('Couldn\'t reset the state. Try again.')
    // Even after its own failure, a later failure elsewhere wins.
    const b = row()
    await revealRecoveryFile(async () => ({ ok: false, message: 'gone' }), b.setError)
    b.setError('Couldn\'t reset the state. Try again.')
    await revealRecoveryFile(async () => ({ ok: true }), b.setError)
    expect(b.error()).toBe('Couldn\'t reset the state. Try again.')
  })
})
