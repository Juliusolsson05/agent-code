#!/usr/bin/env node
// Isolated tmux smoke test for packaged Agent Code.
//
// Exercises every tmux command path Agent Code actually invokes, using
// the SAME bundled tmux binary the packaged app resolves at runtime and
// a private TMUX_TMPDIR so this run never collides with the user's own
// tmux server. Failure at any step exits non-zero with an explanation.
//
// WHY this exists as a shell-level smoke:
//
//   The vitest suite covers TmuxRegistry's TypeScript logic with mocks;
//   what those tests cannot cover is whether the bundled binary itself
//   spawns cleanly on this particular Mac, honours the isolated socket
//   directory, tolerates a minimal PATH the way a Finder-launched app
//   would inherit, and survives the exact node-pty attach the renderer
//   does. All of those are packaged-mode failure modes the user has
//   reported. This script drives them end-to-end.
//
// WHY the test uses a bundled path resolver (not just `tmux` on $PATH):
//
//   Agent Code deliberately refuses to fall back to a Homebrew tmux
//   because the packaged app has to work on machines with no Homebrew.
//   Simulating that policy means the smoke MUST use whatever tmux the
//   `third_party/tmux/cache/<arch>/tmux` resolver would pick. That
//   surface fails silently if the fetch scripts were skipped, so we
//   also enumerate the cache directory and print the exact path.
//
// Usage:
//   node scripts/tmux-smoke.mjs                # normal run (inherits PATH)
//   node scripts/tmux-smoke.mjs --minimal-env  # Finder-launched simulation
//
// The --minimal-env flag clears PATH-shaped env vars before spawning so
// we reproduce the "app launched from Dock" environment where no shell
// rc file has run. Any test that starts passing with the flag OFF and
// failing with it ON is a real packaged-mode regression.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

// -----------------------------------------------------------------------------
// Args + platform detection
// -----------------------------------------------------------------------------

const MINIMAL_ENV = process.argv.includes('--minimal-env')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function currentPlatformKey() {
  const archMap = { x64: 'x86_64', arm64: 'arm64' }
  const arch = archMap[osArch()]
  if (!arch) return null
  if (osPlatform() === 'darwin') return `darwin-${arch}`
  return null
}

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------

const results = []
let currentSection = null

function section(name) {
  currentSection = name
  console.log(`\n== ${name} ==`)
}

// Sentinel a step function can throw to opt out of a test — used when
// the environment simply cannot exercise a check (e.g. no pty available
// from a piped stdin), as distinct from an actual product failure.
class SkipStep extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'SkipStep'
  }
}

async function step(name, fn) {
  process.stdout.write(`  [ ] ${name}`)
  const start = Date.now()
  try {
    await fn()
    const ms = Date.now() - start
    process.stdout.write(`\r  [✓] ${name} (${ms}ms)\n`)
    results.push({ section: currentSection, name, ok: true, ms })
  } catch (err) {
    const ms = Date.now() - start
    if (err instanceof SkipStep) {
      process.stdout.write(`\r  [~] ${name} (skipped)\n`)
      console.log(`      ${err.message}`)
      results.push({ section: currentSection, name, ok: true, skipped: true, ms })
      return
    }
    process.stdout.write(`\r  [x] ${name} (${ms}ms)\n`)
    console.error(`      ${err instanceof Error ? err.message : String(err)}`)
    results.push({
      section: currentSection,
      name,
      ok: false,
      ms,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// -----------------------------------------------------------------------------
// tmux command runners — mirror TmuxRegistry.runTmux / runTmuxCapture
// -----------------------------------------------------------------------------

function buildEnv(socketDir) {
  const base = MINIMAL_ENV
    ? {
        HOME: process.env.HOME ?? '',
        LOGNAME: process.env.LOGNAME ?? '',
        USER: process.env.USER ?? '',
        // Same launchd default PATH a Finder-launched Electron app inherits.
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
      }
    : { ...process.env }
  base.TMUX_TMPDIR = socketDir
  return base
}

function runTmux(binary, args, env, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      resolvePromise({ code: code ?? -1, signal, stdout, stderr })
    })
  })
}

async function runTmuxOrThrow(binary, args, env, opts = {}) {
  const result = await runTmux(binary, args, env, opts)
  if (result.code !== 0) {
    throw new Error(
      `tmux ${args.join(' ')} exited ${result.code} (signal=${result.signal ?? 'null'}): ${result.stderr.trim() || '(no stderr)'}`,
    )
  }
  return result.stdout
}

// -----------------------------------------------------------------------------
// Bundled binary resolution
// -----------------------------------------------------------------------------

