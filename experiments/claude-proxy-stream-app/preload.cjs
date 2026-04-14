const { ipcRenderer } = require('electron')

window.demoApi = {
  onTerminalData: (listener) =>
    ipcRenderer.on('demo:terminal-data', (_event, data) => listener(data)),
  onStreamText: (listener) =>
    ipcRenderer.on('demo:stream-text', (_event, text) => listener(text)),
  onStreamEvent: (listener) =>
    ipcRenderer.on('demo:stream-event', (_event, payload) => listener(payload)),
  onStatus: (listener) =>
    ipcRenderer.on('demo:status', (_event, status) => listener(status)),
  onReady: (listener) =>
    ipcRenderer.on('demo:ready', (_event, info) => listener(info)),
  onProxyLog: (listener) =>
    ipcRenderer.on('demo:proxy-log', (_event, text) => listener(text)),
  write: (data) => ipcRenderer.invoke('demo:write', data),
  resize: (cols, rows) => ipcRenderer.invoke('demo:resize', { cols, rows }),
}
