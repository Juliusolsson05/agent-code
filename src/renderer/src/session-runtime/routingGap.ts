// Kept browser-only: the shared pane header is also bundled by the phone and
// must not import desktop history loaders just to offer a refresh button.
export const SESSION_ROUTING_REFRESH = 'agent-code:refresh-session-observations'
export function requestSessionRoutingRefresh(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(SESSION_ROUTING_REFRESH, { detail: sessionId }))
}
