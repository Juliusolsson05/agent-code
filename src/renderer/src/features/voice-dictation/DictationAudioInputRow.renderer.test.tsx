import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationAudioInput } from '@renderer/app-state/settings/types'
import { DictationAudioInputRow } from './DictationAudioInputRow'

function device(deviceId: string, label: string, kind: MediaDeviceKind = 'audioinput'): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: '', toJSON: () => ({ deviceId, label, kind }) }
}

const builtin = device('builtin', 'MacBook Pro Microphone')
const headset = device('headset', 'USB Headset')
const enumerateDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>()
const stopTrack = vi.fn()
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }))
const onChange = vi.fn()
let events: EventTarget

function Harness({ initial = null }: { initial?: DictationAudioInput | null }) {
  const [value, setValue] = useState(initial)
  return <DictationAudioInputRow value={value} onChange={next => { onChange(next); setValue(next) }} />
}

beforeEach(() => {
  vi.clearAllMocks()
  enumerateDevices.mockReset().mockResolvedValue([builtin, headset, device('speaker', 'Speakers', 'audiooutput')])
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
  events = new EventTarget()
  vi.stubGlobal('navigator', { mediaDevices: {
    enumerateDevices, getUserMedia,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('dictation microphone settings', () => {
  it('lists inputs without opening a microphone, and saves the chosen ID and label', async () => {
    render(<Harness />)
    await screen.findByRole('option', { name: 'USB Headset' })
    expect(screen.queryByRole('option', { name: 'Speakers' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Audio Input Device' }), { target: { value: 'headset' } })
    expect(onChange).toHaveBeenLastCalledWith({ deviceId: 'headset', label: 'USB Headset' })
    expect(getUserMedia).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'default' } })
    expect(onChange).toHaveBeenLastCalledWith({ deviceId: 'default', label: 'System default' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('retains an unplugged choice and recognizes it when reconnected', async () => {
    render(<Harness initial={{ deviceId: 'headset', label: 'USB Headset' }} />)
    await screen.findByRole('option', { name: 'USB Headset' })
    enumerateDevices.mockResolvedValue([builtin])
    act(() => { events.dispatchEvent(new Event('devicechange')) })
    await screen.findByRole('option', { name: 'USB Headset — unavailable' })
    expect(screen.getByRole('combobox')).toHaveValue('headset')
    expect(onChange).not.toHaveBeenCalled()
    enumerateDevices.mockResolvedValue([builtin, headset])
    act(() => { events.dispatchEvent(new Event('devicechange')) })
    await screen.findByRole('option', { name: 'USB Headset' })
    expect(screen.queryByText(/Your selected microphone is unavailable/)).not.toBeInTheDocument()
  })

  it('requests access only on click and stops the temporary stream after reading labels', async () => {
    enumerateDevices.mockResolvedValue([device('', '')])
    render(<Harness />)
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce())
    expect(getUserMedia).not.toHaveBeenCalled()
    enumerateDevices.mockResolvedValue([builtin, headset])
    fireEvent.click(screen.getByRole('button', { name: 'Allow Microphone Access' }))
    await screen.findByRole('option', { name: 'USB Headset' })
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Allow Microphone Access' })).not.toBeInTheDocument()
  })

  it('shows permission denial with a retry action', async () => {
    enumerateDevices.mockResolvedValue([device('', '')])
    getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow Microphone Access' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('privacy settings')
    expect(screen.getByRole('button', { name: 'Allow Microphone Access' })).toBeEnabled()
  })

  it('stops a permission stream that arrives after the row unmounts', async () => {
    enumerateDevices.mockResolvedValue([])
    let grant!: (stream: { getTracks: () => { stop: typeof stopTrack }[] }) => void
    getUserMedia.mockReturnValueOnce(new Promise(resolve => { grant = resolve }))
    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow Microphone Access' }))
    view.unmount()
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }) })
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it('releases an open permission stream on unmount even while enumeration is pending', async () => {
    enumerateDevices.mockResolvedValueOnce([])
    const view = render(<Harness />)
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalledOnce())
    let finish!: (devices: MediaDeviceInfo[]) => void
    enumerateDevices.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow Microphone Access' }))
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalledTimes(2))
    expect(stopTrack).not.toHaveBeenCalled()
    view.unmount()
    expect(stopTrack).toHaveBeenCalledOnce()
    await act(async () => { finish([builtin]) })
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it('does not let pending enumeration erase a permission error', async () => {
    let finish!: (devices: MediaDeviceInfo[]) => void
    enumerateDevices.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    getUserMedia.mockRejectedValueOnce(new DOMException('', 'NotAllowedError'))
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow Microphone Access' }))
    await screen.findByRole('alert')
    await act(async () => { finish([device('', '')]) })
    expect(screen.getByRole('alert')).toHaveTextContent('privacy settings')
  })

  it('ignores an older inventory response after a newer refresh completes', async () => {
    let stale!: (devices: MediaDeviceInfo[]) => void
    enumerateDevices.mockReturnValueOnce(new Promise(resolve => { stale = resolve }))
    render(<Harness initial={{ deviceId: 'headset', label: 'USB Headset' }} />)
    enumerateDevices.mockResolvedValue([builtin])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Devices' }))
    await screen.findByRole('option', { name: 'USB Headset — unavailable' })
    await act(async () => { stale([builtin, headset]) })
    expect(screen.getByRole('option', { name: 'USB Headset — unavailable' })).toBeInTheDocument()
  })
})
