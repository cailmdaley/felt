/** The transcript lives on the recorder, independently of the card receiving speech. */
export interface VoiceTranscript {
  path: string
  launch: string
  recorder: string
}

export type OpenListeningFile = (path: string, title?: string, owner?: string) => void

/** Resolve the current capture at click time, then use the board's live file reader. */
export async function openVoiceTranscript(
  base: string,
  openFile: OpenListeningFile,
  recorder?: string | null,
): Promise<void> {
  const query = recorder ? `?${new URLSearchParams({ recorder })}` : ''
  const response = await fetch(`${base}/api/v1/voice/transcript${query}`, { cache: 'no-store' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `Could not open listening transcript (${response.status})`)
  const transcript = body as VoiceTranscript
  openFile(transcript.path, 'Listening transcript', transcript.recorder)
}
