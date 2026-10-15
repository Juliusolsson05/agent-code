import { describe, expect, it } from 'vitest'

import {
  decideHermesLocation,
  describeSshFailure,
  parseHermesProbe,
  sshCommandLine,
  validateSshDraft,
  type HermesSshAccess,
} from './ssh.js'

// SSH access to a Hermes server (#1528).
//
// Fixtures:
//   RECORDED is the verbatim stdout of HERMES_PROBE_SCRIPT run over
//   `ssh -o BatchMode=yes … sh -s` against a real Hermes VPS on 2026-10-15
//   (Ubuntu 24.04, Hermes v0.22.0 in a vendor Docker image, traefik beside
//   it, no `hermes` on the host). Every other probe output below is a
//   MECHANICAL mutation of it (a line added, removed or swapped), one per
//   case the detection must tell apart. The ssh stderr lines are the real
//   messages recorded from macOS OpenSSH for each failure.
const RECORDED = 'agent-code-hermes-probe 1\ndocker direct\ncontainer hermes-agent-pjlj-hermes-agent-1 bash /opt/hermes/bin/hermes\nend\n'
const mutate = (lines: string[]) => `agent-code-hermes-probe 1\n${lines.join('\n')}\nend\n`

describe('where Hermes runs, from the probe', () => {
  it('the recorded server: one container that has the hermes command', () => {
    const probe = parseHermesProbe(RECORDED)!
    expect(probe).toEqual({ hostPath: null, docker: 'direct', containers: [{ name: 'hermes-agent-pjlj-hermes-agent-1', shell: 'bash', hermesPath: '/opt/hermes/bin/hermes' }] })
    expect(decideHermesLocation(probe)).toEqual({
      ok: true,
      location: { kind: 'docker', container: 'hermes-agent-pjlj-hermes-agent-1', shell: 'bash', sudo: false },
      message: 'Hermes runs in container hermes-agent-pjlj-hermes-agent-1.',
    })
  })

  it('a host install and no Docker', () => {
    const decision = decideHermesLocation(parseHermesProbe(mutate(['host /home/me/.local/bin/hermes', 'docker absent']))!)
    expect(decision).toMatchObject({ ok: true, location: { kind: 'host' } })
  })

  it('Docker through passwordless sudo: the terminal must use sudo too', () => {
    const decision = decideHermesLocation(parseHermesProbe(mutate(['docker sudo', 'container hermes sh /usr/local/bin/hermes']))!)
    expect(decision).toMatchObject({ ok: true, location: { kind: 'docker', container: 'hermes', shell: 'sh', sudo: true } })
  })

  it('two places is the user\'s call, never "the first one"', () => {
    const decision = decideHermesLocation(parseHermesProbe(mutate(['host /usr/bin/hermes', 'docker direct', 'container hermes-staging bash /opt/hermes/bin/hermes', 'container hermes-prod bash /opt/hermes/bin/hermes']))!)
    expect(decision.ok).toBe(false)
    expect(decision).toMatchObject({ candidates: ['hermes-staging', 'hermes-prod'] })
    expect(decision.message).toContain('3 places')
  })

  it('nothing found: Docker that needs a password says so', () => {
    expect(decideHermesLocation(parseHermesProbe(mutate(['docker denied']))!).message).toContain('sudo -n failed')
    expect(decideHermesLocation(parseHermesProbe(mutate(['docker absent']))!).message).toContain('no Docker')
    expect(decideHermesLocation(parseHermesProbe(mutate(['docker direct']))!).message).toContain('any running container')
  })

  it('an output cut short or from another script is no answer at all', () => {
    expect(parseHermesProbe(RECORDED.replace('end\n', ''))).toBeNull()
    expect(parseHermesProbe(RECORDED.replace('agent-code-hermes-probe 1', 'agent-code-hermes-probe 2'))).toBeNull()
  })

  it('a login banner before the stamp is ignored', () => {
    expect(parseHermesProbe(`Welcome to Ubuntu 24.04.4 LTS\n${RECORDED}`)?.containers).toHaveLength(1)
  })
})

