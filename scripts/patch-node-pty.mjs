#!/usr/bin/env node
// =============================================================================
// Local patch for node-pty 1.1.0: stop leaking one /dev/ptmx per spawn on
// macOS. Runs from `postinstall` (package.json), BEFORE electron-rebuild,
// because the patch is to C++ source that the rebuild compiles. Issue #1437.
// =============================================================================
//
// WHAT THIS DOES
//
// Rewrites `pty_posix_spawn` in node_modules/node-pty/src/unix/pty.cc (the
// macOS-only spawn path; Linux uses forkpty and is untouched) to the shape
// of upstream microsoft/node-pty#882 ("fix: /dev/ptmx leak on macOS", merged
// 2026-01-28 as af053f22, for microsoft/vscode#182212), and makes
// `PtyFork` close the master and say which call failed when the spawn fails.
//
// WHY — THE UPSTREAM BUG
//
// 1.1.0 opens up to three ptmx fds into `low_fds` so that fds 0-2 are
// occupied before the real master is opened (a guard for a parent whose
// stdio is closed). The loop breaks at `count == 0` whenever stdio is
// already open — which in Electron is always — and the cleanup is
// `for (; count > 0; count--) close(low_fds[count]);`, which never closes
// `low_fds[0]`. So EVERY spawn leaks one PTY master that has no slave and no
// process. macOS caps PTYs system-wide (`kern.tty.ptmx_max`, 511 by default),
// so after ~500 agent/terminal spawns every new spawn — ours AND every other
// app's terminal on the machine — fails with "posix_spawnp failed.".
//
// Measured on the packaged app before this patch (#1437, 2026-09-27): main
// held 506 /dev/ptmx fds after 13.5 h while only 16 sessions were live, and
// exactly those 16 ttys still had a process. Orchestration reviewers (one
// agent each) and agent reloads are what push the spawn count that high.
//
// The same function has two smaller leaks that #882 also fixes, so we take
// them too rather than diverge from upstream:
//   - the parent's copy of the SLAVE fd is never closed. That keeps a live
//     reference to the tty for as long as the parent lives, and it also means
//     the master never sees the hangup when the child exits (node-pty then
//     relies on its 200 ms DESTROY_SOCKET_TIMEOUT fallback instead);
//   - every early `return` on an error leaks the master (and slave) and never
//     destroys the posix_spawn file actions/attrs, and the caller then throws
//     the generic "posix_spawnp failed." with no cause.
//
// WHY A SOURCE PATCH AND NOT A VERSION BUMP
//
// #882 has only shipped on the 1.2.0 BETA line (beta.10 and later; npm
// `latest` is still 1.1.0 as of 2026-09-27). Moving to the beta would bring
// unrelated ConPTY/API churn into every platform to get one function. This
// patch is that one function, as reviewed upstream. It is the same trade we
// made for @xterm/xterm in scripts/patch-xterm.mjs (#871).
//
// Why it ships: node-pty is compiled from source here — `postinstall` runs
// `electron-rebuild -f -w node-pty` right after this script, electron-builder
// rebuilds it per target arch at package time (prebuilds are excluded in
// electron-builder.yml), and node-pty's loader (lib/utils.js) prefers
// build/Release over prebuilds/. So the patched source is what every build
// and every packaged app runs.
//
// The error message keeps the "posix_spawnp failed" prefix on purpose: it is
// what users and earlier issues (#1437, the node-pty x64 rebuild trap) search
// for. Nothing in the app matches on the text (checked with grep).
//
// HOW IT IS GUARDED
//
// The whole pty.cc is identified by sha256, not by anchors alone: the
// pristine 1.1.0 file is patched, the already-patched file is a no-op
// (idempotent — postinstall runs on every `npm install`), and ANY other file
// fails the install. A silent no-op on a new node-pty version would quietly
// bring the leak back, so a loud failure is the point. package.json pins
// node-pty to exactly 1.1.0 for the same reason.
//
// WHEN THIS FAILS
//
// "unexpected pty.cc" means node-pty changed. Check whether the installed
// version contains #882 (grep pty.cc for `for (size_t i = 0; i <= count; i++)`
// in pty_posix_spawn). If it does — a stable release with the fix — delete
// this script and its postinstall entry and unpin node-pty. If it does not,
// re-derive the replacement against the new source and update both hashes.
// Never "fix" this by making the script skip unknown files.
// =============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// sha256 of node-pty 1.1.0's src/unix/pty.cc as published on npm, and of the
// same file after this patch. Both are exact: the patch output is
// deterministic, so a mismatch after patching means the replacement text
// below and PATCHED_SHA256 drifted apart.
export const PRISTINE_SHA256 = '5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6'
export const PATCHED_SHA256 = 'a3bf01c47a281de2ff2b7717f1659106bfeae7874d65ef127fc43f79f06ff902'

