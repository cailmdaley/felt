function responseError(body: unknown, status: number): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const raw = body as Record<string, unknown>
    for (const key of ['detail', 'error', 'message', 'reason']) {
      if (typeof raw[key] === 'string' && raw[key]) return raw[key] as string
    }
  }
  return `Meeting request failed (${status}).`
}

export async function stopMeeting(
  shuttleBase: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${shuttleBase}/api/v1/meeting/stop`, { method: 'POST' })
  if (response.status === 404) return
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(responseError(payload, response.status))
}
