// Capture seeds effort from the selected agent's registry record.
export const CAPTURE_DEFAULT_AGENT = 'claude-opus'
export const CAPTURE_DEFAULT_EFFORT = 'xhigh'

export interface CaptureRequestInput {
  prompt: string
  projectDir: string
  origin: string
  agent: string
  effort?: string
  chrome?: boolean
}

export interface CaptureResponseData {
  spawned?: boolean
  tmux_session?: string
  reason?: string
  error?: string
  message?: string
}

export type CaptureOutcome =
  | { kind: 'spawned'; tmuxSession: string }
  | { kind: 'error'; message: string }

export function captureRequestBody(input: CaptureRequestInput): Record<string, unknown> {
  return {
    prompt: input.prompt.trim(),
    project_dir: input.projectDir,
    origin: input.origin,
    agent: input.agent,
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.chrome ? { chrome: true } : {}),
  }
}

export function captureOutcome(
  response: Pick<Response, 'ok' | 'status'>,
  data: CaptureResponseData,
  options: { projectDir: string },
): CaptureOutcome {
  if (response.ok && data.spawned === true) return { kind: 'spawned', tmuxSession: data.tmux_session ?? '' }
  return { kind: 'error', message: data.reason === 'project_dir_missing'
    ? `Project directory not found on the daemon: ${options.projectDir}`
    : data.message || data.error || data.reason || `Capture failed (${response.status})` }
}
