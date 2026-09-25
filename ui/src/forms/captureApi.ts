import type { ExecutionSurface } from './executionSurface'

export type CaptureMeetingMode = 'call' | 'room'

export interface CaptureRequestInput {
  prompt: string
  projectDir: string
  origin: string
  agent: string
  effort?: string
  chrome?: boolean
  surface?: ExecutionSurface
  meetingMode?: CaptureMeetingMode | null
}

export interface CaptureResponseData {
  spawned?: boolean
  tmux_session?: string
  reason?: string
  error?: string
  message?: string
  surface?: ExecutionSurface
  recording?: boolean
  meeting?: unknown
}

export type CaptureOutcome =
  | { kind: 'spawned'; tmuxSession: string; surface?: ExecutionSurface }
  | { kind: 'meeting-recording'; host: string; error?: string }
  | { kind: 'error'; message: string }

export function captureRequestBody(input: CaptureRequestInput): Record<string, unknown> {
  const prompt = input.prompt.trim()
  return {
    ...(prompt || !input.meetingMode ? { prompt } : {}),
    project_dir: input.projectDir,
    origin: input.origin,
    agent: input.agent,
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.chrome ? { chrome: true } : {}),
    ...(input.meetingMode
      ? { surface: 'cli', meeting: { mode: input.meetingMode } }
      : input.surface
        ? { surface: input.surface }
        : {}),
  }
}

export function captureOutcome(
  response: Pick<Response, 'ok' | 'status'>,
  data: CaptureResponseData,
  options: { projectDir: string; meetingMode?: CaptureMeetingMode | null; host: string },
): CaptureOutcome {
  const spawned = response.ok && data.spawned === true
  const hasMeetingRow = !!data.meeting && typeof data.meeting === 'object' && !Array.isArray(data.meeting)
  const recording = data.recording === true || (response.ok && hasMeetingRow)

  if (options.meetingMode && recording) {
    const explicitError = data.error || data.reason
    if (spawned && !explicitError) return { kind: 'meeting-recording', host: options.host }
    return {
      kind: 'meeting-recording',
      host: options.host,
      error: `Recording locally; the scribe didn't start: ${captureError(response.status, data, options.projectDir)}`,
    }
  }

  if (!spawned) return { kind: 'error', message: captureError(response.status, data, options.projectDir) }
  if (options.meetingMode) {
    return { kind: 'error', message: 'The daemon did not confirm that meeting recording started.' }
  }
  return {
    kind: 'spawned',
    tmuxSession: data.tmux_session ?? '',
    surface: data.surface,
  }
}

function captureError(status: number, data: CaptureResponseData, projectDir: string): string {
  if (data.reason === 'app_launch_failed') {
    return 'ChatGPT could not start this Codex run. Check the app connection and try again.'
  }
  if (data.reason === 'project_dir_missing') {
    return `Project directory not found on the daemon: ${projectDir}`
  }
  if (data.message) return data.message
  if (data.error) return data.error
  if (status === 409) return 'A meeting is already starting or running.'
  if (status === 503) return 'Hark is unavailable on this daemon.'
  if (data.reason) return data.reason
  return `Capture failed (${status})`
}
