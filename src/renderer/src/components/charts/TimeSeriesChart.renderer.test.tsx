import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TimeSeriesChart } from './TimeSeriesChart'

const series = [
  { id: 'a', label: 'Agents', colorClass: 'text-accent', points: [{ at: 1000, value: 1 }, { at: 2000, value: 4 }, { at: 3000, value: 2 }] },
  { id: 'b', label: 'App', colorClass: 'text-info', points: [{ at: 1000, value: 2 }, { at: 2000, value: null }, { at: 3000, value: 3 }] },
]
const format = (value: number) => value.toFixed(1)

describe('interactive time-series chart', () => {
  it('reads every series and the stacked total at one sample from the keyboard', () => {
    render(<TimeSeriesChart label="Memory" series={series} mode="stacked" from={0} to={4000} formatValue={format} />)
    const chart = screen.getByRole('group', { name: /Memory/ })
    const readout = () => document.getElementById(chart.getAttribute('aria-describedby')!)?.textContent
    fireEvent.keyDown(chart, { key: 'End' })
    expect(screen.getByText('Total')).toBeInTheDocument()
    // Read through the live readout: the axis also prints tick values, so a
    // bare text query for a number cannot tell the tooltip from a tick.
    expect(readout()).toMatch(/Agents 2\.0, App 3\.0, total 5\.0/)
    // A missing reading is shown as missing, never as zero.
    fireEvent.keyDown(chart, { key: 'ArrowLeft' })
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(readout()).toMatch(/Agents 4\.0, App no reading, total 4\.0/)
    fireEvent.keyDown(chart, { key: 'Escape' })
    expect(screen.queryByText('Total')).toBeNull()
  })

  it('drives a shared crosshair through the controlled hover time', () => {
    const onHoverAt = vi.fn()
    render(<TimeSeriesChart label="CPU" series={series} from={0} to={4000} formatValue={format} hoverAt={2900} onHoverAt={onHoverAt} />)
    // Snaps to the nearest real sample (3000), not an interpolated time.
    expect(screen.getByText('2.0')).toBeInTheDocument()
    expect(screen.getByText('3.0')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('group', { name: /CPU/ }), { key: 'Home' })
    expect(onHoverAt).toHaveBeenLastCalledWith(1000)
  })
})
