import { contextBridge } from 'electron'

const noop = () => {}

contextBridge.exposeInMainWorld('api', {
  openLspDocument: async () => {},
  closeLspDocument: async () => {},
  onLspDiagnostics: () => noop,
  changeLspDocument: async () => {},
  getLspSemanticTokens: async () => null,
  ensureLspLegend: async () => null,
  sendInput: async () => true,
  saveClaudeImage: async () => ({ path: '' }),
})
