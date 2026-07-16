import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type {
  RemotePairingIssue,
  RemoteStatus,
} from '@preload/api/remote'

// Desktop control panel for the remote mobile companion: enable/disable the
// server, pair a phone via QR, list + revoke devices.
//
// WHY this talks to window.api directly instead of the SessionFeed: the
// panel manages the SERVER (desktop-only infrastructure), not session I/O.
// SessionFeed is the session-data contract shared with the phone; the phone
// must never manage the server it is connected through, so putting these
// calls on the feed would widen the shared contract with methods one of its
// two implementations must stub out. Direct preload use is the correct
// altitude — same as every other desktop-only surface (git bar, LSP, etc).
//
// WHY the QR encodes `${url}/#code=…`: one scan does everything — the phone
// opens the client page AND the client reads the one-time code from the
// fragment to pair itself. Fragments never appear in HTTP request logs, so
// the code doesn't leak into anything that persists.

type PairingView = RemotePairingIssue & { qrDataUrl: string }

export function RemotePanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [pairing, setPairing] = useState<PairingView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void window.api.remoteGetStatus().then(s => {
      if (!disposed) setStatus(s)
    })
    const off = window.api.onRemoteStatusChanged(s => setStatus(s))
    return () => {
      disposed = true
      off()
    }
  }, [])

  // Pairing codes are single-use and expire in 5 minutes; drop the QR from
  // view once it can no longer work so a stale screenshot doesn't masquerade
  // as a live pairing surface.
  useEffect(() => {
    if (!pairing) return
    const remaining = pairing.expiresAt - Date.now()
    if (remaining <= 0) {
      setPairing(null)
      return
    }
    const timer = window.setTimeout(() => setPairing(null), remaining)
    return () => window.clearTimeout(timer)
  }, [pairing])

  const withBusy = useCallback(async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const toggleServer = useCallback(() => {
    void withBusy(async () => {
      if (status?.enabled) {
        setPairing(null)
        setStatus(await window.api.remoteDisable())
      } else {
        setStatus(await window.api.remoteEnable('lan'))
      }
    })
  }, [status?.enabled, withBusy])

  const switchTransport = useCallback(
    (mode: 'lan' | 'tunnel') => {
      void withBusy(async () => {
        // Switching drops the old URL (and every connected phone — they
        // reconnect via feed backoff), so any visible pairing QR is stale
        // the moment this resolves. Clear it rather than show a dead code.
        setPairing(null)
        setStatus(await window.api.remoteEnable(mode))
      })
    },
    [withBusy],
  )

  const startPairing = useCallback(() => {
    void withBusy(async () => {
      const issued = await window.api.remoteIssuePairingCode()
      // Rendered locally to a data URL — nothing leaves the machine, no CDN.
      const qrDataUrl = await QRCode.toDataURL(issued.pairUrl, {
        margin: 1,
        width: 220,
      })
      setPairing({ ...issued, qrDataUrl })
    })
  }, [withBusy])

  const revoke = useCallback(
    (deviceId: string) => {
      void withBusy(async () => {
        await window.api.remoteRevokeDevice(deviceId)
        setStatus(await window.api.remoteGetStatus())
      })
    },
    [withBusy],
  )

  const devices = status?.devices.filter(d => !d.revoked) ?? []
  const connected = new Set(status?.connectedDeviceIds ?? [])

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[80vh] w-[440px] flex-col overflow-y-auto border-border p-0 text-[12px]"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border select-none">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Remote Control</div>
            <DialogTitle className="font-medium">Control your agents from a phone</DialogTitle>
            <DialogDescription className="sr-only">
              Configure the remote server, pair phones, and manage connected devices.
            </DialogDescription>
          </div>
          <button
            className="text-muted hover:text-ink px-1"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-3 flex flex-col gap-4">
          {/* Server toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">LAN server</div>
              <div className="text-ink-dim truncate">
                {status?.enabled
                  ? `Serving at ${status.url}`
                  : 'Off — phones cannot connect'}
              </div>
            </div>
            <button
              className={`border px-3 py-1.5 flex-shrink-0 ${
                status?.enabled
                  ? 'border-border bg-surface-hi text-ink'
                  : 'border-border bg-surface-hi text-ink-dim hover:text-ink'
              }`}
              disabled={busy || status === null}
              onClick={toggleServer}
            >
              {status?.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>

          {/* #495 A11: when the macOS application firewall silently drops
              inbound connections, the bind SUCCEEDS — the desktop cannot
              detect it, the phone just times out. Honest static guidance is
              the right-sized fix (auto-falling back to Tunnel would
              contradict the controller's documented fail-loud policy), so
              this renders whenever LAN is live, not only after a failure. */}
          {status?.enabled && status.transport === 'lan' && (
            <div className="text-ink-dim text-[10px]">
              Phone can&apos;t connect? macOS Firewall may be blocking Agent Code —
              allow incoming connections in System Settings, or switch to Tunnel.
            </div>
          )}

          {error && <div className="text-danger">{error}</div>}

          {/* Transport: LAN (default, zero dependencies) vs internet tunnel */}
          {status?.enabled && (
            <div className="border-t border-border pt-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">Reach</div>
                  <div className="text-ink-dim">
                    {status.transport === 'tunnel'
                      ? 'Internet tunnel — works anywhere; URL changes each enable.'
                      : 'Same Wi-Fi only. Switch to reach it from anywhere.'}
                  </div>
                </div>
                <div className="flex flex-shrink-0">
                  <button
                    className={`border px-3 py-1.5 ${
                      status.transport === 'lan'
                        ? 'border-border bg-surface-hi text-ink'
                        : 'border-border text-ink-dim hover:text-ink'
                    }`}
                    disabled={busy || status.transport === 'lan'}
                    onClick={() => switchTransport('lan')}
                  >
                    LAN
                  </button>
                  <button
                    className={`border border-l-0 px-3 py-1.5 ${
                      status.transport === 'tunnel'
                        ? 'border-border bg-surface-hi text-ink'
                        : 'border-border text-ink-dim hover:text-ink'
                    }`}
                    disabled={busy || status.transport === 'tunnel'}
                    onClick={() => switchTransport('tunnel')}
                  >
                    Tunnel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Pairing */}
          {status?.enabled && (
            <div className="border-t border-border pt-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="font-medium">Pair a device</div>
                <button
                  className="border border-border bg-surface-hi px-3 py-1.5 text-ink-dim hover:text-ink"
                  disabled={busy}
                  onClick={startPairing}
                >
                  {pairing ? 'New code' : 'Show QR'}
                </button>
              </div>
              {pairing ? (
                <div className="flex flex-col items-center gap-2 py-2">
                  <img
                    src={pairing.qrDataUrl}
                    alt="Pairing QR code"
                    width={220}
                    height={220}
                  />
                  <div className="font-code tracking-[0.3em] text-lg">{pairing.code}</div>
                  <div className="text-ink-dim text-center">
                    Scan with your phone camera, or open{' '}
                    <span className="font-code">{status.url}</span> and enter the code.
                    Single use · expires in 5 minutes.
                  </div>
                </div>
              ) : (
                <div className="text-ink-dim">
                  Each code pairs one device and expires after 5 minutes.
                </div>
              )}
            </div>
          )}

          {/* Devices */}
          <div className="border-t border-border pt-3 flex flex-col gap-2">
            <div className="font-medium">Paired devices</div>
            {devices.length === 0 ? (
              <div className="text-ink-dim">No devices paired yet.</div>
            ) : (
              devices.map(device => (
                <div key={device.deviceId} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate">
                      {device.name}
                      {connected.has(device.deviceId) && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-success">
                          connected
                        </span>
                      )}
                    </div>
                    <div className="text-ink-dim text-[10px]">
                      paired {new Date(device.createdAt).toLocaleDateString()}
                      {device.lastSeenAt
                        ? ` · last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                        : ''}
                    </div>
                  </div>
                  <button
                    className="border border-border px-2 py-1 text-ink-dim hover:text-danger flex-shrink-0"
                    disabled={busy}
                    onClick={() => revoke(device.deviceId)}
                  >
                    Revoke
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="text-[10px] text-ink-dim border-t border-border pt-2">
            Phones can read sessions, send prompts, and answer permission dialogs.
            They cannot run shell commands or start/stop sessions — those actions
            do not exist in the wire protocol.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
