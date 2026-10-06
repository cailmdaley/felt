/** Limits for the document bodies loaded by the board workspace. */
export const LOAD_POLICY = {
  /** Maximum number of live document bodies across the board. */
  maxLive: 16,
  /** Maximum number of simultaneous body loads. */
  maxConcurrent: 4,
  /** The distance around the viewport within which a document is eligible to load. */
  ring: '300px',
  /** The deadline before a remote document load is considered stalled. */
  softTimeoutRemoteMs: 20_000,
} as const
