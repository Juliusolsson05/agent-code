#!/usr/bin/env tsx
/**
 * testbench/record.ts — capture a Claude Code session for offline analysis.
 *
 * Spawns ClaudeSession in raw passthrough mode: your local terminal becomes
 * CC's terminal (stdin and stdout are bridged), so you interact with CC
 * exactly as you would running `claude` directly. Meanwhile every event the
 * session emits is also logged to disk under `recordings/<timestamp>/`.
 *
 * Usage:
 *   npm run record
 *
 * Outputs:
 *   recordings/<ts>/meta.json        — start time, cwd, env summary
 *   recordings/<ts>/raw.txt          — full PTY byte stream (ANSI included)
 *   recordings/<ts>/raw.events.jsonl — same bytes with timestamps for replay
 *   recordings/<ts>/snapshots.jsonl  — periodic headless terminal snapshots
 *   recordings/<ts>/jsonl.jsonl      — every JSONL transcript entry CC wrote
 *
 * Once you've recorded a session, use `npm run replay -- <recordingDir>` to
 * iterate on parsers offline against the same data.
 */

import { mkdir, readFile, writeFile, copyFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

import { ClaudeSession } from '../src/core/runtime/claudeSession.js'
import { getProjectDirForCwd } from '../src/core/runtime/projectDir.js'
import {
  detectTrustDialog,
  TRUST_DIALOG_ACCEPT_KEYS,
} from '../src/core/parsers/claude/trustDialog.js'

// ---- Scripted-mode types --------------------------------------------------
//
// When `$CC_SHELL_SCRIPT` points at a JSON file, record.ts runs in
// non-interactive mode: instead of bridging your local terminal, it
// executes the steps in the script (wait / send) against the spawned
// session and exits when done. Useful for:
//   - automated parser regression tests
//   - having Claude (the assistant) drive recordings on your behalf
//
// Format:
//   {
//     "steps": [
//       { "type": "wait", "ms": 3000 },
//       { "type": "send", "data": "what is 2+2?\r" },
//       { "type": "wait", "ms": 8000 }
//     ]
//   }

type ScriptStep =
  | { type: 'wait'; ms: number }
  | { type: 'send'; data: string }

type Script = {
  /**
   * If true, the testbench watches every screen snapshot for the trust
   * dialog and auto-sends Enter the first time it appears. We use the
   * SAME parser cc-shell's renderer will eventually use to surface the
   * dialog as a real React modal — having it here in the testbench means
   * any improvement we make to the parser benefits both runtimes for
   * free. See src/core/parsers/trustDialog.ts.
   */
  autoAcceptTrust?: boolean
  steps: ScriptStep[]
}

async function loadScript(path: string): Promise<Script> {
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text) as Script
  if (!Array.isArray(parsed.steps)) {
    throw new Error(`script ${path} has no "steps" array`)
  }
  return parsed
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function main(): Promise<void> {
  const scriptPath = process.env.CC_SHELL_SCRIPT
  const scripted = !!scriptPath
  const script: Script | null = scripted ? await loadScript(scriptPath!) : null

  // Resume-fixture mode — CC_SHELL_RESUME_FIXTURE points at a JSONL file
  // that represents an existing CC session transcript (usually a real
  // session we copied out of ~/.claude/projects/ for fixture testing).
  //
  // Flow: we mint a fresh UUID, copy the fixture into CC's projects dir
  // under <newId>.jsonl, then pass that UUID as resumeSessionId to
  // ClaudeSession. CC's --resume <uuid> loads the file as prior context
  // so the next prompt executes against the full conversation history.
  //
  // We deliberately copy (not symlink or mutate in place) because CC
  // appends to the resumed session file as it runs, and we don't want
  // to corrupt the fixture or the original conversation this file came
  // from. The target file in CC's projects dir is disposable — it gets
  // overwritten on the next test run.
  const resumeFixture = process.env.CC_SHELL_RESUME_FIXTURE || null

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const recordingDir = join('recordings', ts)
  await mkdir(recordingDir, { recursive: true })

  const meta: {
    startedAt: string
    cwd: string
    cols: number
    rows: number
    binary: string
    mode: string
    scriptPath: string | null
    resumeFixture: string | null
    resumeSessionId: string | null
  } = {
    startedAt: new Date().toISOString(),
    cwd: process.env.CC_SHELL_CWD || process.cwd(),
    cols: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 40,
    binary: process.env.CC_SHELL_CLAUDE_BINARY || 'claude',
    mode: scripted ? 'scripted' : 'interactive',
    scriptPath: scriptPath ?? null,
    resumeFixture: resumeFixture,
    resumeSessionId: null,
  }

  // If we're resuming from a fixture, stage it into CC's project dir
  // NOW (before the session starts) so CC sees it on the filesystem
  // when it boots with --resume. We do this in the cwd-derived
  // projects dir, not the fixture's original location — CC indexes by
  // cwd, so the file must live under the sanitized-cwd directory that
  // matches `meta.cwd` or --resume will fail to find it.
  let resumeSessionId: string | null = null
  if (resumeFixture) {
    const projectDir = await getProjectDirForCwd(meta.cwd)
    await mkdir(projectDir, { recursive: true })
    resumeSessionId = randomUUID()
    const stagedPath = join(projectDir, `${resumeSessionId}.jsonl`)
    await copyFile(resumeFixture, stagedPath)
    meta.resumeSessionId = resumeSessionId
    process.stderr.write(
      `[record] staged fixture ${resumeFixture}\n[record]   → ${stagedPath}\n[record] CC will --resume ${resumeSessionId}\n`,
    )
  }

  await writeFile(join(recordingDir, 'meta.json'), JSON.stringify(meta, null, 2))

  // Open append streams for high-frequency channels.
  const rawStream = createWriteStream(join(recordingDir, 'raw.txt'), { flags: 'a' })
  const rawEventsStream = createWriteStream(join(recordingDir, 'raw.events.jsonl'), { flags: 'a' })
  const snapshotsStream = createWriteStream(join(recordingDir, 'snapshots.jsonl'), { flags: 'a' })
  const jsonlStream = createWriteStream(join(recordingDir, 'jsonl.jsonl'), { flags: 'a' })

  const session = new ClaudeSession({
    cwd: meta.cwd,
    cols: meta.cols,
    rows: meta.rows,
    binary: meta.binary,
    snapshotIntervalMs: 16,
    // If set, ClaudeSession.start() will pass --resume <uuid> to the
    // claude binary and tail the existing JSONL we just staged.
    resumeSessionId: resumeSessionId ?? undefined,
  })

  let firstStartedLogged = false

  session.on('started', ({ projectDir }) => {
    if (firstStartedLogged) return
    firstStartedLogged = true
    process.stderr.write(
      `\n[record] tailing JSONL at ${projectDir}\n[record] writing recording to ${recordingDir}\n[record] press Ctrl-C in this terminal to stop\n\n`,
    )
  })

  // Pipe raw PTY bytes to (a) the user's local stdout so they SEE CC, and
  // (b) the raw recording streams.
  session.on('pty-data', data => {
    process.stdout.write(data)
    rawStream.write(data)
    rawEventsStream.write(JSON.stringify({ ts: Date.now(), data }) + '\n')
  })

  // Track whether we've already auto-accepted the trust dialog so we
  // only send Enter once. The screen handler runs at ~60Hz; without this
  // flag we'd hammer the PTY with Enter keystrokes for the entire window
  // the dialog is on screen, which would (a) confirm the dialog, then (b)
  // push extra Enters into whatever screen comes next — usually the input
  // box, where they'd send empty prompts.
  let trustHandled = false

  let lastSnapshot = ''
  session.on('screen', snap => {
    // snap is { plain, markdown } — see ScreenSnapshot in claudeSession.ts.
    // We persist the plain version (parsers still operate on it); the
    // markdown version is a render-time convenience the Electron renderer
    // uses but we don't need to replay here.
    const plain = snap.plain
    if (plain === lastSnapshot) return
    lastSnapshot = plain
    snapshotsStream.write(JSON.stringify({ ts: Date.now(), text: plain }) + '\n')

    if (script?.autoAcceptTrust && !trustHandled) {
      const trust = detectTrustDialog(plain)
      if (trust.visible) {
        trustHandled = true
        process.stderr.write(
          `[record] auto-accepting trust dialog for ${trust.workspace ?? '?'}\n`,
        )
        session.write(TRUST_DIALOG_ACCEPT_KEYS)
      }
    }
  })

  session.on('jsonl-entry', (entry, file) => {
    jsonlStream.write(JSON.stringify({ ts: Date.now(), file, entry }) + '\n')
  })

  session.on('jsonl-error', err => {
    process.stderr.write(`\n[record] jsonl error: ${err.message}\n`)
  })

  session.on('exit', ({ exitCode, signal }) => {
    process.stderr.write(`\n[record] CC exited (code=${exitCode}, signal=${signal ?? '-'})\n`)
    void shutdown(exitCode ?? 0)
  })

  if (!scripted) {
    // Bridge local stdin → PTY. Put the local terminal in raw mode so every
    // keystroke (including Ctrl-C and arrow keys) is forwarded as-is.
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', chunk => {
      // Intercept Ctrl-Q (\x11) as a clean shutdown — Ctrl-C goes through
      // to CC for cancel-current-generation behavior.
      if (chunk.length === 1 && chunk[0] === 0x11) {
        process.stderr.write('\n[record] Ctrl-Q — stopping recording\n')
        void shutdown(0)
        return
      }
      session.write(chunk.toString('utf8'))
    })

    // Forward terminal resizes to the PTY.
    process.stdout.on('resize', () => {
      session.resize(process.stdout.columns ?? 120, process.stdout.rows ?? 40)
    })
  }

  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    await session.stop()
    rawStream.end()
    rawEventsStream.end()
    snapshotsStream.end()
    jsonlStream.end()
    process.stderr.write(`\n[record] saved to ${recordingDir}\n`)
    process.exit(code)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  await session.start()

  if (scripted && script) {
    process.stderr.write(`[record] running script with ${script.steps.length} steps\n`)
    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i]
      if (step.type === 'wait') {
        process.stderr.write(`[record] step ${i + 1}/${script.steps.length}: wait ${step.ms}ms\n`)
        await sleep(step.ms)
      } else if (step.type === 'send') {
        const preview = step.data.replace(/[\r\n]/g, '⏎').slice(0, 60)
        process.stderr.write(`[record] step ${i + 1}/${script.steps.length}: send ${preview}\n`)
        session.write(step.data)
      }
    }
    process.stderr.write('[record] script complete — shutting down\n')
    await shutdown(0)
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[record] fatal:', err)
  process.exit(1)
})
