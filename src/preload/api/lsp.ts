import { ipcRenderer } from 'electron'

import type {
  LspDiagnosticsEvent,
  LspSemanticLegend,
  Unsub,
} from './types.js'

// LSP bridge methods.
//
// Diagnostics use a multiplexed subscription pattern instead of the
// per-caller model the other onX methods use. The reason:
//   Monaco-backed code blocks mount and unmount freely as the user
//   scrolls a long transcript. If every mount installed its own
//   ipcRenderer.on listener, a conversation with 50 code blocks
//   would accumulate 50 IPC listeners, then drop back to fewer on
//   unmount — thrashing the listener list inside Electron's IPC and
//   making memory-leak detection noisy. The Set + single ipcRenderer.on
//   pattern installs exactly one listener for the lifetime of the
//   renderer, and we add/remove callbacks against an in-memory Set
//   that doesn't touch IPC at all.

const lspDiagnosticsSubscribers = new Set<(payload: LspDiagnosticsEvent) => void>()
let lspDiagnosticsListenerInstalled = false

function subscribeLspDiagnostics(cb: (payload: LspDiagnosticsEvent) => void): Unsub {
  lspDiagnosticsSubscribers.add(cb)

  if (!lspDiagnosticsListenerInstalled) {
    lspDiagnosticsListenerInstalled = true
    ipcRenderer.on('lsp:diagnostics', (_evt: unknown, payload: LspDiagnosticsEvent) => {
      for (const subscriber of lspDiagnosticsSubscribers) {
        subscriber(payload)
      }
    })
  }

  return () => {
    lspDiagnosticsSubscribers.delete(cb)
  }
}

export const lspApi = {
  ensureLspLegend: (
    workspaceRoot: string,
    language: string,
  ): Promise<LspSemanticLegend | null> =>
    ipcRenderer.invoke('lsp:ensure-legend', workspaceRoot, language),

  openLspDocument: (params: {
    clientUri: string
    content: string
    language: string
    workspaceRoot: string
    filePath?: string | null
  }): Promise<void> => ipcRenderer.invoke('lsp:open-document', params),

  changeLspDocument: (clientUri: string, content: string): Promise<void> =>
    ipcRenderer.invoke('lsp:change-document', clientUri, content),

  closeLspDocument: (clientUri: string): Promise<void> =>
    ipcRenderer.invoke('lsp:close-document', clientUri),

  getLspSemanticTokens: (
    clientUri: string,
  ): Promise<{ data: number[] } | null> =>
    ipcRenderer.invoke('lsp:get-semantic-tokens', clientUri),

  onLspDiagnostics: (cb: (e: LspDiagnosticsEvent) => void): Unsub =>
    subscribeLspDiagnostics(cb),
}
