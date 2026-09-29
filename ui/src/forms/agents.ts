import { useEffect, useState } from 'react'

/** One base agent of the daemon's `GET /api/v1/agents` registry, as the
 *  pickers read it. */
export interface AgentEntry {
  id: string
  cli?: string
  model?: string
  default: boolean
  /** Harness-native effort tokens this agent accepts; empty/absent = no effort axis. */
  effort_levels?: string[]
  /** Concrete token applied when the fiber omits an explicit effort. */
  default_effort?: string | null
  /** Whether the harness supports `--chrome` (claude only). */
  chrome_capable?: boolean
  /** Alias records resolve to base + axes; the pickers list base agents only. */
  alias_of?: string | null
}

interface GroupableAgent {
  id: string
  cli?: string
}

/** Keep registry order independent of the order presented in every picker. */
export function agentGroups<T extends GroupableAgent>(agents: readonly T[]): { label: string; agents: T[] }[] {
  const labels: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' }
  const groups = new Map<string, T[]>()
  for (const agent of agents) {
    const cli = agent.cli || agent.id.split('-')[0]
    const label = labels[cli] ?? (agent.cli || 'Other')
    const group = groups.get(label) ?? []
    group.push(agent)
    groups.set(label, group)
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([label, entries]) => ({
    label,
    agents: entries.sort((a, b) => a.id.localeCompare(b.id, 'en')),
  }))
}

/**
 * The registry's base agents, fetched once per form. `null` until a non-empty
 * list arrives — and for good when the daemon is unreachable or answers with
 * something else, so each form keeps whatever it shows in the meantime.
 */
export function useAgentRegistry(shuttleBase: string): AgentEntry[] | null {
  const [agents, setAgents] = useState<AgentEntry[] | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`${shuttleBase}/api/v1/agents`)
      .then((res) => (res.ok ? res.json() : null))
      .then((raw: AgentEntry[] | null) => {
        if (cancelled || !Array.isArray(raw)) return
        const list = raw.filter((a) => !a.alias_of)
        if (list.length) setAgents(list)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [shuttleBase])
  return agents
}

/**
 * The effort a picker shows and submits for `agent`: the chosen level when the
 * agent accepts it, else the agent's own default, else none (`''`).
 */
export function resolveEffort(agent: AgentEntry | undefined, effort: string): string {
  const levels = agent?.effort_levels ?? []
  if (levels.includes(effort)) return effort
  return agent?.default_effort && levels.includes(agent.default_effort) ? agent.default_effort : ''
}
