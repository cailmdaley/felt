// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFileViewer, disposeFileViewer, suspendFileViewer, resumeFileViewer } from '../FileViewerPanel.js'
import { DocumentHost } from './DocumentHost.js'
import type { WorkspaceDocument } from './documents.js'

vi.mock('../LiveFileRefresh.js', () => ({
  watchLiveFile: (_url: string, content: (html: string) => void) => {
    queueMicrotask(() => content('<!doctype html><html><body>Listening room</body></html>'))
    return Object.assign(() => {}, { suspend: () => {}, resume: async () => {}, loadOnce: async () => {} })
  },
  refreshLiveFile: async () => {},
}))

let host: DocumentHost | undefined
const viewers: HTMLElement[] = []
const playing = new WeakSet<HTMLMediaElement>()
const doc = (path: string, kind: 'audio' | 'video' | 'other'): WorkspaceDocument => ({
  key: `host-a:${path}`, owner: 'host-a', path, kind, name: path.slice(1),
  provenance: [{ kind: 'embed', title: 'A small listening room' }, { kind: 'sent', time: 1, worker: 'sol' }],
})
beforeEach(() => {
  document.body.replaceChildren()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { playing.delete(this) })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playing.add(this)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) { return !playing.has(this) })
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
  it('classifies all audio/video suffixes without duplicating frame metadata in the page', () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus']) {
      const el = viewer(`/song.${ext}`)
      expect(el.querySelector('h1,.kbn-media-kind,.kbn-media-provenance')).toBeNull()
      expect(el.querySelector('audio')?.getAttribute('aria-label')).toBe(`song.${ext}`)
      expect(el.querySelector('audio')?.controls).toBe(true)
    }
    for (const ext of ['mp4', 'm4v', 'mov', 'webm']) {
      const el = viewer(`/film.${ext}`)
      expect(el.querySelector('h1,.kbn-media-kind,.kbn-media-provenance')).toBeNull()
      const video = el.querySelector('video')!
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

  it('also pauses players inside HTML reports and includes them in exclusive playback', async () => {
    const report = viewer('/listening-room.html')
    const iframe = report.querySelector('iframe')!
    await vi.waitFor(() => expect(iframe.srcdoc).toContain('Listening room'))
    const embedded = document.createElement('audio')
    iframe.contentDocument!.body.append(embedded)
    iframe.dispatchEvent(new Event('load'))
    const native = viewer('/song.mp3').querySelector('audio')!
    await embedded.play(); expect(embedded.paused).toBe(false)
    await native.play(); expect(embedded.paused).toBe(true)
    await embedded.play(); expect(native.paused).toBe(true)
    embedded.currentTime = .3
    suspendFileViewer(report); expect(embedded.paused).toBe(true)
    resumeFileViewer(report)
    expect(embedded.paused).toBe(true); expect(embedded.currentTime).toBe(.3)
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
    const updated = { ...audioDoc, provenance: [...audioDoc.provenance, { kind: 'sent' as const, time: 2, worker: 'sol' }] }
    host.setChannel([updated, videoDoc], updated.key)
    expect(host.get(updated.key)!.viewer!.querySelector('audio')).toBe(audio)
    expect(host.get(updated.key)!.viewer!.querySelector('.kbn-media-title,.kbn-media-provenance')).toBeNull()
  })

  it('activates a refreshed media element when selection precedes its metadata load', async () => {
    const track = document.createElement('div'); document.body.append(track)
    host = new DocumentHost(track, { shuttleBase: '', buildProse: () => document.createElement('div'), onSelect: () => {} })
    const audioDoc = doc('/song.mp3', 'audio'), videoDoc = doc('/film.mp4', 'video')
    host.setChannel([audioDoc, videoDoc], audioDoc.key)
    host.refresh(videoDoc.key)
    const replacement = host.get(videoDoc.key)!.content.querySelectorAll('video')[1]
    host.select(videoDoc.key)
    replacement.dispatchEvent(new Event('loadedmetadata'))
    await Promise.resolve()
    expect(host.get(videoDoc.key)!.viewer!.querySelector('video')).toBe(replacement)
    await replacement.play()
    expect(replacement.paused).toBe(false)
  })

  it('leaves native PDF content and its accessible name without an in-page metadata block', () => {
    const el = viewer('/scan.pdf')
    expect(el.querySelector('iframe')?.title).toBe('scan.pdf')
    expect(el.querySelector('h1,h3,.kbn-media-title,.kbn-media-provenance')).toBeNull()
    expect(el.querySelector('iframe')?.src).toContain('/file?')
  })

  it('draws unsupported documents with file-info size and a download', async () => {
    const el = viewer('/archive.zip')
    await vi.waitFor(() => expect(el.textContent).toContain('2,048 bytes'))
    expect(el.querySelector('iframe,h1,h3,.kbn-media-provenance')).toBeNull()
    expect(el.textContent).not.toContain('archive.zip')
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
