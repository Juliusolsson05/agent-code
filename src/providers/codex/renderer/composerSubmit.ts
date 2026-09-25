// Codex composer submit protocol (#394 phase 2c-4).
//
// Codex is always bracketed-paste with the trailing Enter OUTSIDE the
// paste block, both in ONE PTY write — the path that fixed Codex
// swallowing `\r` as pasted text. Codex's own paste handling does NOT
// exhibit Claude's paste-commit race, so there is no event-driven
// wait here; the pasteId is still forwarded so a paste-debug dump can
// confirm "this Enter routed to the Codex protocol" when debugging.
//
// draftImages are ignored: Codex has no inline-image attachment story
// (supportsImageAttachments: false keeps the composer from
// accumulating drafts for codex panes in the first place).

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import type { PromptAcceptance } from '@shared/types/providerConfig'
import { sha8Web } from '@shared/code/sha8'

export async function codexComposerSubmit(io: ComposerSubmitIo): Promise<PromptAcceptance | null> {
  window.api.recordPasteDebugEvent(io.pasteId, {
    layer: 'RENDER',
    event: 'route:codex-bracketed-paste',
  })
  // The write is Codex's own protocol, done here (#1177). It used to borrow
  // the single-write fast path of Claude's paste helper, which lives in the
  // desktop pane's TileLeaf directory — a provider importing workspace
  // internals for one line of bytes. The debug event is the one that path
  // recorded, so paste-debug dumps read the same.
  window.api.recordPasteDebugEvent(io.pasteId, {
    layer: 'IPC',
    event: 'write:paste-and-submit-single',
    data: { bytes: io.input.length, sha8: await sha8Web(io.input) },
  })
  await io.send(`\x1b[200~${io.input}\x1b[201~\r`, io.pasteId)
  // Codex has no delivery result: the submit is raw PTY writes and the
  // rollout's committed user row is the only acceptance signal, which arrives
  // later through the JSONL channel. `null` tells the composer it has no
  // acceptance kind to act on (#889 settles only on an explicit `queue`).
  return null
}
