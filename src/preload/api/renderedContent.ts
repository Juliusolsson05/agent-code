import { ipcRenderer } from 'electron'

export type RenderedContentOpenExternalResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

export const renderedContentApi = {
  openRenderedExternalUrl: (params: {
    url: string
  }): Promise<RenderedContentOpenExternalResult> =>
    ipcRenderer.invoke('rendered-content:open-external-url', params),
}
