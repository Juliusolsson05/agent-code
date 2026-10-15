# Hermes VPS terminal: a shell on the server, or inside Hermes, over SSH

Issue: #1528. Size: standard plan. The shape is known (an SSH command typed
into an ordinary terminal pane); the only open design choice is how to find
Hermes on an arbitrary server.

## Outcome

From Agent Code, any Hermes user can open:

- **Open VPS Terminal**: a shell on the server that runs Hermes;
- **Open Hermes Terminal**: a shell where the `hermes` CLI works, either on
  the host (a host install) or inside the Docker container that runs Hermes.

Both are ordinary terminal panes running the system `ssh`. This replaces the
vendor web console (Hostinger's, in the owner's case) for `hermes config`,
`hermes mcp login`, `.env` edits and similar work.

It must be provider-neutral. Hermes is self-hosted on any VPS, so nothing may
assume Hostinger, a container name or an image name.

## Evidence (verified, do not re-derive)

- **The owner's VPS** (Hostinger, Ubuntu 24.04, logged in as root with a key)
  runs Hermes v0.22.0 in the container `hermes-agent-pjlj-hermes-agent-1`,
  image `ghcr.io/hostinger/hvps-hermes-agent:latest`. traefik also runs.
  - There is no `hermes` on the host's PATH.
  - Inside the container, `hermes` is at `/opt/hermes/bin/hermes` (on the
    image's PATH, and also on a login shell's PATH through
    `/usr/local/bin/hermes`). bash is present, the user is root, and the
    working directory is `/opt/hermes`.
  - So container detection must look for the command inside each running
    container; the image name proves nothing.
- **Recorded probe output** (the draft probe script in this plan, run over
  `ssh -o BatchMode=yes … sh -s` against that VPS):
  ```
  agent-code-hermes-probe 1
  docker direct
  container hermes-agent-pjlj-hermes-agent-1 bash /opt/hermes/bin/hermes
  end
  ```
- **Recorded ssh failures**, both exit 255:
  - `ssh: Could not resolve hostname <host>: nodename nor servname provided, or not known`
  - `<user>@<host>: Permission denied (publickey,password).`
  - `ssh -i <path>` with a missing key prints
    `Warning: Identity file … not accessible` before the denial.
- **ssh expands `~` in `-i` itself** (ssh.c `tilde_expand_filename`). A
  single-quoted `'~/.ssh/key'` therefore still works.
- **Terminal panes:**
  - `workspace.splitFocused('terminal')` is the one creation flow
    (`src/renderer/src/workspace/hook/actions/pane.ts`).
  - `window.api.sendInput(sessionId, data)` writes raw bytes to the PTY.
  - With tmux available, the shell lives in a tmux session that survives an
    app restart.

## Design

### Settings: an optional "SSH access" block per connection

`StoredHermesConnection.ssh?: HermesSshAccess` in `connections.json`:

```
HermesSshAccess = {
  destination: string        // `user@host`, `host`, or an ~/.ssh/config Host alias
  port?: number              // 1..65535; absent = ssh's own default / config
  identityFile?: string      // absent = ssh-agent / ~/.ssh/config decide
  hermes?: HermesLocation    // where the hermes CLI is; absent = not detected yet
}
HermesLocation = { kind: 'host' } | { kind: 'docker'; container: string; shell: 'bash' | 'sh'; sudo: boolean }
```

- **No passwords or key material.** Only the path the user typed is stored.
  `~/.ssh/config` is never touched.
- **Strict validation in main (`src/shared/hermes/ssh.ts`, pure):**
  - destination: no whitespace, no leading `-`, a safe character set;
  - container: Docker's name grammar;
  - identity path: no quotes and no control characters.
- **Why validate this strictly:** the command is TYPED into the user's local
  shell (see Ruling 1), and that shell may be zsh, bash or fish. Values that
  can never need quoting, plus single quotes around the one path, read the
  same in all three.
- The URL connection and its sign-in are unchanged. SSH is a separate,
  optional path to the same server.

### Detect where Hermes runs (main)

- `HermesConnectionService.detectHermes(id)` runs:

  ```
  ssh -o BatchMode=yes -o ConnectTimeout=10 [-p N] [-i F] <dest> sh -s
  ```

  with the probe script on stdin, which avoids quoting through the remote
  login shell.
- The probe prints a line protocol: `host <path>`,
  `docker direct|sudo|denied|absent`, `container <name> <shell> <path>`,
  `end`.
