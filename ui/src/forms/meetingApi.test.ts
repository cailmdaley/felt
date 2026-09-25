import { describe, expect, it, vi } from 'vitest'
import { stopMeeting } from './meetingApi'

describe('stopMeeting', () => {
  it('posts to the local meeting stop route and treats a missing meeting as already stopped', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
    await expect(stopMeeting('http://daemon', fetcher)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith('http://daemon/api/v1/meeting/stop', { method: 'POST' })
  })
})
