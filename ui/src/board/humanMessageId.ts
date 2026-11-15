/** The board owns typed-input ids; forwarding and retries retain this value. */
export function humanMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `human-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * What the owner said when it typed nothing because this id was sent before:
 * null when that first send was delivered, else a sentence for the human. The
 * first try may never have arrived (its daemon died between recording and
 * typing it), so the line is left with them, and sending it again goes out as
 * a new message.
 */
export function repeatNotice(answer: { duplicate?: boolean; disposition?: string } | null | undefined): string | null {
  if (!answer?.duplicate || answer.disposition === 'delivered') return null
  return 'This line may not have arrived: its first send was interrupted. Check the conversation; sending it again sends it as a new message.'
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
