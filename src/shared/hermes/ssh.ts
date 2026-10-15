// SSH access to the server a Hermes connection runs on (#1528).
//
// Hermes is self-hosted on ANY VPS (Hostinger, Hetzner, a homelab box), so
// nothing here may know a vendor, an image name or a container name. What it
// knows is the system `ssh` and, optionally, Docker: the two things every
// "Hermes on a server" setup is made of.
//
// Pure on purpose: main validates and builds the command lines with these
// functions, the Settings form runs the same validation live, and the tests
// drive them with the recorded probe output (docs/plans/
// 2026-10-15-hermes-vps-terminal.md, Evidence).

/** Where the `hermes` CLI is on that server. */
export type HermesLocation =
  | { kind: 'host' }
  | { kind: 'docker'; container: string; shell: 'bash' | 'sh'; sudo: boolean }

export type HermesSshAccess = {
  /** `user@host`, `host`, or a `Host` alias from the user's ~/.ssh/config. */
  destination: string
  /** Absent: ssh's default or the config's `Port`. */
  port?: number
  /** Absent: ssh-agent and ~/.ssh/config decide. Stored as typed (`~` is fine, ssh expands it). */
  identityFile?: string
  /** Absent until detected or typed by the user. */
  hermes?: HermesLocation
}

/** What the Settings form sends; `container` empty = Hermes is on the host. */
export type HermesSshDraft = {
  destination: string
  port?: string
  identityFile?: string
  container?: string
  sudo?: boolean
}

