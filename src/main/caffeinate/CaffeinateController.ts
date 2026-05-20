import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

import type {
  CaffeinateCommandResult,
  CaffeinateStatus,
} from '@preload/api/types.js'

const CAFFEINATE_BINARY = '/usr/bin/caffeinate'
// WHY `-ims` and not the tempting kitchen-sink `-dimsu`:
//   `-u` only asserts "user is active" for five seconds without `-t`, and it
//   can wake the display as a side effect. That is wrong for background agent
//   work. `-d` keeps the display awake, which is also stronger than this
//   command promises. We want the Mac to keep doing work, not to force the
//   screen on. `-s` is valid only on AC power, so `-i` remains the portable
//   idle-sleep assertion and `-m` keeps disk idle sleep out of long runs.
const CAFFEINATE_ARGS = ['-ims'] as const

type CaffeinateEvents = {
  'state-changed': [CaffeinateStatus]
}

export class CaffeinateController extends EventEmitter<CaffeinateEvents> {
  private child: ChildProcess | null = null
  private startedAt: number | null = null
  private lastMessage: string | null = null

  getStatus(): CaffeinateStatus {
    return {
      supported: process.platform === 'darwin',
      active: this.child !== null,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      command: [CAFFEINATE_BINARY, ...CAFFEINATE_ARGS],
      message: this.lastMessage,
    }
  }

  start(): CaffeinateCommandResult {
    if (process.platform !== 'darwin') {
      this.lastMessage = 'Caffeinate is only supported on macOS.'
      return { ok: false, message: this.lastMessage, status: this.getStatus() }
    }

    if (this.child) {
      this.lastMessage = 'Caffeinate is already active.'
      return { ok: true, message: this.lastMessage, status: this.getStatus() }
    }

    try {
      // WHY the process lives in main instead of the renderer:
      // Electron renderers can reload while the app is still alive, and a
      // renderer-owned sleep assertion would either leak a child process or
      // drop the assertion during UI refresh. Main already owns every other
      // OS process lifecycle, and `before-quit` can synchronously release this
      // one alongside agents, LSPs, and tmux-backed terminals.
      const child = spawn(CAFFEINATE_BINARY, [...CAFFEINATE_ARGS], {
        stdio: 'ignore',
        detached: false,
      })

      this.child = child
      this.startedAt = Date.now()
      this.lastMessage =
        'Caffeinate is active. It prevents idle sleep while Agent Code is open; system-sleep prevention depends on AC power, and macOS lid-close sleep remains hardware and power-state dependent.'

      child.once('error', err => {
        if (this.child !== child) return
        this.child = null
        this.startedAt = null
        this.lastMessage = `Caffeinate failed: ${err.message}`
        this.emit('state-changed', this.getStatus())
      })

      child.once('exit', (code, signal) => {
        if (this.child !== child) return
        this.child = null
        this.startedAt = null
        this.lastMessage =
          code === 0 || signal === 'SIGTERM'
            ? 'Caffeinate stopped.'
            : `Caffeinate exited unexpectedly${code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : ''}.`
        this.emit('state-changed', this.getStatus())
      })

      this.emit('state-changed', this.getStatus())
      return { ok: true, message: this.lastMessage, status: this.getStatus() }
    } catch (err) {
      this.child = null
      this.startedAt = null
      this.lastMessage = err instanceof Error ? err.message : String(err)
      const message = `Could not start caffeinate: ${this.lastMessage}`
      this.lastMessage = message
      this.emit('state-changed', this.getStatus())
      return { ok: false, message, status: this.getStatus() }
    }
  }

  stop(): CaffeinateCommandResult {
    const child = this.child
    if (!child) {
      this.lastMessage = 'Caffeinate is not active.'
      return { ok: true, message: this.lastMessage, status: this.getStatus() }
    }

    // WHY `kill()` instead of shelling out to pkill:
    // the app must only release the exact assertion it created. A global
    // `pkill caffeinate` would trample user-started caffeinate processes,
    // defeating the trust boundary around this command.
    const signaled = child.kill('SIGTERM')
    if (!signaled) {
      this.lastMessage = 'Could not stop caffeinate; the process did not accept SIGTERM.'
      return { ok: false, message: this.lastMessage, status: this.getStatus() }
    }
    this.child = null
    this.startedAt = null
    this.lastMessage = 'Caffeinate stopped.'
    this.emit('state-changed', this.getStatus())
    return { ok: true, message: this.lastMessage, status: this.getStatus() }
  }

  toggle(): CaffeinateCommandResult {
    return this.child ? this.stop() : this.start()
  }

  dispose(): void {
    if (!this.child) return
    this.child.kill('SIGTERM')
    this.child = null
    this.startedAt = null
    this.lastMessage = 'Caffeinate stopped.'
  }
}
