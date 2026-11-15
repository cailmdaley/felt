/** The board owns typed-input ids; forwarding and retries retain this value. */
export function humanMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `human-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * One id per composed message. A send that failed retries under the same id,
 * so the owner transports the line at most once (and again only when its first
 * try definitely did not arrive); a different message, or the same text after
 * a send went through, gets a new id.
 */
export class HumanMessageIds {
  private composed: { key: string; id: string } | null = null

  /** The id for the message `key` names (its target and content). */
  for(key: string): string {
    if (this.composed?.key !== key) this.composed = { key, id: humanMessageId() }
    return this.composed.id
  }

  /** The message was sent: the next one gets a new id. */
  sent(): void {
    this.composed = null
  }
}
