import type { Host, Project } from './projectModel'

export const MEETING_PROJECT_KEY = 'shuttle.capture.meeting.project'
export interface MeetingProject { hostId: string; projectId: string }

/** Only a host/project pair still offered by the picker may be restored. */
export function rememberedMeetingProject(hosts: Host[], projects: Project[]): MeetingProject | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(MEETING_PROJECT_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return undefined
    const { hostId, projectId } = saved as Partial<MeetingProject>
    if (hosts.some((host) => host.id === hostId) && projects.some((project) => project.id === projectId && project.originId === hostId)) {
      return { hostId: hostId!, projectId: projectId! }
    }
  } catch { /* Site data may be disabled or malformed. */ }
  return undefined
}

export function rememberMeetingProject(project: Project): void {
  try {
    localStorage.setItem(MEETING_PROJECT_KEY, JSON.stringify({ hostId: project.originId, projectId: project.id }))
  } catch { /* A meeting does not depend on persistent site data. */ }
}
