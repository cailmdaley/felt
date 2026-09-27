import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MeetingControl } from './CaptureForm'

const render = (mode: 'call' | 'room' | null): string =>
  renderToStaticMarkup(<MeetingControl mode={mode} disabled={false} onChange={() => {}} />)

describe('capture meeting control', () => {
  it('is a pressed-state button, not a checkbox', () => {
    expect(render(null)).toContain('<button type="button" class="capture-meeting-toggle" aria-pressed="false"')
    expect(render('call')).toContain('aria-pressed="true"')
    expect(render(null)).not.toContain('checkbox')
  })

  it('lays out the mode segments whether or not meeting is on, so revealing them moves nothing', () => {
    const off = render(null)
    const on = render('room')
    expect(off).toContain('role="radiogroup"')
    expect(off).toMatch(/<div class="capture-meeting-modes"[^>]* hidden=""/)
    expect(on).not.toMatch(/capture-meeting-modes"[^>]* hidden/)
    expect(off.match(/role="radio"/g)).toHaveLength(2)
    expect(on).toMatch(/aria-checked="true"[^>]*>Room</)
  })
})
