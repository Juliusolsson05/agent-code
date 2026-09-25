/**
 * Decide whether a renderer may register `webContentsId` as a pocket guest.
 *
 * WHY: the renderer hands main a bare webContents id. Without this check a
 * compromised renderer could register the MAIN WINDOW (or another window's
 * guest) as its "pocket" and then drive it with the agent's CDP tools. Only a
 * `webview` hosted by the very window that sent the request qualifies.
 */
export function mayRegisterGuest(
  guest: { getType(): string; hostWebContents?: { id: number } | null; isDestroyed(): boolean } | null | undefined,
  senderId: number,
): boolean {
  if (!guest || guest.isDestroyed()) return false
  return guest.getType() === 'webview' && guest.hostWebContents?.id === senderId
}
