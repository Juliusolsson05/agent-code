import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from '@renderer/components/ui/button'
import { OptionCards } from '@renderer/components/ui/option-cards'
import { SegmentedControl } from '@renderer/components/ui/segmented-control'

// A visible keyboard focus on accent-filled controls (Claude review of #1221,
// reviewer C F1). Every built-in theme's focus ring is the accent itself, so a
// flush 1px accent ring on an accent fill showed nothing. #1221 puts focus on
// exactly these controls: filled confirms open focused, and the checked
// choice card is its group's only Tab stop.
//
// happy-dom does not paint, so these pin the classes that separate the ring
// from the fill. The owner checklist covers the look itself.

describe('focus ring on accent fills', () => {
  it('the filled Button offsets its ring from the fill', () => {
    render(<Button>Trust Folder</Button>)
    const cls = screen.getByRole('button', { name: 'Trust Folder' }).className
    expect(cls).toContain('focus-visible:ring-offset-1')
    expect(cls).toContain('focus-visible:ring-offset-surface')
  })

  it('the checked choice card, always the focused one, offsets its ring', () => {
    render(<OptionCards label="Theme" value="nord" onChange={() => {}} options={[{ value: 'nord', label: 'Nord' }, { value: 'light', label: 'Light' }]} />)
    expect(screen.getByRole('radio', { name: 'Nord' }).className).toContain('focus-visible:ring-offset-1')
  })

  it('the selected segment draws its inset ring in the fill\'s foreground', () => {
    render(<SegmentedControl label="Layout" semantics="radio" value="split" onChange={() => {}} options={[{ value: 'split', label: 'Split' }, { value: 'agent', label: 'Agent' }]} />)
    const selected = screen.getByRole('radio', { name: 'Split' }).className
    expect(selected).toContain('focus-visible:ring-control-active-fg')
    expect(screen.getByRole('radio', { name: 'Agent' }).className).not.toContain('ring-control-active-fg')
  })
})
