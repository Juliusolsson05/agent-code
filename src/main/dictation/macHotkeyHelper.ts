import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { unpackAsarPath } from '@main/setup/runtimeTools.js'

type HotkeyHelperProcess = ChildProcessByStdio<null, Readable, Readable>

let child: HotkeyHelperProcess | null = null

/**
 * Start result with a human-readable failure reason. Mirrors the
 * CaffeinateController `{ supported, message }` graceful-degrade shape
 * (src/main/caffeinate/CaffeinateController.ts) — this repo's canonical
 * pattern for "the feature can't run here, and here is WHY" instead of a
 * bare boolean that hides the cause (#495 A4: the old `false` return
 * made a Mac without Xcode CLT silently lose the dictation hotkey).
 * The message rides the existing `dictation:hotkey-configure` IPC result
 * (DictationHotkeyConfigureResult already has an optional `message` on
 * its ok:false arm), so no new IPC channel is needed.
 */
export type MacHotkeyHelperStartResult = { ok: boolean; message?: string }

// How long to wait for the helper's post-spawn verdict before declaring the
// start OK. The helper's startup protocol (see main.swift) is fully
// deterministic: it either prints `{"type":"ready"}` on stdout immediately
// after the CGEventTap is installed, or it exits within milliseconds with a
// distinct code (64 empty binding / 65 unsupported key / 66 tap creation
// failed — the accessibility-denied case). So on a healthy machine this wait
// costs ~tens of ms, not the full window; the timeout only fires if the
// helper neither became ready nor exited (a machine so loaded the tiny
// binary hasn't reached emit("ready") yet), and in that ambiguous case we
// side with ok:true — a false "hotkey broken" toast on a slow-but-working
// machine is worse than the pre-#508 behavior of always claiming ok.
const HELPER_READY_WAIT_MS = 2000

export async function startMacDictationHotkeyHelper(
  binding: string,
  handlers: { onPress: () => void; onRelease: () => void },
): Promise<MacHotkeyHelperStartResult> {
  stopMacDictationHotkeyHelper()

  if (process.platform !== 'darwin') {
    return { ok: false, message: 'dictation hotkey helper is macOS-only' }
  }

  try {
    const binary = await ensureHelperBinary()
    const helper = spawn(binary, [binding], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = helper

    // Post-spawn startup watch (#508 review). A successful spawn() proves
    // nothing: the helper still exits immediately when the binding is
    // unsupported (64/65) or when it cannot create its CGEventTap (66 —
    // the Accessibility-permission-denied case). Returning {ok:true} right
    // after spawn made those failures invisible to the configure result:
    // the renderer showed the hotkey as registered while the helper was
    // already dead. Wait for the helper's own verdict — its first
    // `{"type":"ready"}` stdout line (emitted right after tap install) or
    // an early exit — before declaring ok. Single-settle guard because
    // ready/exit/error/timeout can race.
    let stderrBuf = ''
    let startSettled = false
    let settleStart: (result: MacHotkeyHelperStartResult) => void = () => {}
    const startVerdict = new Promise<MacHotkeyHelperStartResult>(resolve => {
      settleStart = result => {
        if (startSettled) return
        startSettled = true
        resolve(result)
      }
    })

    helper.stdout.setEncoding('utf8')
    helper.stdout.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string }
          if (event.type === 'hotkey' || event.type === 'hotkey-down') handlers.onPress()
          if (event.type === 'hotkey-up') handlers.onRelease()
          if (event.type === 'ready') {
            // eslint-disable-next-line no-console
            console.log(`[dictation:hotkey] mac helper ready for "${binding}"`)
            settleStart({ ok: true })
          }
        } catch {
          // eslint-disable-next-line no-console
          console.log('[dictation:hotkey] mac helper stdout:', line)
        }
      }
    })

    helper.stderr.setEncoding('utf8')
    helper.stderr.on('data', chunk => {
      // Accessibility prompts and unsupported binding errors come from the
      // helper process, not the renderer. Keep them in main where the user can
      // see the operational problem during local development — and buffer
      // them so an early exit can carry the helper's own words (e.g.
      // "accessibility permission is required") back through the configure
      // result instead of a bare exit code.
      stderrBuf += String(chunk)
      // eslint-disable-next-line no-console
      console.warn(String(chunk).trim())
    })

    helper.on('error', err => {
      // spawn() reports missing/unspawnable binaries asynchronously via
      // 'error', not by throwing — without this handler an unspawnable
      // helper would ALSO count as {ok:true} (and crash the process on the
      // unhandled 'error' event).
      settleStart({
        ok: false,
        message: `dictation hotkey helper failed to spawn — ${stderrTail(err.message)}`,
      })
      if (child === helper) child = null
    })

    helper.on('exit', (code, signal) => {
      if (child === helper) {
        // eslint-disable-next-line no-console
        console.warn(
          `[dictation:hotkey] mac helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        )
      }
      if (child === helper) child = null
      settleStart({ ok: false, message: describeEarlyExit(code, signal, stderrBuf) })
    })

    const readyTimer = setTimeout(() => settleStart({ ok: true }), HELPER_READY_WAIT_MS)
    const result = await startVerdict
    clearTimeout(readyTimer)
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[dictation:hotkey] ${result.message}`)
      stopMacDictationHotkeyHelper()
    }
    return result
  } catch (err) {
    // Kill the silent degrade (#495 A4): translate the raw error into a
    // one-line actionable reason before it leaves this module. The caller
    // (ipc/dictation.ts) journals it via AppRunJournal and the renderer
    // receives it on the configure result — console.warn alone was
    // invisible to anyone not running from a terminal.
    const message = await describeHelperFailure(err)
    // eslint-disable-next-line no-console
    console.warn(`[dictation:hotkey] ${message}`, err)
    stopMacDictationHotkeyHelper()
    return { ok: false, message }
  }
}

