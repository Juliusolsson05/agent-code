import { afterEach, describe, expect, it, vi } from 'vitest'
import { dictationAudioInputError, pickDictationAudioConstraints } from './audioInput'

afterEach(() => vi.unstubAllGlobals())

describe('dictation audio input policy', () => {
  it('keeps automatic built-in selection and ignores moving default aliases', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
      { kind: 'audioinput', deviceId: 'headset', label: 'Bluetooth Headset' },
      { kind: 'audioinput', deviceId: 'builtin', label: 'MacBook Pro Microphone' },
    ] } })
    expect(await pickDictationAudioConstraints(null)).toEqual({ audio: { deviceId: { exact: 'builtin' } } })
  })

  it('honors an explicit headset without using inventory as permission to fall back', async () => {
    const enumerateDevices = vi.fn(async () => [])
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } })
    expect(await pickDictationAudioConstraints({ deviceId: 'headset', label: 'Headset' }))
      .toEqual({ audio: { deviceId: { exact: 'headset' } } })
    expect(enumerateDevices).not.toHaveBeenCalled()
  })

  it('system default bypasses the automatic built-in preference', async () => {
    expect(await pickDictationAudioConstraints({ deviceId: 'default', label: 'System default' }))
      .toEqual({ audio: true })
  })

  it.each([{ devices: [] }, { devices: [{ kind: 'audioinput', deviceId: '', label: '' }] }])(
    'uses system default when automatic discovery has no recognizable microphone: %j',
    async ({ devices }) => {
      vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => devices } })
      expect(await pickDictationAudioConstraints(null)).toEqual({ audio: true })
    },
  )

  it('still attempts automatic capture when enumeration is unavailable', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => { throw new Error('blocked') } } })
    expect(await pickDictationAudioConstraints(null)).toEqual({ audio: true })
  })

  it('explains missing saved microphones and permission failures separately', () => {
    const selected = { deviceId: 'headset', label: 'USB Headset' }
    expect(dictationAudioInputError(new DOMException('', 'OverconstrainedError'), selected))
      .toContain('USB Headset')
    expect(dictationAudioInputError(new DOMException('', 'NotFoundError'), selected))
      .toContain('Settings → Dictation → Audio Input Device')
    expect(dictationAudioInputError(new DOMException('', 'NotAllowedError'), selected))
      .toContain('privacy settings')
  })
})
