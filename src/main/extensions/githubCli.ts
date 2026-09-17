import { execFile } from 'node:child_process'

/**
 * The `execFile` shape this module needs, injected like `ConsentPrompt` in
 * install.ts: production gets the real child_process call, tests get a fake
 * that can produce ENOENT / non-zero exits / timeouts without owning the
 * machine state that causes them.
 */
export type ExecFile = (
  command: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void

const defaultExecFile: ExecFile = (command, args, options, callback) => {
  execFile(command, args, options, (error, stdout, stderr) =>
    callback(error ?? null, String(stdout ?? ''), String(stderr ?? '')),
  )
}

// 5s, not longer: this runs on the install path with the Settings row already
// showing "Installing…". A healthy `gh auth token` returns in tens of
// milliseconds; anything past five is a wedged binary the user should not wait
// for, and the anonymous path is always an acceptable answer.
export const GH_TOKEN_TIMEOUT_MS = 5_000

// A gh token is one opaque line, ~40–255 chars. The cap exists so garbage
// output (a pager, an error banner, a shell profile leak) can never become an
// Authorization header — 4096 is far above any real token and far below
// anything that would bloat request headers.
const MAX_TOKEN_CHARS = 4096

/**
 * Resolve the user's GitHub CLI token, or null.
 *
 * ── THE CONTRACT: THIS CAN NEVER FAIL AN INSTALL ──
 * Every failure mode — gh missing, not logged in, token revoked, binary hung,
 * garbage output — returns null, and the caller proceeds anonymously exactly
 * as before this module existed. The credential is an upgrade, never a
 * dependency.
 *
 * ── TOKEN HYGIENE (hard rules, enforced by shape) ──
 * The token exists only in main-process memory, only inside the two
 * api.github.com requests of one install attempt. It is never logged (error
 * paths stringify URLs, never headers), never persisted, never crosses IPC,
 * and is read from stdout — never from argv, where any process listing would
 * see it.
 */
export async function resolveGitHubCliToken(
  execFileImpl: ExecFile = defaultExecFile,
): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false
    const done = (value: string | null): void => {
      // execFile's callback contract is single-shot, but a defensive settle
      // guard costs nothing and makes a double-call bug inert.
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      execFileImpl(
        'gh',
        ['auth', 'token'],
        { timeout: GH_TOKEN_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          // ENOENT (not installed), non-zero exit (not logged in / revoked),
          // and ETIMEDOUT (wedged binary) all arrive as the same thing here:
          // a reason to be anonymous.
          if (error) return done(null)
          const token = stdout.trim()
          if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return done(null)
          done(token)
        },
      )
    } catch {
      // A synchronous throw from a broken runner is still "no credential".
      done(null)
    }
  })
}

/**
 * Headers for api.github.com, with or without the resolved credential.
 * Kept pure so the exact wire shape (and the never-send-an-empty-bearer rule)
 * is unit-testable beside the installer's other pure helpers.
 */
export function githubApiHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'agent-code',
  }
  // Only attach when present: a malformed/empty authorization header earns a
  // 401 even where anonymous access would have succeeded, so absence must mean
  // the header is truly absent.
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}
