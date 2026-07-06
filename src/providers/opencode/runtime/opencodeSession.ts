// OpencodeSession — the AgentSession runtime for opencode (#406).
//
// STATUS: wiring step 2 of 7 (see the issue's wiring order). This is
// the compile-green STUB: it satisfies the typed AgentSession contract
// so the registries close, and start() fails loudly so a spawned
// opencode pane reports "wiring in progress" instead of pretending.
// Step 3 replaces the body with the real OpencodeHeadless wrapper
// (spawn-mode SpawnedServer, ready→started, activity→process-state,
// committed entry→jsonl-entry, semantic→semantic-event, exit→exit,
// no-op write/resize — opencode has no PTY).
//
// WHY the stub ships on the branch at all: adding 'opencode' to
// AGENT_PROVIDER_KINDS makes every registry hole a compile error at
// once; closing them immediately keeps the branch buildable while the
// real pieces land commit by commit. The branch does NOT merge until
// the pane is usable (steps 1–6 together, per #406's merge policy).

import { EventEmitter } from 'events'

import type { AgentSession, SessionOptions } from '@shared/types/session.js'

export class OpencodeSession extends EventEmitter implements AgentSession {
  private readonly options: SessionOptions

  constructor(options: SessionOptions) {
    super()
    this.options = options
  }

  async start(): Promise<void> {
    throw new Error(
      `opencode provider wiring is in progress (#406) — cannot start a session in ${this.options.cwd} yet`,
    )
  }

  async stop(): Promise<void> {
    // Nothing to stop — start() never succeeds in the stub.
  }

  /** Opencode has NO PTY — there are no raw bytes to write. The real
   *  runtime keeps this a no-op too; input flows through deliverPrompt
   *  (HTTP) and condition custom actions (#406 §B). */
  write(_data: string): void {}

  /** No PTY → no terminal geometry. Permanent no-op by design. */
  resize(_cols: number, _rows: number): void {}

  isExited(): boolean {
    return true
  }

  getProcessPid(): number | null {
    return null
  }
}