describe('the command line typed into the terminal', () => {
  const access: HermesSshAccess = { destination: 'root@203.0.113.7', hermes: { kind: 'docker', container: 'hermes-agent-pjlj-hermes-agent-1', shell: 'bash', sudo: false } }

  it('VPS: a plain interactive ssh', () => {
    expect(sshCommandLine(access, 'vps')).toBe('ssh -t root@203.0.113.7')
  })

  it('Hermes in a container: docker exec with a TTY, into the detected shell', () => {
    expect(sshCommandLine(access, 'hermes')).toBe('ssh -t root@203.0.113.7 docker exec -it hermes-agent-pjlj-hermes-agent-1 bash')
    expect(sshCommandLine({ ...access, hermes: { kind: 'docker', container: 'h', shell: 'sh', sudo: true } }, 'hermes')).toBe('ssh -t root@203.0.113.7 sudo docker exec -it h sh')
  })

  it('port and key: the key path is quoted (spaces) and ssh expands the ~ itself', () => {
    expect(sshCommandLine({ destination: 'vps', port: 2222, identityFile: '~/My Keys/hermes', hermes: { kind: 'host' } }, 'hermes')).toBe("ssh -t -p 2222 -i '~/My Keys/hermes' vps")
  })

  it('no known location: no command, never a guessed container', () => {
    expect(sshCommandLine({ destination: 'vps' }, 'hermes')).toBeNull()
    expect(sshCommandLine({ destination: 'vps' }, 'vps')).toBe('ssh -t vps')
  })

  it('a stored record that fails validation builds nothing', () => {
    expect(sshCommandLine({ destination: '-oProxyCommand=open -a Calculator' }, 'vps')).toBeNull()
  })
})

describe('validating what the user types', () => {
  it('accepts user@host, a config alias, an IPv6 literal, a port and a key', () => {
    expect(validateSshDraft({ destination: ' root@203.0.113.7 ', port: '22', identityFile: '~/.ssh/hostinger_hermes' }).access).toEqual({ destination: 'root@203.0.113.7', port: 22, identityFile: '~/.ssh/hostinger_hermes' })
    expect(validateSshDraft({ destination: 'hermes-vps' }).access).toEqual({ destination: 'hermes-vps' })
    expect(validateSshDraft({ destination: 'me@2001:db8::1' }).access?.destination).toBe('me@2001:db8::1')
  })

  it('a typed container becomes the Hermes location', () => {
    expect(validateSshDraft({ destination: 'vps', container: 'hermes', sudo: true }).access?.hermes).toEqual({ kind: 'docker', container: 'hermes', shell: 'bash', sudo: true })
  })

  it.each([
    ['an ssh option posing as a host', { destination: '-oProxyCommand=touch /tmp/x' }],
    // Only the leading-dash rule stops this one: every character is legal in
    // a host name, and as an argument it routes the session through a
    // ProxyJump host the user never chose.
    ['an ssh option made only of host-name characters', { destination: '-Jjump.example' }],
    ['whitespace (a second argument)', { destination: 'root@host extra' }],
    ['a shell separator', { destination: 'host;reboot' }],
    ['a quote in the key path', { destination: 'host', identityFile: "~/.ssh/a'b" }],
    ['a port out of range', { destination: 'host', port: '70000' }],
    ['a container with a space', { destination: 'host', container: 'a b' }],
    ['a container with a shell separator', { destination: 'host', container: 'a;b' }],
  ])('refuses %s', (_label, draft) => {
    expect(validateSshDraft(draft).error).toBeTruthy()
  })
})

describe('why the probe could not run', () => {
  it('names the fix for the two failures BatchMode turns into errors', () => {
    expect(describeSshFailure(255, 'root@203.0.113.7: Permission denied (publickey,password).\n')).toContain('ssh-add')
    expect(describeSshFailure(255, 'Host key verification failed.\n')).toContain('accept the server\'s host key')
  })

  it('otherwise ssh\'s own last line, e.g. an unknown host', () => {
    expect(describeSshFailure(255, 'ssh: Could not resolve hostname no-such-host.invalid: nodename nor servname provided, or not known\n'))
      .toBe('ssh: Could not resolve hostname no-such-host.invalid: nodename nor servname provided, or not known')
  })
})
