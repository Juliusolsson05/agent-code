import { describe, expect, it } from 'vitest'
import { scrubParentAgentEnv } from './scrubParentAgentEnv'

describe('scrubParentAgentEnv', () => {
  it('removes the markers a parent Claude Code left on Agent Code but keeps user Claude config', () => {
    // The CLAUDE_CODE_* keys and values below are the ones `ps eww` showed on the running
    // Agent Code process in debug bundle f204f24f (the token was a random hex value there too).
    // A live PTY probe against Claude Code 2.1.310 showed that this inherited set turns
    // transcript saving off, and that the scrubbed set keeps it on.
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_MESSAGING_TOKEN: '50aa3c9a6b72c1d2ac45b5950773ba54',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'd2b6e139-709d-4d9d-887c-c18fc78a100f',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/27464.sock',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_EXECPATH: '/Users/juliusolsson/.local/share/claude/versions/2.1.310',
      CLAUDECODE: '1',
      CLAUDE_EFFORT: 'low',
      // User configuration that must survive.
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
      PATH: '/usr/bin',
    }

    const removed = scrubParentAgentEnv(env)

    expect(removed).toContain('CLAUDE_CODE_CHILD_SESSION')
    expect(env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
      PATH: '/usr/bin',
    })
  })
})
