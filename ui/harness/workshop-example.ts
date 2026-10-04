import type { ActivityBucket, CommitRecord, SessionRecord, TemporalFetchers } from '../src/board/views/index.js'

/** Fictional workshop data for documentation screenshots, rendered by the real board. */
export function workshopExample(now: number) {
  const day = 86_400_000
  const minute = 60_000
  const host = 'workshop-laptop'
  const project = '/home/organizer/workshop'
  const iso = (offset: number) => new Date(now + offset).toISOString()
  const civil = (offset: number) => {
    const date = new Date(now + offset * day)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const origins = { [host]: { kind: 'local' as const, stale: false, lastPolledAt: iso(0) } }
  const settings = { kind: 'oneshot', host, project_dir: project, agent: 'claude-opus' }
  const tasks = [
    { slug: 'lunch-options', name: 'Compare lunch options', status: 'open', age: 4,
      outcome: 'Find two lunch options within a short walk, including a vegetarian choice.' },
    { slug: 'speaker-bios', name: 'Collect speaker bios', status: 'open', age: 3,
      outcome: 'List which speaker bios are missing so the organizer can request them.' },
    { slug: 'participant-guide', name: 'Prepare the workshop guide', status: 'active', age: 2,
      outcome: 'Use the chosen venue and draft programme to make a one-page participant guide. Flag missing details.' },
    { slug: 'venue-access', name: 'Check venue access', status: 'active', age: 5,
      outcome: 'Check the library room’s step-free route and arrival instructions.' },
    { slug: 'venue', name: 'Choose a workshop venue', status: 'closed', age: 12,
      outcome: 'Use the library meeting room: it seats 30 and is near the station.' },
    { slug: 'programme', name: 'Review the draft programme', status: 'closed', age: 7,
      outcome: 'The draft fits a half-day workshop. Speaker names and the final start time still need confirmation.' },
  ]
  const rows = tasks.map((task, index) => {
    const uid = `01KVBR1F9BWBVKF97473PV67K${index}`
    const id = `workshop/${task.slug}`
    const tmux = `${task.slug}-${uid}-shuttle`
    return {
      origin: host, felt_store: project,
      path: `.felt/workshop/${task.slug}/${task.slug}.md`, dir: `${project}/.felt/workshop/${task.slug}`,
      fiber: {
        id, uid, name: task.name, status: task.status, outcome: task.outcome,
        tags: ['workshop'], created_at: iso(-task.age * day), updated_at: iso(-minute),
        closed_at: task.status === 'closed' ? iso(-(task.slug === 'venue' ? 8 : 1) * day) : undefined,
        shuttle: settings,
      },
      ...(task.status === 'active' ? { runtime: {
        state: 'running', phase: 'working', tmux_session: tmux, last_activity_at: now - 4_000,
      } } : {}),
    }
  })
  const cycle = {
    origin: host, felt_store: project, path: '.felt/workshop/workshop.md', dir: `${project}/.felt/workshop`,
    fiber: { id: 'workshop', name: 'Plan a small workshop', status: 'active',
      outcome: 'A half-day workshop for 25 participants at the library meeting room.',
      tags: ['cycle'], start: civil(-14), due: civil(10), created_at: iso(-14 * day),
    },
  }
  const sessions: SessionRecord[] = rows.filter(row => row.fiber.status !== 'open').map((row, index) => ({
    at: now - [2, 5, 12, 7][index] * day,
    fiber: row.fiber.id, uid: row.fiber.uid, session: `workshop-session-${index}`,
    harness: 'claude-code', agent: 'claude-opus', host,
    tmux: `${row.fiber.id.split('/').pop()}-${row.fiber.uid}-shuttle`, kind: 'dispatch',
  }))
  const buckets: ActivityBucket[] = []
  for (const [index, session] of sessions.entries()) {
    const end = index < 2 ? now : now - (index === 2 ? 8 : 1) * day
    for (let at = session.at; at <= end; at += day) {
      for (let elapsed = 0; elapsed < 24; elapsed++) {
        buckets.push({ m: Math.floor((at + elapsed * minute) / minute) * minute,
          s: session.tmux, cwd: project, k: elapsed === 0 ? 'attention' : 'agent', n: 1, host })
      }
    }
  }
  const commits: CommitRecord[] = [
    { index: 2, age: 8, subject: 'Record the library meeting room decision' },
    { index: 3, age: 1, subject: 'Review the half-day programme and flag open details' },
  ].map(({ index, age, subject }) => ({
    at: now - age * day + 25 * minute, sha: String(index).repeat(40), subject, repo: project,
    files: 1, insertions: 8, deletions: 0, session: sessions[index].session,
    tmux: sessions[index].tmux, cwd: project, host,
  }))
  const temporal: TemporalFetchers = {
    activity: async (fromMs, toMs) => ({ host, from_ms: fromMs, to_ms: toMs,
      buckets: buckets.filter(bucket => bucket.m >= fromMs && bucket.m < toMs && bucket.m <= now), origins }),
    sessions: async sinceMs => ({ host, records: sessions.filter(record => record.at >= sinceMs), origins }),
    commits: async (fromMs, toMs) => ({ host,
      records: commits.filter(record => record.at >= fromMs && record.at < toMs), origins }),
  }
  const bodies: Record<string, string> = {
    'workshop/venue': 'Use the library meeting room: it seats 30 and is near the station.\n\nThe café seats 18, which is too small for 25 participants. The participant guide should use the library. Arrival and accessibility details still need checking.',
    'workshop/participant-guide': 'Prepare a one-page participant guide using [[workshop/venue]] and [[workshop/programme]].\n\n## Desired State\n\nThe guide describes the chosen venue and draft programme. Missing details are clearly marked for the organizer; no names, times, or access arrangements are invented.\n\n## Status\n\nThe venue and draft programme are available. Check venue access and flag the unconfirmed start time and speaker names.',
  }
  return {
    feed: { host, generated_at: iso(0), fibers: [...rows, cycle],
      origins: { [host]: { kind: 'local', stale: false, last_polled_at: iso(0), fiber_count: rows.length + 1 } } },
    temporal, sessions, bodies,
  }
}
