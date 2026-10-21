import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MeetingControl } from './CaptureForm'

describe('capture meeting control', () => {
  it.each([false, true])('offers only one Meeting toggle when enabled=%s', enabled => {
    const html = renderToStaticMarkup(<MeetingControl enabled={enabled} disabled={false} onChange={() => {}} />)
    expect(html).toContain(`aria-pressed="${enabled}"`)
    expect(html.match(/<button /g)).toHaveLength(1)
    expect(html).toContain('Meeting</button>')
    expect(html).not.toContain('role="radio')
  })
})
