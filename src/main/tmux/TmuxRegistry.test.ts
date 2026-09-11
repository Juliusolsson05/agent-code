import { describe, expect, it } from 'vitest'

import { parsePaneForegroundListing } from './TmuxRegistry.js'

// The listing is parsed from ONE `tmux list-panes -a` per poll across every
// managed session, and the user's own tmux sessions share the default server,
// so the parser is where "only ours" and "one answer per session" are enforced.
describe('parsePaneForegroundListing', () => {
  it('keeps managed sessions, prefers the active pane, and preserves tabs in paths', () => {
    // Fields are #{session_name}\t#{window_active}\t#{pane_active}\t
    // #{pane_current_command}\t#{pane_current_path} — every line below lives
    // in its session's (only) active window, so window_active is always '1'
    // here; the two-window interaction is covered by the next test.
    const output = [
      'agentcode-1\t1\t0\tzsh\t/work/a',
      'agentcode-1\t1\t1\tnpm\t/work/a',
      'agentcode-2\t1\t1\tzsh\t/work/with\ttab',
      'personal\t1\t1\tvim\t/home/me',
      'malformed',
      '',
    ].join('\n')
    expect(parsePaneForegroundListing(output, 'agentcode-')).toEqual(new Map([
      ['agentcode-1', { command: 'npm', cwd: '/work/a' }],
      ['agentcode-2', { command: 'zsh', cwd: '/work/with\ttab' }],
    ]))
  })

  it('prefers the active window over a background window\'s own active pane (M4)', () => {
    // A session with two windows. Window 2 (active window; window_active=1)
    // is listed FIRST and its active pane runs `npm` — this is what an
    // attached client actually sees. Window 1 (a background window;
    // window_active=0) is listed SECOND and its OWN active pane runs `vim` —
    // every tmux window tracks its own active pane independent of which
    // window is on screen, so pane_active='1' here does not mean "visible".
    // The background line is deliberately listed LAST: a pane_active-only
    // parser (the pre-M4 behavior) applies "last active line wins" and would
    // overwrite the correct `npm` answer with `vim` simply because it sorted
    // later in `list-panes -a`'s output — this ordering is what would catch
    // that regression.
    const output = [
      'agentcode-3\t1\t1\tnpm\t/work/fg',
      'agentcode-3\t0\t1\tvim\t/work/bg',
    ].join('\n')
    expect(parsePaneForegroundListing(output, 'agentcode-')).toEqual(new Map([
      ['agentcode-3', { command: 'npm', cwd: '/work/fg' }],
    ]))
  })
})