/**
 * Map a helper-start failure to the reason a human can act on. Layer
 * detection is deliberately coarse: in a packaged app the only helper
 * source is the build-time bundled binary (missing = packaging bug); in
 * dev the only source is the runtime swiftc compile, whose dominant
 * failure mode is a Mac without Xcode Command Line Tools — probe
 * `xcode-select -p` so the message names the actual fix instead of
 * surfacing swiftc's opaque ENOENT.
 */
async function describeHelperFailure(err: unknown): Promise<string> {
  const detail = err instanceof Error ? err.message : String(err)
  if (app.isPackaged) {
    return (
      'dictation hotkey helper unavailable: bundled helper binary missing or ' +
      `not executable (${stderrTail(detail)}) — packaging bug; ` +
      'scripts/build-hotkey-helper.mjs should have produced it under out/main/runtime/hotkey-helper'
    )
  }
  const cltInstalled = await new Promise<boolean>(resolve => {
    execFile('/usr/bin/xcode-select', ['-p'], error => resolve(!error))
  })
  if (!cltInstalled) {
    return (
      'dictation hotkey helper unavailable: Xcode Command Line Tools not ' +
      'installed — run `xcode-select --install` (dev builds compile the helper locally)'
    )
  }
  return `dictation hotkey helper unavailable: swiftc compile failed — ${stderrTail(detail)}`
}

/**
 * Map a helper early-exit to an actionable one-liner. Exit codes are the
 * helper's own startup contract (native/macos-hotkey-helper/.../main.swift):
 * 64 = empty binding, 65 = unsupported key in binding, 66 = CGEventTap
 * creation failed. 66 is called out specifically because its dominant cause
 * is a denied/revoked Accessibility permission — the ONE failure an end
 * user can actually fix themselves, so the message must name the fix, not
 * just echo "failed to create event tap".
 */
function describeEarlyExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const detail =
    stderrTail(stderr) || `exited code=${code ?? 'null'} signal=${signal ?? 'null'}`
  if (code === 66) {
    return (
      `dictation hotkey helper could not create its event tap (${detail}) — ` +
      'grant Agent Code Accessibility permission in System Settings → ' +
      'Privacy & Security → Accessibility, then re-enable dictation'
    )
  }
  if (code === 64 || code === 65) {
    return (
      `dictation hotkey helper rejected the binding (${detail}) — ` +
      'choose a different dictation shortcut in Settings'
    )
  }
  return `dictation hotkey helper exited during startup — ${detail}`
}

// Keep the reason to one journal/IPC-friendly line: swiftc failures embed
// the full stderr, and the actionable part (the actual error) is at the
// end, not the start.
function stderrTail(detail: string): string {
  const trimmed = detail.trim().replace(/\s+/g, ' ')
  return trimmed.length > 300 ? `…${trimmed.slice(-300)}` : trimmed
}

export function stopMacDictationHotkeyHelper(): void {
  if (!child) return
  const current = child
  child = null
  current.kill()
}

async function ensureHelperBinary(): Promise<string> {
  if (app.isPackaged) {
    // Packaged builds use the binary compiled at BUILD time by
    // scripts/build-hotkey-helper.mjs (#495 A4) — end-user Macs must not
    // need Xcode CLT just to get the dictation hotkey. The path is the
    // same out/main/runtime/** convention as the bundled mitmproxy/tmux
    // artifacts: covered by electron-builder's asarUnpack glob, so the
    // real spawnable file lives under app.asar.unpacked (the
    // unpackAsarPath swap). No compile fallback here on purpose — if the
    // binary is missing, that is a packaging bug we want surfaced via the
    // describeHelperFailure message, not papered over by a runtime
    // compile that only works on the subset of user Macs with CLT.
    const bundled = unpackAsarPath(
      join(app.getAppPath(), 'out', 'main', 'runtime', 'hotkey-helper', 'AgentCodeDictationHotkeyHelper'),
    )
    await access(bundled, constants.X_OK)
    return bundled
  }

  // Dev path: compile from source at runtime for the same reason the
  // standalone dictation app does — the behavior we need is tiny and
  // first-party, while npm key-listener wrappers tend to hide helper
  // binaries, chmod behavior, and binding semantics. Hashing the source
  // keeps rebuilds deterministic without forcing every app boot to pay a
  // Swift compile. Dev machines have CLT by definition (they build the
  // app), so the packaged-Mac concern above doesn't apply.
  const source = join(
    app.getAppPath(),
    'native/macos-hotkey-helper/Sources/AgentVoiceHotkeyHelper/main.swift',
  )
  const sourceBytes = await readFile(source)
  const hash = createHash('sha256').update(sourceBytes).digest('hex').slice(0, 12)
  const dir = join(app.getPath('userData'), 'native-helpers')
  const target = join(dir, `AgentCodeDictationHotkeyHelper-${hash}`)

  try {
    await access(target, constants.X_OK)
    return target
  } catch {
    // Missing or not executable; compile below.
  }

  await mkdir(dir, { recursive: true })
  await compileSwift(source, target)
  await chmod(target, 0o755)
  await stat(target)
  return target
}

function compileSwift(source: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const compiler = spawn('/usr/bin/xcrun', ['swiftc', source, '-O', '-o', target], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    compiler.stderr.setEncoding('utf8')
    compiler.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    compiler.on('error', reject)
    compiler.on('exit', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`swiftc failed with code ${code}: ${stderr.trim()}`))
    })
  })
}
