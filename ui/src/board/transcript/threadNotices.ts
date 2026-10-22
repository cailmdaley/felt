export interface ThreadNotice {
  kind: 'thread-notice'
  id: string
  fiber: string
  verb: 'closed' | 'asked' | 'handed off' | 'rested'
  text: string
  at?: number
}

/** Daemon Threads.deliver_results → messaging.Labeled, including hook batches. */
export function threadNotices(source: string, at?: number): ThreadNotice[] {
  const notices: ThreadNotice[] = []
  const pattern = /\[Shuttle message (thread-[a-f\d]{64}(?:-[a-f\d]{16})?)(?:[^\]\n]*)\]\r?\nthread ([^\s<>]+) (closed|asked|handed off|rested):[ \t]*([\s\S]*?)(?=\r?\n\[Shuttle message |\s*<\/system-reminder\s*>|$)/g
  for (const match of source.matchAll(pattern)) notices.push({
    kind: 'thread-notice', id: match[1], fiber: match[2], verb: match[3] as ThreadNotice['verb'], text: match[4].trim(),
    ...(at === undefined ? {} : { at }),
  })
  return notices
}
