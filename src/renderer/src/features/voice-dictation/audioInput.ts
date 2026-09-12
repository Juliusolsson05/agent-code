import type { DictationAudioInput } from '@renderer/app-state/settings/types'

type DeviceReport = (event: string, data: Record<string, unknown>) => void

export async function pickDictationAudioConstraints(
  selection: DictationAudioInput | null,
  report: DeviceReport = () => {},
): Promise<MediaStreamConstraints> {
  // An explicit selection outranks the old built-in workaround. Use exact,
  // not ideal: silently falling back can record a closed MacBook's microphone
  // while the UI still claims the user's headset is selected.
  // https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/deviceId
  if (selection) {
    report('select:configured', { label: selection.label, systemDefault: selection.deviceId === 'default' })
    return selection.deviceId === 'default'
      ? { audio: true }
      : { audio: { deviceId: { exact: selection.deviceId } } }
  }

  // Preserve the automatic policy for existing users: opening a Bluetooth
  // microphone can switch headphones into HFP/SCO and historically produced
  // silent streams on some Macs. A named user choice deliberately opts out.
  // This is only a preference; without a recognizable built-in mic the OS
  // default remains useful on desktops and other platforms.
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter(device => device.kind === 'audioinput')
    report('enumerate:audioinput', { count: inputs.length, labels: inputs.map(device => device.label) })
    const builtIn = inputs.find(device => {
      // Chromium's default/communications aliases can name the built-in mic
      // now and follow a headset later. Pin the actual physical entry instead.
      if (!device.deviceId || ['default', 'communications'].includes(device.deviceId)) return false
      const label = device.label.toLowerCase()
      return label.includes('microphone') && (
        label.includes('built-in') || label.includes('built in')
        || label.includes('macbook') || /\bimac\b/.test(label)
        || /\bmac\s*mini\b/.test(label) || /\bmac\s*studio\b/.test(label)
      )
    })
    if (builtIn) {
      report('select:built-in', { label: builtIn.label })
      return { audio: { deviceId: { exact: builtIn.deviceId } } }
    }
    report('select:fallback-default', { reason: 'no-built-in-match' })
  } catch (error) {
    // Enumeration can fail or hide labels before permission is granted. The
    // real capture request remains the authority for permission/device errors.
    report('enumerate:throw', { message: error instanceof Error ? error.message : String(error) })
  }
  return { audio: true }
}

export function dictationAudioInputError(
  error: unknown,
  selection: DictationAudioInput | null,
): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow Agent Code in your system microphone privacy settings, then try again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return selection && selection.deviceId !== 'default'
      ? `The selected microphone (${selection.label || 'saved audio input'}) is unavailable. Reconnect it or choose another in Settings → Dictation → Audio Input Device.`
      : 'No microphone is available. Connect an audio input or choose another in Settings → Dictation → Audio Input Device.'
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Could not open the microphone. Check its connection or choose another in Settings → Dictation → Audio Input Device.'
  }
  return error instanceof Error ? error.message : 'Could not start microphone capture.'
}