const MARKER = '// agent-code: patched per microsoft/node-pty#882 (issue #1437)'

// The forward declaration's `int* err` becomes `std::string* err`, so the
// failure can carry which call failed and its strerror.
const DECL_BEFORE = `                pid_t* pid,
                int* err);
#endif`
const DECL_AFTER = `                pid_t* pid,
                std::string* err);
#endif`

// PtyFork: `master` starts at -1 so a failure before posix_openpt is
// distinguishable, and a failed spawn closes the master it may have opened
// (1.1.0 leaked it and threw without a cause).
const FORK_BEFORE = `  pid_t pid;
  int master;
#if defined(__APPLE__)`
const FORK_AFTER = `  pid_t pid;
  int master = -1;
#if defined(__APPLE__)`

const CALL_BEFORE = `  int err = -1;
  pty_posix_spawn(argv, env, term, &winp, &master, &pid, &err);
  if (err != 0) {
    throw Napi::Error::New(napiEnv, "posix_spawnp failed.");
  }`
const CALL_AFTER = `  std::string err;
  pty_posix_spawn(argv, env, term, &winp, &master, &pid, &err);
  if (!err.empty()) {
    if (master != -1) {
      close(master);
    }
    throw Napi::Error::New(napiEnv, "posix_spawnp failed: " + err);
  }`

// The whole macOS definition, from its #if to its #endif. Replaced as one
// block (rather than line edits) so the result is exactly #882's control
// flow: every exit goes through `done:`, which closes the slave and every
// low_fds entry that was opened.
const FN_START = `#if defined(__APPLE__)
static void
pty_posix_spawn(char** argv, char** env,`
const FN_END = `  for (; count > 0; count--) {
    close(low_fds[count]);
  }
}
#endif`

