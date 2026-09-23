/**
 * The slice of Electron's WebviewTag the host uses. The renderer's tsconfig
 * does not load Electron's types (the renderer must never import electron), so
 * this is declared here instead of pulling `Electron.WebviewTag` in.
 */
export type WebviewElement = HTMLElement & {
  getWebContentsId(): number
  getURL(): string
  loadURL(url: string): Promise<void>
  reload(): void
  reloadIgnoringCache(): void
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  openDevTools(): void
}
