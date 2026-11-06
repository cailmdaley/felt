import {
  AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** Attach Pi's per-prompt admission disposition to this synchronous API call.
 * The extension facade hides both the prompt promise and its disposition.
 * sendUserMessage calls prompt synchronously, before its first await; restoring
 * the method immediately keeps other sessions and later calls untouched.
 */
export function sendWithAdmission(
  pi: ExtensionAPI,
  sessionId: string,
  text: string,
  deliverAs: "steer" | "followUp",
  admitted: (disposition: string) => void,
): void {
  const prompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = function (message, options) {
    if (
      this.sessionId !== sessionId ||
      message !== text ||
      options?.source !== "extension"
    ) {
      return prompt.call(this, message, options);
    }
    const result = prompt.call(this, message, {
      ...options,
      preflightResult: (disposition) => {
        options?.preflightResult?.(disposition);
        admitted(disposition);
      },
    });
    void result.catch(() => admitted("failed"));
    return result;
  };
  try {
    pi.sendUserMessage(text, { deliverAs });
  } finally {
    AgentSession.prototype.prompt = prompt;
  }
}
