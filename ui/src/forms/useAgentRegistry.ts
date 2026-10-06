import { useEffect, useState } from 'react'
import type { AgentEntry } from './agents'

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
