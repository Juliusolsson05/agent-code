import { useEffect, useId, useRef, useState } from 'react'
import type { DictationAudioInput } from '@renderer/app-state/settings/types'
import { Button } from '@renderer/components/ui/button'
import { dictationAudioInputError } from './audioInput'

type Props = {
  value: DictationAudioInput | null
  onChange: (value: DictationAudioInput | null) => void
}

export function DictationAudioInputRow({ value, onChange }: Props) {
  const descriptionId = useId()
  const [inputs, setInputs] = useState<MediaDeviceInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestingAccess, setRequestingAccess] = useState(false)
  const [hasAccess, setHasAccess] = useState(false)
  const actions = useRef({ refresh: () => {}, requestAccess: () => {} })

  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) {
      setError('Microphone selection is unavailable in this window.')
      return
    }
    let disposed = false
    let revision = 0
    let permissionPending = false
    let permissionStream: MediaStream | undefined
    const releasePermissionStream = () => {
      permissionStream?.getTracks().forEach(track => track.stop())
      permissionStream = undefined
    }
    const refresh = async () => {
      const requestedRevision = ++revision
      try {
        const devices = (await media.enumerateDevices()).filter(device => device.kind === 'audioinput')
        // Hotplug and manual refresh may overlap. Only the newest inventory
        // may replace the list, and a closed settings row owns no UI updates.
        if (disposed || requestedRevision !== revision) return
        setInputs(devices)
        if (devices.some(device => device.label)) setHasAccess(true)
        setError(null)
      } catch (cause) {
        if (!disposed && requestedRevision === revision) {
          setError(`Could not list microphones. ${cause instanceof Error ? cause.message : 'Try refreshing the list.'}`)
        }
      }
    }
    const requestAccess = async () => {
      if (permissionPending) return
      permissionPending = true
      ++revision
      setRequestingAccess(true)
      setError(null)
      try {
        // Enumeration hides names until capture permission exists. Opening
        // Settings must not itself activate a mic; this explicit gesture gets
        // permission and reads labels while the stream is live, then releases
        // it even if the permission dialog outlives the settings component.
        // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices
        permissionStream = await media.getUserMedia({ audio: true })
        if (!disposed) {
          setHasAccess(true)
          await refresh()
        }
      } catch (cause) {
        // An inventory requested before denial must not later erase that
        // actionable error merely because it can still return anonymous inputs.
        ++revision
        if (!disposed) setError(dictationAudioInputError(cause, null))
      } finally {
        releasePermissionStream()
        permissionPending = false
        if (!disposed) setRequestingAccess(false)
      }
    }
    const onDeviceChange = () => { void refresh() }
    actions.current = {
      refresh: onDeviceChange,
      requestAccess: () => { void requestAccess() },
    }
    media.addEventListener('devicechange', onDeviceChange)
    void refresh()
    return () => {
      disposed = true
      // Enumeration can wait while the document is hidden. Closing Settings
      // must release audio immediately, not wait for that promise to settle.
      releasePermissionStream()
      media.removeEventListener('devicechange', onDeviceChange)
    }
  }, [])

  const devices = (inputs ?? []).filter(device =>
    device.deviceId && !['default', 'communications'].includes(device.deviceId))
  const savedDevice = value && value.deviceId !== 'default'
    && !devices.some(device => device.deviceId === value.deviceId)
  const unavailable = savedDevice && inputs !== null && hasAccess && !error
  const systemDefault = inputs?.find(device => device.deviceId === 'default')?.label

  return (
    <div className="flex flex-col gap-2">
      <select
        aria-label="Audio Input Device"
        aria-describedby={descriptionId}
        value={value?.deviceId ?? ''}
        onChange={event => {
          const id = event.target.value
          if (!id) onChange(null)
          else if (id === 'default') onChange({ deviceId: 'default', label: 'System default' })
          else {
            const device = devices.find(candidate => candidate.deviceId === id)
            if (device) onChange({ deviceId: id, label: device.label })
          }
        }}
        className="w-full min-w-0 rounded-control border border-control-border bg-control-bg px-3 py-2 text-[12px] text-control-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <option value="">Automatic — prefer built-in microphone</option>
        <option value="default">System default{systemDefault ? ` — ${systemDefault.replace(/^default\s*-\s*/i, '')}` : ''}</option>
        {savedDevice ? (
          <option value={value.deviceId}>{value.label || 'Saved microphone'}{unavailable ? ' — unavailable' : ''}</option>
        ) : null}
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>
        ))}
      </select>
      <p id={descriptionId} className="text-[11px] leading-5 text-muted">
        Changes apply to your next recording. For a closed MacBook, choose your headset or an external microphone.
      </p>
      {unavailable ? (
        <p role="status" className="text-[11px] leading-5 text-muted">
          Your selected microphone is unavailable. Reconnect it or choose another input.
        </p>
      ) : null}
      {inputs === null && !error ? <p role="status" className="text-[11px] text-muted">Looking for microphones…</p> : null}
      {hasAccess && inputs?.length === 0 ? <p role="status" className="text-[11px] text-muted">No microphones found. Connect an audio input and refresh.</p> : null}
      {error ? <p role="alert" className="text-[11px] leading-5 text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => actions.current.refresh()}>Refresh Devices</Button>
        {!hasAccess ? (
          <Button variant="outline" size="sm" disabled={requestingAccess} onClick={() => actions.current.requestAccess()}>
            {requestingAccess ? 'Waiting for Access…' : 'Allow Microphone Access'}
          </Button>
        ) : null}
      </div>
      {!hasAccess ? <p className="text-[11px] leading-5 text-muted">Allow microphone access to see all connected inputs and their names.</p> : null}
    </div>
  )
}