// WHY validation this strict instead of shell quoting: the command line is
// TYPED into the user's own shell (plan Ruling 1), which may be zsh, bash or
// fish, and its remote half is parsed again by the server's login shell.
// Quoting rules differ across those (fish treats `\'` inside single quotes
// differently from POSIX). Values that can never NEED quoting read the same
// everywhere, so the only quoted word is the identity path, and that path is
// barred from holding a quote.
//
// The destination also must not start with `-`: `-oProxyCommand=…` as a
// "host" is the classic ssh argument injection (it runs a local command),
// and `-Jsome.host` passes every character check below while routing the
// session through a host the user never chose. A leading `-` is never a
// valid user or host name.
// Colons admit a bare IPv6 literal (`user@2001:db8::1`), the form ssh takes;
// brackets are scp/URL syntax and are not accepted.
const DESTINATION = /^(?:[A-Za-z0-9._%+~-]+@)?[A-Za-z0-9._:-]+$/
// Docker's own container-name grammar (`[a-zA-Z0-9][a-zA-Z0-9_.-]+`).
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
// Anything but quotes, backslashes and control characters. Spaces are fine
// (macOS paths have them); the path is single-quoted.
const IDENTITY = /^[^'"\\\u0000-\u001f\u007f]+$/

export function validateSshDraft(draft: HermesSshDraft): { access: Omit<HermesSshAccess, 'hermes'> & { hermes?: HermesLocation }; error?: never } | { error: string; access?: never } {
  const destination = draft.destination.trim()
  if (!destination) return { error: 'Enter the SSH destination: user@host, or a Host alias from ~/.ssh/config.' }
  if (destination.startsWith('-') || !DESTINATION.test(destination)) {
    return { error: 'The SSH destination must look like user@host, host, or an ~/.ssh/config alias (no spaces or options).' }
  }
  const portText = draft.port?.trim() ?? ''
  let port: number | undefined
  if (portText) {
    port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The SSH port must be a number from 1 to 65535.' }
  }
  const identityFile = draft.identityFile?.trim() || undefined
  if (identityFile && !IDENTITY.test(identityFile)) return { error: 'The identity file path cannot contain quotes or backslashes.' }
  const container = draft.container?.trim() ?? ''
  if (container && !CONTAINER.test(container)) return { error: 'That is not a Docker container name (letters, digits, _ . -).' }
  return {
    access: {
      destination,
      ...(port !== undefined ? { port } : {}),
      ...(identityFile ? { identityFile } : {}),
      // A typed container gets bash: every Hermes image seen so far has it
      // (the recorded one does), and Detect records `sh` when it does not.
      // Leaving the container empty does NOT mean "host": it means "not
      // decided" unless the user ran Detect, so the caller keeps any
      // detected location (see service.setSshAccess).
      ...(container ? { hermes: { kind: 'docker', container, shell: 'bash', sudo: draft.sudo === true } as const } : {}),
    },
  }
}

/** Same rules for a stored record (connections.json is hand-editable). */
export function isValidSshAccess(access: HermesSshAccess): boolean {
  if (access.destination.startsWith('-') || !DESTINATION.test(access.destination)) return false
  if (access.port !== undefined && (!Number.isInteger(access.port) || access.port < 1 || access.port > 65535)) return false
  if (access.identityFile !== undefined && !IDENTITY.test(access.identityFile)) return false
  if (access.hermes?.kind === 'docker' && !CONTAINER.test(access.hermes.container)) return false
  return true
}

/** `ssh` options shared by the probe and the terminals. */
export function sshArgs(access: HermesSshAccess): string[] {
  return [
    ...(access.port !== undefined ? ['-p', String(access.port)] : []),
    ...(access.identityFile ? ['-i', access.identityFile] : []),
  ]
}

/**
 * The line typed into a fresh terminal pane. `vps` is a shell on the server;
 * `hermes` is a shell where the `hermes` CLI works (the host itself, or
 * inside its container). Null when `hermes` has no known location: guessing
 * a container would open a shell somewhere the user did not ask for.
 */
export function sshCommandLine(access: HermesSshAccess, target: 'vps' | 'hermes'): string | null {
  if (!isValidSshAccess(access)) return null
  // -t: the remote side must get a TTY even when a command is given (docker
  // exec -it refuses to run without one: "the input device is not a TTY").
  const words = ['ssh', '-t', ...sshArgs(access).map((arg, index, all) => (all[index - 1] === '-i' ? `'${arg}'` : arg)), access.destination]
  if (target === 'vps') return words.join(' ')
  const location = access.hermes
  if (!location) return null
  if (location.kind === 'host') return words.join(' ')
  // Plain `sudo` (not `-n`) here: unlike the probe, this runs in a terminal
  // where the user CAN type a sudo password.
  return [...words, ...(location.sudo ? ['sudo'] : []), 'docker', 'exec', '-it', location.container, location.shell].join(' ')
}

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Sent to `sh -s` on the server over `ssh -o BatchMode=yes`. Stdin, not an
 * argument: the remote command is parsed by the user's LOGIN shell (which
 * may be fish or anything else), and `sh -s` is the one word every shell
 * passes through unchanged.
 *
 * WHY look INSIDE each running container for the command instead of
 * matching an image name: Hermes ships in vendor images (Hostinger's
 * `hvps-hermes-agent`), the official image, and home-made ones. The command
 * being there is the only thing they share. `sudo -n` never prompts, so a
 * docker that needs a password reports `denied` instead of hanging.
 *
 * The first line is a version stamp so a changed script and an old parser
 * can never silently disagree; `end` proves the output was not cut short.
 */
export const HERMES_PROBE_SCRIPT = `echo "agent-code-hermes-probe 1"
p=$(command -v hermes 2>/dev/null) && echo "host $p"
if command -v docker >/dev/null 2>&1; then
  if docker ps -q >/dev/null 2>&1; then d="docker"; echo "docker direct"
  elif sudo -n docker ps -q >/dev/null 2>&1; then d="sudo -n docker"; echo "docker sudo"
  else d=""; echo "docker denied"; fi
  if [ -n "$d" ]; then
    for c in $($d ps --format '{{.Names}}'); do
      p=$($d exec "$c" sh -c 'command -v hermes' 2>/dev/null) || continue
      [ -n "$p" ] || continue
      if $d exec "$c" sh -c 'command -v bash' >/dev/null 2>&1; then s=bash; else s=sh; fi
      echo "container $c $s $p"
    done
  fi
else
  echo "docker absent"
fi
echo "end"
`

