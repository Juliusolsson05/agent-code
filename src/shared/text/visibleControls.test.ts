import { describe, expect, it } from 'vitest'

import { containsInvisibleControls, withVisibleControls } from './visibleControls'

// #1029. The threat is Trojan Source (CVE-2021-42574): text that a browser
// draws in a different order than a shell executes.

describe('visible controls in text a user is asked to approve', () => {
  it('escapes the bidi override that makes a destructive command read as a comment', () => {
    // The canonical attack: everything after the override is drawn
    // right-to-left, so `rm -rf ~/work` appears to be inside the comment.
    const spoofed = 'rm -rf ~/work ‮# this is fine‬'
    const shown = withVisibleControls(spoofed)
    expect(shown).toBe('rm -rf ~/work ⟨U+202E RLO⟩# this is fine⟨U+202C PDF⟩')
    expect(shown).not.toContain('‮')
  })

  it('escapes isolates, marks and zero-width characters, which hide text rather than reorder it', () => {
    expect(withVisibleControls('a⁦b⁩c')).toBe('a⟨U+2066 LRI⟩b⟨U+2069 PDI⟩c')
    expect(withVisibleControls('git​push')).toBe('git⟨U+200B ZWSP⟩push')
    expect(withVisibleControls('﻿sudo')).toBe('⟨U+FEFF BOM⟩sudo')
  })

  it('escapes a lone carriage return, which scrolls the rest of a line out of view', () => {
    expect(withVisibleControls('echo safe\rrm -rf /')).toBe('echo safe⟨U+000D CR⟩rm -rf /')
    // A real line ending is not an attack.
    expect(withVisibleControls('echo safe\r\nrm -rf /')).toBe('echo safe\r\nrm -rf /')
  })

  it('leaves ordinary text alone, including every non-Latin script', () => {
    for (const text of ['npm run build', 'grep -R "café" .', 'echo "日本語"', 'echo "العربية"', 'tab\there\nnewline']) {
      expect(withVisibleControls(text)).toBe(text)
      expect(containsInvisibleControls(text)).toBe(false)
    }
  })

  it('reports whether anything was hidden, for a caller that wants to warn', () => {
    expect(containsInvisibleControls('rm -rf ~/work ‮#ok')).toBe(true)
    expect(containsInvisibleControls('echo safe\rrm -rf /')).toBe(true)
    expect(containsInvisibleControls('echo "safe"')).toBe(false)
  })
})