function resolveBundledTmux() {
  const platformKey = currentPlatformKey()
  if (!platformKey) {
    throw new Error(
      `Unsupported platform ${osPlatform()}-${osArch()}; smoke covers macOS only for now.`,
    )
  }
  const candidate = join(REPO_ROOT, 'third_party', 'tmux', 'cache', platformKey, 'tmux')
  if (!existsSync(candidate)) {
    throw new Error(
      `Bundled tmux not found at ${candidate}. Run \`npm run runtime:fetch:tmux -- --all\` first.`,
    )
  }
  return { path: candidate, platformKey }
}

// -----------------------------------------------------------------------------
// Test scenarios — each mirrors an exact Agent Code call path.
// -----------------------------------------------------------------------------

async function run() {
  console.log(`Agent Code tmux smoke — minimal-env=${MINIMAL_ENV} platform=${osPlatform()}-${osArch()}`)

  let tmuxPath
  let socketDir
  const sessionName = `agent-code-smoke-${process.pid}-${Date.now()}`

  section('binary resolution')
  await step('bundled tmux exists on disk', () => {
    const resolved = resolveBundledTmux()
    tmuxPath = resolved.path
    console.log(`      -> ${tmuxPath}`)
  })
  if (!tmuxPath) return summarize()

  await step('tmux -V reports the pinned version', async () => {
    const out = await runTmuxOrThrow(tmuxPath, ['-V'], { ...process.env })
    console.log(`      -> ${out.trim()}`)
    assert(out.startsWith('tmux '), `expected 'tmux <ver>' prefix, got ${JSON.stringify(out)}`)
  })

  section('socket isolation')
  await step('private TMUX_TMPDIR is writable', () => {
    socketDir = mkdtempSync(join(tmpdir(), 'agent-code-tmux-smoke-'))
    mkdirSync(socketDir, { recursive: true })
    console.log(`      -> ${socketDir}`)
  })
  if (!socketDir) return summarize()
  const env = buildEnv(socketDir)

  await step('listing sessions on empty server exits cleanly', async () => {
    // Match TmuxRegistry.listManagedSessions: any non-zero exit is treated
    // as "no sessions". Different tmux versions phrase the socket-missing
    // condition differently ("no server running", "error connecting to
    // /tmp/tmux-501/default: No such file or directory"). The Agent Code
    // code path catches all of them; the smoke must do the same so a
    // fresh-socket run passes.
    const result = await runTmux(tmuxPath, ['list-sessions', '-F', '#{session_name}'], env)
    if (result.code === 0) return
    const stderr = result.stderr.toLowerCase()
    assert(
      stderr.includes('no server running') ||
        stderr.includes('no such file') ||
        stderr.includes('error connecting'),
      `unexpected list-sessions failure: code=${result.code} stderr=${result.stderr}`,
    )
  })

  section('lifecycle — mirrors TmuxRegistry.createSession + set + list + kill')

  const workDir = mkdtempSync(join(tmpdir(), 'agent-code-tmux-cwd-'))
  await step('new-session -d starts detached', async () => {
    await runTmuxOrThrow(
      tmuxPath,
      [
        'new-session',
        '-d',
        '-s', sessionName,
        '-c', workDir,
        // Same-shape command as Agent Code: a long-lived process that
        // won't exit before we've inspected the session.
        '/bin/sh', '-c', 'sleep 5',
      ],
      env,
    )
  })

  await step('list-sessions sees our session', async () => {
    const stdout = await runTmuxOrThrow(
      tmuxPath,
      ['list-sessions', '-F', '#{session_name}|#{session_created}'],
      env,
    )
    const lines = stdout.split('\n').filter(Boolean)
    const line = lines.find(l => l.startsWith(`${sessionName}|`))
    assert(line, `session ${sessionName} missing from list-sessions output:\n${stdout}`)
  })

  const sessionFlags = [
    ['status', 'off'],
    ['mouse', 'off'],
    ['aggressive-resize', 'on'],
  ]
  for (const [key, value] of sessionFlags) {
    await step(`set -t ${sessionName} ${key} ${value}`, async () => {
      await runTmuxOrThrow(tmuxPath, ['set', '-t', sessionName, key, value], env)
    })
    await step(`show-options -t ${sessionName} ${key} echoes back`, async () => {
      const stdout = await runTmuxOrThrow(
        tmuxPath,
        ['show-options', '-t', sessionName, key],
        env,
      )
      assert(
        stdout.includes(value),
        `expected show-options to include ${value}, got ${JSON.stringify(stdout)}`,
      )
    })
  }

  section('pty attach — proxy for the TerminalSession node-pty attach')
  // WHY /usr/bin/script instead of node-pty here:
  //
  //   node-pty's native binding is compiled against Electron's Node ABI
  //   during Agent Code's postinstall (electron-rebuild); it therefore
  //   cannot be loaded by a standalone Node runtime driving this smoke
  //   script. Running the smoke inside Electron would rebuild every time
  //   we switch runtimes. macOS ships `script(1)` in /usr/bin — a POSIX
  //   tool that allocates a real pty for its child, which is
  //   operationally equivalent to node-pty for the "does tmux attach
  //   produce bytes over a pty" question this test cares about. The
  //   packaged app still uses node-pty; this proxy is a smoke of the
  //   surrounding contract (binary spawns, session attaches, pty
  //   streams bytes), not of the specific JS binding.
  //
  //   `-q` suppresses the timing script, `/dev/null` sends the typescript
  //   log to /dev/null. Any output written to the script's stdout came
  //   from tmux -> shell -> pty.
  await step('tmux attach over a pty produces observable output', async () => {
    // If the harness's stdin is not a TTY (running under npm, redirected,
    // CI, an editor terminal that pipes stdin) `script(1)` cannot
    // allocate a pty and the check is meaningless. Skip cleanly so the
    // rest of the surface (which IS informative here) still runs.
    if (!process.stdin.isTTY) {
      throw new SkipStep(
        "harness stdin is not a TTY — run this script directly in a terminal (or under Electron's node-pty) for pty coverage.",
      )
    }
    const scriptPath = '/usr/bin/script'
    if (!existsSync(scriptPath)) {
      throw new SkipStep(`${scriptPath} not present on this host.`)
    }
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        scriptPath,
        ['-q', '/dev/null', tmuxPath, 'attach', '-t', sessionName],
        {
          env,
          stdio: ['inherit', 'pipe', 'pipe'],
          cwd: workDir,
        },
      )
      let bytes = 0
      let stderr = ''
      const timer = setTimeout(() => {
        // Detach cleanly — SIGTERM the wrapping script, which cascades
        // into tmux attach exiting. Do NOT kill the tmux server itself.
        child.kill('SIGTERM')
      }, 900)
      child.stdout.on('data', chunk => {
        bytes += chunk.length
      })
      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8')
      })
      child.once('error', err => {
        clearTimeout(timer)
        rejectPromise(err)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        if (bytes === 0) {
          rejectPromise(
            new Error(
              `attach produced no pty output. stderr=${stderr.trim() || '(none)'}`,
            ),
          )
          return
        }
        console.log(`      -> received ${bytes} bytes over pty`)
        resolvePromise()
      })
    })
  })

  section('teardown — mirrors TmuxRegistry.killSession')
  await step('kill-session removes the session', async () => {
    await runTmuxOrThrow(tmuxPath, ['kill-session', '-t', sessionName], env)
  })

  await step('list-sessions no longer sees our session', async () => {
    const result = await runTmux(tmuxPath, ['list-sessions', '-F', '#{session_name}'], env)
    // list-sessions with no sessions is exit-1 + "no server running", or
    // exit-0 with empty stdout on newer versions with a lingering server.
    if (result.code === 0) {
      const lines = result.stdout.split('\n').filter(Boolean)
      assert(
        !lines.some(l => l.includes(sessionName)),
        `session ${sessionName} still present after kill:\n${result.stdout}`,
      )
    } else {
      assert(
        result.stderr.includes('no server running'),
        `unexpected list-sessions after kill: code=${result.code} stderr=${result.stderr}`,
      )
    }
  })

  await step('kill-server tears everything down cleanly', async () => {
    const result = await runTmux(tmuxPath, ['kill-server'], env)
    // 'no server running' is fine — the previous kill-session may have
    // triggered a shutdown already.
    assert(
      result.code === 0 || result.stderr.includes('no server running'),
      `kill-server failed: code=${result.code} stderr=${result.stderr}`,
    )
  })

  await rm(socketDir, { recursive: true, force: true }).catch(() => {})
  await rm(workDir, { recursive: true, force: true }).catch(() => {})

  summarize()
}

function summarize() {
  console.log('\n== summary ==')
  const failed = results.filter(r => !r.ok)
  const skipped = results.filter(r => r.skipped)
  const passed = results.filter(r => r.ok && !r.skipped)
  console.log(
    `  ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed`,
  )
  if (failed.length > 0) {
    console.log('\n  FAILED steps:')
    for (const r of failed) {
      console.log(`    - [${r.section}] ${r.name}: ${r.error}`)
    }
    process.exit(1)
  }
}

// Ensure we always summarize even on a thrown error the harness didn't catch.
run().catch(err => {
  console.error('\nunexpected harness error:', err)
  summarize()
  process.exit(1)
})
