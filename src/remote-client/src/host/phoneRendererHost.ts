import type { RendererHost } from '@renderer/features/rendererHost/RendererHostContext'

// The phone's RendererHost (#1177) — what the shared feed rows may do on a
// phone. It replaced five Vite aliases (CodeBlock, the app store, the perf
// client, SafeMarkdownLink, SafeInlineCode); the phone now bundles the very
// same row modules the desktop renders, and this object is the whole
// difference between the two.
//
//   - No Monaco: a phone gets the static hljs engine, which is the layer the
//     desktop paints first anyway — identical markup, no 5 MB editor, no LSP
//     over an IPC bridge that does not exist here.
//   - Links open in a new browser tab. The row has already classified the
//     target as a safe http(s) URL; `noopener` keeps the opened page from
//     reaching back into this authenticated client.
//   - No editor, so file links and file-like inline code render as text.
//   - No rendering-debug overlay and no session recorder to feed evidence to.
export const PHONE_RENDERER_HOST: RendererHost = {
  loadMonacoRuntime: null,
  openExternalUrl: async ({ url }) => {
    // With `noopener` window.open returns null even on success, so its return
    // value says nothing; a throw (a blocked popup in some browsers) is the
    // only failure signal.
    try {
      window.open(url, '_blank', 'noopener,noreferrer')
      return 'opened'
    } catch {
      return 'failed'
    }
  },
  openWorkspaceFile: null,
  renderingDebugMode: false,
  // The recorder lives in the desktop's main process; nothing on a phone can
  // arm render-shape capture.
  sessionRecording: null,
}
