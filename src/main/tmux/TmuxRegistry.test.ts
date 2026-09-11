import { describe, expect, it } from 'vitest'

import { parsePaneForegroundListing } from './TmuxRegistry.js'

// The listing is parsed from ONE `tmux list-panes -a` per poll across every
// managed session, and the user's own tmux sessions share the default server,
// so the parser is where "only ours" and "one answer per session" are enforced.
describe('parsePaneForegroundListing', () => {
  it('keeps managed sessions, prefers the active pane, and preserves tabs in paths', () => {
    const output = [
      'agentcode-1\t0\tzsh\t/work/a',
      'agentcode-1\t1\tnpm\t/work/a',
      'agentcode-2\t1\tzsh\t/work/with\ttab',
      'personal\t1\tvim\t/home/me',
      'malformed',
      '',
    ].join('\n')
    expect(parsePaneForegroundListing(output, 'agentcode-')).toEqual(new Map([
      ['agentcode-1', { command: 'npm', cwd: '/work/a' }],
      ['agentcode-2', { command: 'zsh', cwd: '/work/with\ttab' }],
    ]))
  })
})
