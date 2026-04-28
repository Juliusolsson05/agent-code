import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

let child: ChildProcessWithoutNullStreams | null = null

export async function startMacDictationHotkeyHelper(
  binding: string,
  handlers: { onPress: () => void; onRelease: () => void },
): Promise<boolean> {
  stopMacDictationHotkeyHelper()

  if (process.platform !== 'darwin') return false

  try {
    const binary = await ensureHelperBinary()
    child = spawn(binary, [binding], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string }
          if (event.type === 'hotkey' || event.type === 'hotkey-down') handlers.onPress()
          if (event.type === 'hotkey-up') handlers.onRelease()
          if (event.type === 'ready') {
            // eslint-disable-next-line no-console
            console.log(`[dictation:hotkey] mac helper ready for "${binding}"`)
          }
        } catch {
          // eslint-disable-next-line no-console
          console.log('[dictation:hotkey] mac helper stdout:', line)
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      // Accessibility prompts and unsupported binding errors come from the
      // helper process, not the renderer. Keep them in main where the user can
      // see the operational problem during local development.
      // eslint-disable-next-line no-console
      console.warn(String(chunk).trim())
    })

    child.on('exit', (code, signal) => {
      if (child) {
        // eslint-disable-next-line no-console
        console.warn(
          `[dictation:hotkey] mac helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        )
      }
      child = null
    })

    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[dictation:hotkey] failed to start mac helper', err)
    stopMacDictationHotkeyHelper()
    return false
  }
}

export function stopMacDictationHotkeyHelper(): void {
  if (!child) return
  const current = child
  child = null
  current.kill()
}

async function ensureHelperBinary(): Promise<string> {
  // We compile from source at runtime for the same reason the standalone
  // dictation app does: the behavior we need is tiny and first-party, while
  // npm key-listener wrappers tend to hide helper binaries, chmod behavior,
  // and binding semantics. Hashing the source keeps rebuilds deterministic
  // without forcing every app boot to pay a Swift compile.
  const source = join(
    app.getAppPath(),
    'native/macos-hotkey-helper/Sources/AgentVoiceHotkeyHelper/main.swift',
  )
  const sourceBytes = await readFile(source)
  const hash = createHash('sha256').update(sourceBytes).digest('hex').slice(0, 12)
  const dir = join(app.getPath('userData'), 'native-helpers')
  const target = join(dir, `CcShellDictationHotkeyHelper-${hash}`)

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
