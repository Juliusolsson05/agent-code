import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UpdateChannelSnapshot } from '@shared/updates/updateChannel'

import { UpdateChannelRow } from './UpdateChannelRow'

// #1168: the row fronts main's updates.json. It must show what main says is
// in effect (a preview build defaults to Preview) and write through IPC,
// never keep its own copy.

function mount(initial: UpdateChannelSnapshot) {
  const setUpdateChannel = vi.fn(async (channel: 'stable' | 'preview') => ({ ...initial, channel }))
  Object.assign(window, {
    api: { ...window.api, getUpdateChannel: vi.fn(async () => initial), setUpdateChannel },
  })
  return { setUpdateChannel }
}

afterEach(() => cleanup())

describe('Update channel row', () => {
  it('shows the channel main reports and the running version', async () => {
    mount({ channel: 'preview', version: '0.1.4-preview.20260924', packaged: true })
    await act(async () => { render(<UpdateChannelRow />) })
    expect(screen.getByRole('button', { name: /^Preview/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^Stable/ }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(/Agent Code 0\.1\.4-preview\.20260924\. File → Check for Updates… uses this channel\./)).toBeTruthy()
  })

  it('switches through main and shows the answer', async () => {
    const { setUpdateChannel } = mount({ channel: 'stable', version: '0.1.3', packaged: true })
    await act(async () => { render(<UpdateChannelRow />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Preview/ })) })
    expect(setUpdateChannel).toHaveBeenCalledWith('preview')
    expect(screen.getByRole('button', { name: /^Preview/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('says a local build never updates', async () => {
    mount({ channel: 'stable', version: '0.1.3', packaged: false })
    await act(async () => { render(<UpdateChannelRow />) })
    expect(screen.getByText(/runs from a local build and never updates itself/)).toBeTruthy()
  })
})
