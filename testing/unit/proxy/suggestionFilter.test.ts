import { describe, it, expect } from 'vitest'

// Imported across the submodule boundary by relative path: the package has
// no test runner of its own, and agent-code's vitest `unit` project globs
// testing/unit/**. There is no @claude-code-headless path alias, so the
// relative path is the contract.
import { shouldFilterSuggestion } from '../../../packages/claude-code-headless/src/proxy/suggestionFilter'

describe('shouldFilterSuggestion', () => {
  it('keeps a real short suggestion', () => {
    expect(shouldFilterSuggestion('run the tests')).toBe(false)
    expect(shouldFilterSuggestion('commit this')).toBe(false)
    expect(shouldFilterSuggestion('yes')).toBe(false) // allowed single word
    expect(shouldFilterSuggestion('/compact')).toBe(false) // slash command
  })
  it('drops empty / meta / silence', () => {
    expect(shouldFilterSuggestion('')).toBe(true)
    expect(shouldFilterSuggestion('   ')).toBe(true)
    expect(shouldFilterSuggestion(null)).toBe(true)
    expect(shouldFilterSuggestion('silence')).toBe(true)
    expect(shouldFilterSuggestion('(silence — nothing obvious)')).toBe(true)
    expect(shouldFilterSuggestion('no suggestion')).toBe(true)
  })
  it('drops evaluative / claude-voice / formatted / over-long', () => {
    expect(shouldFilterSuggestion('looks good')).toBe(true)
    expect(shouldFilterSuggestion('Let me run the tests')).toBe(true)
    expect(shouldFilterSuggestion('do this.\nThen that')).toBe(true)
    expect(shouldFilterSuggestion('a '.repeat(60))).toBe(true) // too many words
    expect(shouldFilterSuggestion('x'.repeat(120))).toBe(true) // too long
  })
})