- `parseHermesProbe` (pure) turns it into candidates.
- `decideHermesLocation` picks exactly one candidate, or returns a sentence
  for each other case:
  - none found, with a different sentence when docker needs a password;
  - several found (the user types the container);
  - ssh failed: the last stderr line, plus a hint for host-key or auth
    failures ("open VPS Terminal once to accept the host key", "add your key
    to ssh-agent").
- A single result is saved to `ssh.hermes`. With several or none, the user
  types the container by hand in Settings.

### Commands

- **Open VPS Terminal** and **Open Hermes Terminal** are app-surface palette
  commands. Each one:
  1. resolves a connection: the focused Hermes pane's connection if it has
     SSH access; otherwise the first connection with SSH access (Ruling 2);
  2. asks main for the command line with
     `hermesShellCommand(id, 'vps' | 'hermes')`;
  3. opens a terminal with `splitFocused('terminal')`, which now returns the
     new session id;
  4. writes `command + '\r'` into it.
- The Hermes command without a detected location says so ("Detect where
  Hermes runs in Settings → Hermes") instead of guessing.
- Command lines:
  - VPS: `ssh -t [-p N] [-i 'F'] <dest>`
  - Hermes, host install: same as VPS.
  - Hermes, container: `ssh -t … <dest> [sudo] docker exec -it <container> <shell>`.
    Every remote word is validated, so the remote shell parses it the same
    way everywhere.

### Ruling 1: type the command into an ordinary terminal, do not spawn ssh as the pane's process

- **Ruling:** open a normal shell pane and type `ssh …⏎` into it.
- **Why:**
  - Zero changes to spawn, recovery, tmux or persistence plumbing. A
    spawn-time command would have to be threaded through
    `SessionSpawnSelection`, `spawnSession`, recover options, rehydrate and
    replace.
  - When ssh exits or fails, its error stays on screen in a local shell where
    ↑⏎ reconnects.
  - The user sees the exact command and can copy it.
  - tmux keeps the session alive across an app restart.
- **Cost if wrong:** shell rc files that discard typeahead would drop the
  command. zsh, bash and fish all keep PTY typeahead, including p10k instant
  prompt. If one does not, the command is still visible in history.

### Ruling 2: which connection a command uses

- **Ruling:** the focused Hermes pane's connection, else the first connection
  with SSH access. The command's toast names the connection used.
- **Why:** palette commands take no arguments. A connection picker is not
  justified while the common case is one Hermes server.
- **Cost if wrong:** a multi-server user has to focus a pane of that server
  first. A picker can be added later.

## Tests

- `src/shared/hermes/ssh.test.ts` (pure):
  - **Fixtures:**
    - recording: the probe output above, verbatim;
    - mechanical mutations of it: host install; two containers; docker
      `sudo`; docker `denied` with no host; `absent`; a truncated output
      without `end`.
  - **Asserts:**
    - candidates and the decision sentence for each case;
    - the command lines for VPS, a host install, a container, sudo and a
      port with an identity file;
    - validation rejects `-oProxyCommand=…`, whitespace, `;` and quotes.
  - **Pre-fix failure:** none of this exists yet, and each guard is
    mutation-checked.
- `src/main/hermes/sshAccess.test.ts`:
  - the service's `detectHermes` with an injected runner;
  - the recorded failures (exit 255 with the two real stderr lines) map to the
    right sentences;
  - a single container is persisted to `connections.json`;
  - `setSshAccess` validates, and clearing it removes the block;
  - the ssh block round-trips through `loadHermesConnections`, and a
    malformed block is dropped without losing the connection.
- Renderer: `HermesConnectionsRow.renderer.test.tsx` gains one test, "Save
  SSH access sends the validated draft", plus the detect result line.

## Verification

- `npx tsc -b tsconfig.node.json`, `npx tsc -p tsconfig.web.json --noEmit`,
  then the scoped vitest runs and one full suite at the end.
- **Live:** the real probe against the owner's VPS (done in Evidence).
- **Boundary:** I never launch the app (owner rule). The pane opening and the
  typed command are covered by the code path and tests, not by a visual
  check. The owner verifies "Open Hermes Terminal" lands in
  `/opt/hermes` with `hermes` on PATH.

## Out of scope

- Password authentication, Kubernetes, and Hermes running on this Mac.
- Managing `~/.ssh/config` or keys.
- A connection picker for the commands (Ruling 2).
- Settings buttons that open the terminal. Settings has no workspace handle;
  the commands are the way in, and Settings says so.
