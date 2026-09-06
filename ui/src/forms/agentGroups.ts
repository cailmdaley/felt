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
