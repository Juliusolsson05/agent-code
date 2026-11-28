import { Terminal } from '@xterm/headless'

/** Read only the current editable region. A chat message can contain a fake
 * prompt; agy's native cursor, two full-width rules and empty-only hint bind
 * the decision to the editor that would actually receive Enter. The mirror
 * never answers terminal queries (the visible terminal owns those replies). */
export class AntigravityTerminalComposer {
  private readonly screen: Terminal
  private pending = 0
  private inputRevision = 0
  private awaitingEdit = false
  private disposed = false

  constructor(cols: number, rows: number, private readonly changed: () => void) {
    this.screen = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  }

  output(data: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.pending++
    const beforeInput = this.inputRevision
    return new Promise(resolve => this.screen.write(data, () => {
      this.pending--
      if (!this.disposed && !this.pending) {
        if (beforeInput === this.inputRevision && !this.emptyScreen()) this.awaitingEdit = false
        this.changed()
      }
      resolve()
    }))
  }

  input(data: string): void {
    // xterm answers device-status and attribute queries through the same write
    // API as typing. Those replies never edit agy's composer.
    if (/^(?:\x1b\[\??[\d;]*R|\x1b\[[?>][\d;]*c)$/.test(data)) return
    // Backspace on a settled empty agy 1.5.18 prompt is a no-op with
    // no ensuing edit to observe. Never clear an already outstanding key:
    // its draft may still be waiting for the CLI's first echo.
    if ((data === '\x7f' || data === '\x08') && this.ready()) return
    this.inputRevision++
    if (this.emptyScreen()) this.awaitingEdit = true
    this.changed()
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.screen.resize(cols, rows)
    this.changed()
  }

  dispose(): void {
    if (!this.disposed) this.screen.dispose()
    this.disposed = true
  }

  ready(): boolean {
    return !this.disposed && this.pending === 0 && !this.awaitingEdit && this.emptyScreen()
  }

  occupied(): boolean {
    if (this.disposed || this.pending || !this.screen.modes.bracketedPasteMode) return false
    const y = this.screen.buffer.active.cursorY
    const rule = '─'.repeat(this.screen.cols)
    if (this.line(y + 1) !== rule || this.emptyScreen()) return false
    for (let row = y; row > 0; row--) {
      const line = this.line(row)
      if (/^>(?: |$)/.test(line) && this.line(row - 1) === rule) return true
      if (line && !line.startsWith('  ')) break
    }
    return false
  }

  private line(row: number): string {
    if (row < 0 || row >= this.screen.rows) return ''
    const buffer = this.screen.buffer.active
    return buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
  }

  private emptyScreen(): boolean {
    if (this.disposed || !this.screen.modes.bracketedPasteMode) return false
    const buffer = this.screen.buffer.active
    const y = buffer.cursorY
    const rule = '─'.repeat(this.screen.cols)
    return buffer.cursorX === 2 && /^> ?$/.test(this.line(y)) &&
      this.line(y - 1) === rule && this.line(y + 1) === rule &&
      /^\? for shortcuts(?:\s{2,}.*)?$/.test(this.line(y + 2))
  }

  containsPaste(text: string): boolean {
    if (this.disposed || this.pending || !this.screen.modes.bracketedPasteMode) return false
    const y = this.screen.buffer.active.cursorY
    const rule = '─'.repeat(this.screen.cols)
    if (this.line(y + 1) !== rule) return false
    const rows: string[] = []
    for (let row = y; row >= 0; row--) {
      const content = this.line(row)
      if (content.startsWith('> ') && this.line(row - 1) === rule) {
        rows.unshift(content.slice(2))
        // agy collapses larger pastes immediately into a chip with the
        // number of lines. A bare chip is sufficient only after we owned
        // an empty composer and its one reserved paste.
        const displayed = rows.join('\n')
        const lineChip = /^\[Pasted text #\d+ \+(\d+) lines?\]$/.exec(displayed)
        if (lineChip && Number(lineChip[1]) === text.split('\n').length) return true
        // A long single line gets a character count instead. The real CLI
        // counted 🧪é × 1300 as 2600 Unicode code points (3900 UTF-16 units).
        const charChip = /^\[Pasted text #\d+ (\d+) chars?\]$/.exec(displayed)
        if (charChip && Number(charChip[1]) === Array.from(text).length) return true
        // Rendering wraps at the pane width and strips trailing spaces from
        // padded cells. Walk the expected text so hard and soft wrapping
        // don't disguise an extra prefix or suffix from an unrelated draft.
        let remaining = text
        for (const [i, line] of rows.entries()) {
          if (i) {
            while (!remaining.startsWith(line) && /^\s/u.test(remaining)) remaining = remaining.slice(1)
          }
          if (!remaining.startsWith(line)) return false
          remaining = remaining.slice(line.length)
        }
        return remaining.trim().length === 0
      }
      if (content && !content.startsWith('  ')) return false
      rows.unshift(content.slice(2))
    }
    return false
  }
}
