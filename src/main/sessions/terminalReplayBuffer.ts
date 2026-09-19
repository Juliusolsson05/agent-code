import { CappedTextBuffer } from '@main/sessions/cappedTextBuffer.js'
import { DecModeTracker } from '@main/sessions/decModeTracker.js'

/**
 * A PTY replay buffer that remembers the terminal modes its evicted bytes set
 * (#843).
 *
 * `read()` is the retained tail, byte-exact. Paged raw reads use it
 * (`sessions.terminalRead` cursors are offsets into it). `replay()` is what a
 * newly attached xterm is fed: the DEC private-mode state as of the tail's
 * first byte, then the tail. A full-screen TUI such as OpenCode writes its
 * alternate-screen and mouse modes once at startup, and the cap evicts them
 * within minutes of repainting. Without the prefix a remounted pane showed the
 * right picture on the wrong buffer, with no mouse tracking, so the wheel did
 * nothing. See DecModeTracker for why the prefix must be the state at the
 * replay START.
 */
export class TerminalReplayBuffer {
  private readonly modes = new DecModeTracker()
  private readonly tail: CappedTextBuffer

  constructor(readonly cap: number, pieceSize?: number) {
    this.tail = new CappedTextBuffer(cap, pieceSize, text => this.modes.feed(text))
  }

  get length(): number {
    return this.tail.length
  }

  append(chunk: string): void {
    this.tail.append(chunk)
  }

  /** The retained tail exactly as written. */
  read(): string {
    return this.tail.read()
  }

  /** What an attaching terminal must be fed to reach the program's state. */
  replay(): string {
    return this.modes.prefix() + this.modes.pendingFragment() + this.tail.read()
  }
}