const FN_AFTER = `#if defined(__APPLE__)
${MARKER}
static std::string format_error(const char* func, int err_code) {
  char buf[256];
  snprintf(buf, sizeof(buf), "%s: %s", func, strerror(err_code));
  return buf;
}

static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                std::string* err) {
  int low_fds[3];
  size_t count = 0;
  int res = 0;
  int slave = -1;
  char slave_pty_name[128];
  int spawn_err;
  sigset_t signal_set;

  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;
  }

  int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |
              POSIX_SPAWN_SETSIGDEF |
              POSIX_SPAWN_SETSIGMASK |
              POSIX_SPAWN_SETSID;

  posix_spawn_file_actions_t acts;
  posix_spawn_file_actions_init(&acts);

  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);

  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    *err = format_error("posix_openpt failed", errno);
    goto done;
  }

  res = grantpt(*master);
  if (res == -1) {
    *err = format_error("grantpt failed", errno);
    goto done;
  }

  res = unlockpt(*master);
  if (res == -1) {
    *err = format_error("unlockpt failed", errno);
    goto done;
  }

  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    *err = format_error("ioctl(TIOCPTYGNAME) failed", errno);
    goto done;
  }

  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    *err = format_error("open slave pty failed", errno);
    goto done;
  }

  if (termp) {
    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      *err = format_error("tcsetattr failed", errno);
      goto done;
    };
  }

  if (winp) {
    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      *err = format_error("ioctl(TIOCSWINSZ) failed", errno);
      goto done;
    }
  }

  posix_spawn_file_actions_adddup2(&acts, slave, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDERR_FILENO);
  posix_spawn_file_actions_addclose(&acts, slave);
  posix_spawn_file_actions_addclose(&acts, *master);

  spawn_err = posix_spawnattr_setflags(&attrs, flags);
  if (spawn_err != 0) {
    *err = format_error("posix_spawnattr_setflags failed", spawn_err);
    goto done;
  }

  /* Reset all signal the child to their default behavior */
  sigfillset(&signal_set);
  spawn_err = posix_spawnattr_setsigdefault(&attrs, &signal_set);
  if (spawn_err != 0) {
    *err = format_error("posix_spawnattr_setsigdefault failed", spawn_err);
    goto done;
  }

  /* Reset the signal mask for all signals */
  sigemptyset(&signal_set);
  spawn_err = posix_spawnattr_setsigmask(&attrs, &signal_set);
  if (spawn_err != 0) {
    *err = format_error("posix_spawnattr_setsigmask failed", spawn_err);
    goto done;
  }

  do
    spawn_err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (spawn_err == EINTR);
  if (spawn_err != 0) {
    *err = format_error("posix_spawn failed", spawn_err);
  }
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);
  if (slave != -1) {
    close(slave);
  }

  // THE #1437 FIX: close every low_fds entry that was opened, INCLUDING
  // low_fds[0]. 1.1.0 counted down to 1 and leaked index 0 on every spawn.
  // One deliberate difference from #882: \`i < 3\` bounds the loop. When all
  // three opens land below fd 2 the loop above exits with count == 3, and
  // #882's \`i <= count\` would then read low_fds[3], past the array. The
  // -1 check skips a posix_openpt that failed (close(-1) is harmless, but
  // there is no reason to issue it).
  for (size_t i = 0; i <= count && i < 3; i++) {
    if (low_fds[i] != -1) {
      close(low_fds[i]);
    }
  }
}
#endif`

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first === -1 || source.indexOf(before, first + 1) !== -1) {
    throw new Error(`patch-node-pty: anchor "${label}" not found exactly once`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

/** Pure transform of pristine 1.1.0 pty.cc text into the patched text. */
export function patchPtySource(source) {
  let out = replaceOnce(source, DECL_BEFORE, DECL_AFTER, 'forward declaration')
  out = replaceOnce(out, FORK_BEFORE, FORK_AFTER, 'PtyFork master init')
  out = replaceOnce(out, CALL_BEFORE, CALL_AFTER, 'PtyFork spawn call')
  const start = out.indexOf(FN_START)
  const endAt = out.indexOf(FN_END, start)
  if (start === -1 || endAt === -1 || out.indexOf(FN_START, start + 1) !== -1) {
    throw new Error('patch-node-pty: anchor "pty_posix_spawn definition" not found exactly once')
  }
  return out.slice(0, start) + FN_AFTER + out.slice(endAt + FN_END.length)
}

/**
 * Patches the file in place. Returns 'patched' or 'already-patched'; throws on
 * any file that is neither pristine 1.1.0 nor this patch's exact output.
 */
export function patchPtyFile(file) {
  const source = readFileSync(file, 'utf8')
  const hash = sha256(source)
  if (hash === PATCHED_SHA256) return 'already-patched'
  if (hash !== PRISTINE_SHA256) {
    throw new Error(
      `patch-node-pty: unexpected pty.cc (sha256 ${hash}). node-pty is no longer ` +
      'the pinned 1.1.0 — see WHEN THIS FAILS in scripts/patch-node-pty.mjs.',
    )
  }
  const patched = patchPtySource(source)
  const patchedHash = sha256(patched)
  if (patchedHash !== PATCHED_SHA256) {
    throw new Error(
      `patch-node-pty: patched output sha256 ${patchedHash} does not match ` +
      'PATCHED_SHA256; the replacement text and the recorded hash drifted apart.',
    )
  }
  writeFileSync(file, patched)
  return 'patched'
}

// CLI entry (postinstall). Resolved from the repo root, not the cwd, because
// npm runs postinstall with cwd = package root but a manual run may not.
//
// WHY real paths on both sides (#1439 review b): Node resolves import.meta.url
// to the REAL path of the module, while process.argv[1] is the path as typed.
// Run through a symlink (/tmp -> /private/tmp on macOS, a symlinked checkout)
// the two differed, this body never ran, and the script exited 0 without
// patching or a word — the silent skip the whole script exists to prevent.
// An unresolvable argv[1] (no script path at all) is simply "not run as a
// command", which is the import-for-tests case.
const invokedAs = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : null
  } catch {
    return null
  }
})()
if (invokedAs !== null && invokedAs === realpathSync(fileURLToPath(import.meta.url))) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const file = join(root, 'node_modules', 'node-pty', 'src', 'unix', 'pty.cc')
  if (!existsSync(file)) {
    // Fail rather than skip: without the source, electron-rebuild would build
    // nothing we patched, and a silent skip is how the leak comes back.
    throw new Error(`patch-node-pty: ${file} is missing`)
  }
  console.log(`patch-node-pty: ${patchPtyFile(file)}`)
}
