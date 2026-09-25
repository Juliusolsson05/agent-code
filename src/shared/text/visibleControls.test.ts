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

  it('escapes EVERY carriage return, including one inside a CRLF', () => {
    // "CRLF is just a line ending" is a Windows text assumption, and this is
    // a command: bash reads `./check.sh\r\n` as an instruction to run a file
    // whose name ends in CR, and #1049's review executed that file instead of
    // the intended one. A line feed is left alone — it is the break the <pre>
    // already shows.
    expect(withVisibleControls('echo safe\rrm -rf /')).toBe('echo safe⟨U+000D CR⟩rm -rf /')
    expect(withVisibleControls('./check.sh\r\n')).toBe('./check.sh⟨U+000D CR⟩\n')
    expect(containsInvisibleControls('./check.sh\r\n')).toBe(true)
  })

  it('escapes every character Unicode defines as invisible, not a hand-picked list', () => {
    // The first version enumerated the bidi and zero-width families and was
    // still short by these, each of which makes two different commands render
    // identically. Reproduced in review: `./check.sh` and `./check.sh\uFE0F`
    // execute different files.
    for (const [text, expected] of [
      ['./check.sh\uFE0F', './check.sh⟨U+FE0F⟩'],            // variation selector 16
      ['git\u034Fpush', 'git⟨U+034F CGJ⟩push'],               // combining grapheme joiner
      ['rm\u180E -rf', 'rm⟨U+180E⟩ -rf'],                     // Mongolian vowel separator
      ['a\u17B4b', 'a⟨U+17B4⟩b'],                             // Khmer inherent vowel
      ['x\u2062y', 'x⟨U+2062 INVISIBLE TIMES⟩y'],             // invisible math operator
      ['sudo\u{E0041}', 'sudo⟨U+E0041⟩'],                     // tag character
      ['a\u{1D173}b', 'a⟨U+1D173⟩b'],                         // musical format control
    ] as const) {
      expect(withVisibleControls(text)).toBe(expected)
      expect(containsInvisibleControls(text)).toBe(true)
    }
  })

  it('leaves ordinary text alone, including every non-Latin script and ordinary accents', () => {
    // Combining accents are NOT blanket-escaped: they render, and treating
    // every combining mark as an attack would make ordinary prose unreadable
    // (#1049 review).
    for (const text of ['npm run build', 'grep -R "café" .', 'grep -R "cafe\u0301" .', 'echo "日本語"', 'echo "العربية"', 'tab\there\nnewline']) {
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