export type HermesProbeResult = {
  hostPath: string | null
  docker: 'direct' | 'sudo' | 'denied' | 'absent'
  containers: Array<{ name: string; shell: 'bash' | 'sh'; hermesPath: string }>
}

/** Null when the output is not a complete probe answer (wrong stamp, cut short). */
export function parseHermesProbe(stdout: string): HermesProbeResult | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  // The stamp need not be the first line: a server's login banner or an rc
  // file's echo can come first on stdout. Everything before it is ignored.
  const start = lines.indexOf('agent-code-hermes-probe 1')
  if (start < 0 || lines.at(-1) !== 'end') return null
  const result: HermesProbeResult = { hostPath: null, docker: 'absent', containers: [] }
  for (const line of lines.slice(start + 1, -1)) {
    const [word, ...rest] = line.split(' ')
    if (word === 'host' && rest[0]) result.hostPath = rest.join(' ')
    else if (word === 'docker' && (rest[0] === 'direct' || rest[0] === 'sudo' || rest[0] === 'denied' || rest[0] === 'absent')) result.docker = rest[0]
    else if (word === 'container' && rest.length >= 3 && CONTAINER.test(rest[0]!) && (rest[1] === 'bash' || rest[1] === 'sh')) {
      result.containers.push({ name: rest[0]!, shell: rest[1], hermesPath: rest.slice(2).join(' ') })
    }
  }
  return result
}

export type HermesDetection =
  | { ok: true; location: HermesLocation; message: string }
  | { ok: false; message: string; candidates?: string[] }

/**
 * Exactly one place → use it. Anything else is the user's call, with a
 * sentence that says what was found. Never "pick the first": two containers
 * with `hermes` (a staging and a prod one) is exactly when guessing lands
 * the user in the wrong one.
 */
export function decideHermesLocation(probe: HermesProbeResult): HermesDetection {
  const sudo = probe.docker === 'sudo'
  const places = [
    ...(probe.hostPath ? [{ label: `the server itself (${probe.hostPath})`, location: { kind: 'host' } as HermesLocation }] : []),
    ...probe.containers.map((container) => ({
      label: `container ${container.name}`,
      location: { kind: 'docker', container: container.name, shell: container.shell, sudo } as HermesLocation,
    })),
  ]
  if (places.length === 1) {
    const only = places[0]!
    return { ok: true, location: only.location, message: `Hermes runs in ${only.label}${sudo ? ' (Docker through sudo)' : ''}.` }
  }
  if (places.length > 1) {
    return {
      ok: false,
      message: `Hermes was found in ${places.length} places: ${places.map((place) => place.label).join(', ')}. Type the container to use (leave it empty for the server itself).`,
      candidates: probe.containers.map((container) => container.name),
    }
  }
  if (probe.docker === 'denied') {
    return { ok: false, message: 'No hermes command on the server, and Docker needs a password for this user (sudo -n failed). Type the Hermes container name and tick "Docker needs sudo".' }
  }
  return { ok: false, message: probe.docker === 'absent' ? 'No hermes command on the server and no Docker. Is Hermes installed on this server?' : 'No hermes command on the server or in any running container. Is Hermes running?' }
}

/**
 * ssh's own words for a failed probe, plus the one step that fixes the
 * common cases. Probes run with BatchMode, so anything that would have asked
 * a question (a new host key, a passphrase, a password) fails instead.
 */
export function describeSshFailure(exitCode: number | null, stderr: string): string {
  const last = stderr.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? `ssh exited with ${exitCode ?? 'a signal'}`
  if (/Host key verification failed/i.test(stderr)) {
    return `${last} Run Open VPS Terminal once and accept the server's host key, then detect again.`
  }
  if (/Permission denied/i.test(stderr)) {
    return `${last} Agent Code signs in with your SSH key only (never a password): set the identity file, or add the key to ssh-agent with ssh-add if it has a passphrase.`
  }
  return last
}
