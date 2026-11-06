import { afterEach, describe, expect, it, vi } from 'vitest'
import { openVoiceTranscript } from './voiceTranscript.js'

afterEach(() => vi.unstubAllGlobals())

describe('opening the following listening transcript', () => {
  it('opens the actual recorder-owned file without requiring a target card', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: '/hark/voice/voice-abc.txt', launch: 'voice-abc', recorder: 'audio-host',
    })))
    vi.stubGlobal('fetch', fetch)
    const openFile = vi.fn()
    await openVoiceTranscript('https://hub.invalid', openFile, 'audio-host')
    expect(fetch).toHaveBeenCalledWith('https://hub.invalid/api/v1/voice/transcript?recorder=audio-host', { cache: 'no-store' })
    expect(openFile).toHaveBeenCalledExactlyOnceWith('/hark/voice/voice-abc.txt', 'Listening transcript', 'audio-host')
  })

  it('uses the local recorder when none is supplied and resolves each click afresh', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: '/hark/voice/voice-a.txt', launch: 'voice-a', recorder: 'local-host' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: '/hark/voice/voice-b.txt', launch: 'voice-b', recorder: 'local-host' })))
    vi.stubGlobal('fetch', fetch)
    const openFile = vi.fn()
    await openVoiceTranscript('', openFile)
    await openVoiceTranscript('', openFile)
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/voice/transcript', { cache: 'no-store' })
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(['/hark/voice/voice-a.txt', '/hark/voice/voice-b.txt'])
  })

  it.each([404, 400, 502])('surfaces a %s without opening a target card or local file', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Recorder transcript unavailable' }), { status })))
    const openFile = vi.fn()
    await expect(openVoiceTranscript('', openFile, 'audio-host')).rejects.toThrow('Recorder transcript unavailable')
    expect(openFile).not.toHaveBeenCalled()
  })

  it('does not fall back to a local file after a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const openFile = vi.fn()
    await expect(openVoiceTranscript('', openFile, 'audio-host')).rejects.toThrow('offline')
    expect(openFile).not.toHaveBeenCalled()
  })
})
