import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdtempSync, openSync, rmSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// agy 1.5 emits this TUI-owned record when it selects a conversation. General
// GetConversationDetail records also name OTHER conversations, e.g. when browsing history.
const activeStream = /^I\d{4} \d\d:\d\d:\d\d\.\d{6}\s+\d+ conversation_manager\.go:\d+\] Streaming conversation ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/

const missingTarget = /^W\d{4} \d\d:\d\d:\d\d\.\d{6}\s+\d+ projectresolve\.go:\d+\] Conversation ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) not found, ignoring --conversation flag$/

/** A private FIFO keeps agy's diagnostics out of scrollback and off disk. Each pane has its own
 * pipe, and libuv watches its nonblocking fd without occupying an fs worker per running agent. */
export function openAntigravityIdentityPipe(listeners: {
  active: (id: string) => void
  missing: (id: string) => void
  error: () => void
}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-code-agy-'))
  const path = join(dir, 'session.fifo')
  let fd: number | undefined
  let stream: Socket
  try {
    execFileSync('/usr/bin/mkfifo', ['-m', '600', path], { timeout: 2000, stdio: 'ignore' })
    fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK)
    stream = new Socket({ fd, readable: true, writable: false })
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  // Unrelated log lines can be arbitrarily long. Keep at most the length of a short metadata
  // record across chunks, discarding the remainder (including partial suffixes) until newline.
  let partial: string | null = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    const parts = chunk.split('\n')
    for (const [index, part] of parts.entries()) {
      partial = partial !== null && partial.length + part.length <= 256 ? partial + part : null
      if (index < parts.length - 1) {
        const id = partial && activeStream.exec(partial)?.[1]
        if (id) listeners.active(id)
        else {
          const missing = partial && missingTarget.exec(partial)?.[1]
          if (missing) listeners.missing(missing)
        }
        partial = ''
      }
    }
  })
  stream.on('error', listeners.error)
  return { path, close() {
    stream.destroy()
    rmSync(dir, { recursive: true, force: true })
  } }
}
