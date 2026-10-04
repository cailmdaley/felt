import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HANDOFF_ENTRY, handoffThresholds, nextHandoff, handoffMessage } from "../../claude-plugin/hooks/lib/handoff.mjs";

/** Independent of binaries, UI, and project store: every felt-enabled Pi session. */
export default function installHandoff(pi: ExtensionAPI) {
	const sent = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		sent.clear();
		// This policy is session-wide, not branch-sensitive. A tree rewind must
		// not repeat warnings already delivered on another branch of this session.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && [HANDOFF_ENTRY, "confer-handoff"].includes(entry.customType)) {
				sent.add((entry.data as any)?.level);
			}
		}
	});
	pi.on("turn_end", (event, ctx) => {
		try {
			const content = event.message?.content;
			const text = typeof content === "string" ? content : (content ?? [])
				.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
			if (/(?:^|\n)HANDOFF: [^\r\n]+\s*$/.test(text)) return;
			const usage = ctx.getContextUsage();
			const level = nextHandoff(usage, sent, handoffThresholds());
			if (!level) return;
			pi.sendUserMessage(handoffMessage(usage, level), { deliverAs: "steer" });
			sent.add(level);
			pi.appendEntry(HANDOFF_ENTRY, { level, tokens: usage?.tokens, contextWindow: usage?.contextWindow });
		} catch {
			// Bad configuration or unavailable usage must never break a turn.
		}
	});
}
