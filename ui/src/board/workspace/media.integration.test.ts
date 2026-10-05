// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFileViewer, disposeFileViewer, suspendFileViewer, resumeFileViewer } from '../FileViewerPanel.js'
import { DocumentHost } from './DocumentHost.js'
import type { WorkspaceDocument } from './documents.js'

let host: DocumentHost | undefined
const viewers: HTMLElement[] = []
const playing = new WeakSet<HTMLMediaElement>()
const doc = (path: string, kind: 'audio' | 'video' | 'other'): WorkspaceDocument => ({
  key: `host-a:${path}`, owner: 'host-a', path, kind, name: path.slice(1),
  provenance: [{ kind: 'embed', title: 'A small listening room' }, { kind: 'sent', time: 1, worker: 'sol' }],
})
beforeEach(() => {
  document.body.replaceChildren()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () { playing.delete(this) })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
    playing.add(this)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function () { return !playing.has(this) })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, size: 2048 }))))
})
afterEach(() => {
  host?.dispose(); host = undefined
  for (const viewer of viewers.splice(0)) disposeFileViewer(viewer)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const viewer = (path: string, options = {}) => {
  const el = buildFileViewer('', path, 'host-a', undefined, undefined, options)
  viewers.push(el); document.body.append(el)
  return el
}

describe('native media documents', () => {
  it('classifies all audio/video suffixes and gives the page its title and provenance', () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus']) {
      const el = viewer(`/song.${ext}`, { title: 'Song', provenance: 'sent · host-a' })
      expect(el.querySelector('h1')?.textContent).toBe('Song')
      expect(el.querySelector('.kbn-media-provenance')?.textContent).toBe('sent · host-a')
      expect(el.querySelector('audio')?.controls).toBe(true)
    }
    for (const ext of ['mp4', 'm4v', 'mov', 'webm']) {
      const video = viewer(`/film.${ext}`).querySelector('video')!
      expect(video.controls && video.playsInline).toBe(true)
      expect(video.preload).toBe('metadata')
    }
  })

  it('pauses the preceding player, retains playback position, and never resumes automatically', async () => {
    const first = viewer('/song.mp3'), second = viewer('/film.mp4')
    const audio = first.querySelector('audio')!, video = second.querySelector('video')!
    await audio.play(); expect(audio.paused).toBe(false)
    await video.play(); expect(audio.paused).toBe(true); expect(video.paused).toBe(false)
    video.currentTime = .4
    suspendFileViewer(second)
    expect(video.paused).toBe(true)
    resumeFileViewer(second)
    expect(video.currentTime).toBe(.4); expect(video.paused).toBe(true)
    suspendFileViewer(first)
    await audio.play(); expect(audio.paused).toBe(true)
  })

  it('keeps the element through receding and parking and takes Space without stealing typing', async () => {
    const track = document.createElement('div'); document.body.append(track)
    host = new DocumentHost(track, { shuttleBase: '', buildProse: () => document.createElement('div'), onSelect: () => {} })
    const audioDoc = doc('/song.mp3', 'audio'), videoDoc = doc('/film.mp4', 'video')
    host.setChannel([audioDoc, videoDoc], audioDoc.key)
    const audio = host.get(audioDoc.key)!.viewer!.querySelector('audio')!
    audio.dispatchEvent(new Event('loadedmetadata'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    expect(audio.paused).toBe(false)
    audio.currentTime = .5
    host.select(videoDoc.key); expect(audio.paused).toBe(true)
    host.select(audioDoc.key)
    expect(host.get(audioDoc.key)!.viewer!.querySelector('audio')).toBe(audio)
    expect(audio.paused).toBe(true); expect(audio.currentTime).toBe(.5)
    const field = document.createElement('textarea'); document.body.append(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    expect(audio.paused).toBe(true)
    host.parkAll(); host.setChannel([audioDoc, videoDoc], audioDoc.key)
    expect(host.get(audioDoc.key)!.viewer!.querySelector('audio')).toBe(audio)
    expect(audio.currentTime).toBe(.5); expect(audio.paused).toBe(true)
  })

  it('draws unsupported documents with file-info size and a download', async () => {
    const el = viewer('/archive.zip')
    await vi.waitFor(() => expect(el.textContent).toContain('2,048 bytes'))
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.querySelector('a')?.download).toBe('archive.zip')
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/file-info?'), expect.anything())
  })

  it('uses inert audio duration, video first frame and native PDF page-one thumbnails', () => {
    const audio = viewer('/song.mp3', { thumbnail: true, onState: vi.fn() })
    const media = audio.querySelector('audio')!
    Object.defineProperty(media, 'duration', { value: 61 })
    media.dispatchEvent(new Event('loadedmetadata'))
    expect(audio.textContent).toContain('1:01'); expect(media.controls).toBe(false)
    const video = viewer('/film.webm', { thumbnail: true }).querySelector('video')!
    expect(video.muted).toBe(true); expect(video.controls).toBe(false)
    const pdf = viewer('/paper.pdf', { thumbnail: true }).querySelector('iframe')!
    expect(pdf.src).toContain('#page=1&view=FitH&toolbar=0')
    expect(pdf.inert).toBe(true)
    const html = viewer('/report.html', { thumbnail: true }).querySelector('iframe')!
    expect(html.getAttribute('sandbox')).toBe('')
  })
})
