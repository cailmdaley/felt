/** The board owns typed-input ids; forwarding and retries retain this value. */
export function humanMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `human-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
