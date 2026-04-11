import { contextBridge, ipcRenderer } from 'electron'

export type JsonlEntry = Record<string, unknown>
export type JsonlEntryEvent = { entry: JsonlEntry; file: string }
export type ScreenSnapshot = { plain: string; markdown: string }

const api = {
  onScreen: (cb: (snap: ScreenSnapshot) => void) => {
    const listener = (_evt: unknown, snap: ScreenSnapshot) => cb(snap)
    ipcRenderer.on('pty:screen', listener)
    return () => ipcRenderer.removeListener('pty:screen', listener)
  },
  onExit: (cb: (code: number) => void) => {
    const listener = (_evt: unknown, code: number) => cb(code)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },
  sendInput: (data: string) => ipcRenderer.invoke('pty:input', data),
  resize: (cols: number, rows: number) => ipcRenderer.invoke('pty:resize', cols, rows),

  // JSONL transcript channel — see src/main/jsonlTailer.ts
  onJsonlEntry: (cb: (event: JsonlEntryEvent) => void) => {
    const listener = (_evt: unknown, payload: JsonlEntryEvent) => cb(payload)
    ipcRenderer.on('jsonl:entry', listener)
    return () => ipcRenderer.removeListener('jsonl:entry', listener)
  },
  onJsonlProjectDir: (cb: (dir: string) => void) => {
    const listener = (_evt: unknown, dir: string) => cb(dir)
    ipcRenderer.on('jsonl:project-dir', listener)
    return () => ipcRenderer.removeListener('jsonl:project-dir', listener)
  },
  onJsonlError: (cb: (msg: string) => void) => {
    const listener = (_evt: unknown, msg: string) => cb(msg)
    ipcRenderer.on('jsonl:error', listener)
    return () => ipcRenderer.removeListener('jsonl:error', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
