import { ipcRenderer } from 'electron'

// Window-chrome bridge.
//
// One method today. It stays its own domain module rather than joining
// `workspaceApi` because the two answer different questions: workspace
// persistence is about what is IN a window, this is about windows themselves.

export const windowApi = {
  newWindow: (): Promise<void> => ipcRenderer.invoke('window:new'),
}
