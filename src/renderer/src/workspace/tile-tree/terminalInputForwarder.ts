// Outgoing keystroke path for the xterm hosts (AgentTerminalLeaf,
// TerminalLeaf, AgentInlineTerminal) — #745.
//
// WHY replay must be silenced: attaching a pane writes up to 512 KiB of
// buffered PTY output into xterm at once. xterm faithfully answers every
// terminal query embedded in that stream — cursor-position reports (ESC[6n),
// device attributes, OSC colour queries — through `onData`, exactly as a real
// terminal would, and the previous hosts forwarded each answer to the
// provider with its own `ipcRenderer.invoke`. One attach measured 21,795
// `session:input` calls in 15 s with a 7.4 s renderer long task, and main
// wrote thousands of stale `ESC[row;colR` replies into the agent's stdin —
// answers to questions the provider asked minutes ago, about a screen it
// has since repainted. The headless terminal in main never answers queries,
// so the renderer xterm is the only responder; that is fine for the live
// stream (the TUI is asking now) and wrong for replay.
//
// WHY coalesce: xterm emits `onData` per parsed input event, so a paste or a
// burst of query replies arrives as many chunks in one tick. Joining what
// arrives within a microtask keeps typing latency invisible while turning
// an N-call burst into one IPC call.
//
// WHY keystrokes typed during replay are dropped rather than queued: the
// window is the ~100 ms xterm takes to parse the replay, the pane has not
// painted yet, and queuing would require telling a stale reply from a real
// key — both are escape sequences.

type ReplayTarget = {
  write(data: string, callback?: () => void): void
}

export type TerminalInputForwarder = {
  /** Feed one `term.onData` chunk. Returns false when it was dropped
   *  because a replay is being parsed. */
  onData(data: string): boolean
  /** True while replayed content is still being parsed by xterm. */
  readonly replaying: boolean
  /** Write replay content into the terminal, dropping whatever it provokes.
   *  Resolves once xterm reports every chunk parsed. */
  replay(term: ReplayTarget, chunks: readonly string[]): Promise<void>
}

export function createTerminalInputForwarder(
  send: (data: string) => void,
  schedule: (flush: () => void) => void = flush => queueMicrotask(flush),
): TerminalInputForwarder {
  let replayDepth = 0
  let pending: string[] = []
  let scheduled = false

  const flush = (): void => {
    scheduled = false
    if (pending.length === 0) return
    const data = pending.length === 1 ? pending[0]! : pending.join('')
    pending = []
    send(data)
  }

  return {
    get replaying() {
      return replayDepth > 0
    },
    onData(data) {
      if (replayDepth > 0) return false
      if (data.length === 0) return true
      pending.push(data)
      if (!scheduled) {
        scheduled = true
        schedule(flush)
      }
      return true
    },
    replay(term, chunks) {
      const writes = chunks.filter(chunk => chunk.length > 0)
      if (writes.length === 0) return Promise.resolve()
      return new Promise(resolve => {
        let remaining = writes.length
        replayDepth += writes.length
        for (const chunk of writes) {
          // xterm invokes the callback after the chunk has been parsed, i.e.
          // after every `onData` it provoked has already fired.
          term.write(chunk, () => {
            replayDepth -= 1
            remaining -= 1
            if (remaining === 0) resolve()
          })
        }
      })
    },
  }
}
