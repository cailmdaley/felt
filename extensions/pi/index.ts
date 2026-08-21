/**
 * Felt extension for pi — the pi adapter over the same binary hooks the
 * Claude Code/Codex plugin drives (claude-plugin/hooks/).
 *
 * Division of labor mirrors the shell-hook plugin: the `felt` binary owns all
 * logic (`felt hook event|commit|posttool`, `felt session`); this extension is
 * event plumbing plus the one piece that cannot be delegated — the activation
 * gate, because pi activates skills by *reading* SKILL.md rather than calling
 * a Skill tool, so the deny decision belongs where the read is visible.
 *
 * Graceful degradation: a missing or old felt binary loses the context
 * injection and the ledger entries, never the session. Every spawned hook is
 * fire-and-forget with errors swallowed — the contract the shell shims keep
 * (print nothing, exit 0) holds here as "never fail a tool call".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// felt binary resolution — mirrors claude-plugin/hooks/felt-bin.sh
// ---------------------------------------------------------------------------

const feltCandidates = (): string[] => [
	process.env.FELT_BIN,
	path.join(os.homedir(), ".local", "bin", "felt"),
	"/opt/homebrew/bin/felt",
	"/usr/local/bin/felt",
].filter((c): c is string => !!c);

let feltBin: string | null | undefined;

function resolveFelt(): string | null {
	if (feltBin !== undefined) return feltBin;
	feltBin = feltCandidates().find((c) => {
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}) ?? null;
	if (!feltBin) {
		// PATH probe last: command -v semantics without spawning a shell.
		for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
			const candidate = path.join(dir, "felt");
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				feltBin = candidate;
				break;
			} catch {
				/* keep looking */
			}
		}
	}
	return feltBin;
}

/** Fire-and-forget hook spawn. The binary's contract is print-nothing/
 * exit-0-on-every-path; ours is never-fail-the-tool-call. Generous timeout:
 * on cluster stores (Lustre home, thousands of fibers) even one-line hook
 * work can sit in I/O wait well past a desktop's notion of slow — nibi's
 * measured ~6s warm, worse cold — and a killed hook is a lost activity
 * line, not a recovered failure. */
function runHook(args: string[], payload: unknown): void {
	const bin = resolveFelt();
	if (!bin) return;
	try {
		const child = execFile(bin, ["hook", ...args], { timeout: 30_000 }, () => {});
		child.stdin?.end(JSON.stringify(payload));
		child.on("error", () => {});
	} catch {
		/* a tracking hook must never surface */
	}
}

/** Awaited variant for the one call whose output we need (`felt session`).
 * The bound must clear a SLOW STORE, not a fast one: session context scans
 * every tracked fiber, and on a Lustre-backed 5k-fiber loom that is seconds
 * of pure I/O wait (measured 6.5s warm on nibi against 0.7s on a local SSD,
 * worse cold). A timeout here does not fail loudly — it silently returns ""
 * and the session starts with no context — so the number has to be safe by
 * construction rather than tuned to this host. */
function runSession(bin: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(bin, ["session"], { timeout: 60_000, maxBuffer: 4 << 20 }, (err, stdout) => {
			resolve(err ? "" : stdout.toString());
		});
	});
}

// ---------------------------------------------------------------------------
// Activation gate state
// ---------------------------------------------------------------------------

/** Suffix that identifies the felt skill's entry file wherever the package
 * lands (~/.pi/agent/git/…, ~/.pi/agent/npm/…, or a local checkout). */
const feltSkillSuffix = ["skills", "felt", "SKILL.md"].join(path.sep);

function flagPath(sessionId: string): string {
	return path.join(os.tmpdir(), `felt-reminded-pi-${sessionId}`);
}

function gateOpen(sessionId: string): boolean {
	return fs.existsSync(flagPath(sessionId));
}

function openGate(sessionId: string): void {
	try {
		fs.writeFileSync(flagPath(sessionId), "");
	} catch {
		/* an unwritable flag just means the gate stays loud */
	}
}

const denyReason =
	"Activate the felt skill first. You are in a felt-enabled project but haven't activated " +
	"the felt skill yet. Read the felt SKILL.md (its path is in your available skills) or run " +
	"/skill:felt before proceeding with any other tools. The skill body carries the philosophy, " +
	"CLI cheatsheet, and references that shape how to work — reading the session-start context " +
	"is not the same as having the skill loaded.";

export default function feltExtension(pi: ExtensionAPI) {
	let injectedSessionId: string | null = null;
	let warnedBinaryMissing = false;

	function isFeltProject(cwd: string): boolean {
		return fs.existsSync(path.join(cwd, ".felt"));
	}

	function sessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
		try {
			return ctx.sessionManager.getSessionId() || "anonymous";
		} catch {
			return "anonymous";
		}
	}

	function emit(event: string, extra: Record<string, unknown>, ctx: any): void {
		runHook(["event"], {
			hook_event_name: event,
			session_id: sessionId(ctx),
			cwd: ctx.cwd,
			transcript_path: safeSessionFile(ctx),
			...extra,
		});
	}

	function safeSessionFile(ctx: any): string {
		try {
			return ctx.sessionManager.getSessionFile() ?? "";
		} catch {
			return "";
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Fresh session identity resets both one-shot states; the flag file from
		// a previous session id simply ages out of tmpdir.
		injectedSessionId = null;
		if (!resolveFelt()) {
			if (!warnedBinaryMissing && ctx.hasUI) {
				warnedBinaryMissing = true;
				ctx.ui.notify(
					"felt extension: `felt` binary not found — session context and activity stream disabled",
					"warning",
				);
			}
			return;
		}
		emit("SessionStart", {}, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const sid = sessionId(ctx);
		emit("UserPromptSubmit", { prompt: event.prompt }, ctx);

		// Session context reaches the model once per session, as the first
		// prompt lands — pi has no SessionStart additionalContext envelope, and
		// a before_agent_start message is the persistent equivalent.
		if (injectedSessionId !== sid) {
			const bin = resolveFelt();
			if (bin) {
				const text = await runSession(bin);
				if (text.trim()) {
					injectedSessionId = sid;
					return {
						message: { customType: "felt-context", content: text, display: true },
					};
				}
			}
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		emit("PreToolUse", { tool_name: event.toolName, tool_input: event.input }, ctx);

		if (!isFeltProject(ctx.cwd)) return undefined;
		const sid = sessionId(ctx);

		// Reading is how pi activates skills — reads are always allowed, and a
		// read of the felt SKILL.md is the activation itself.
		if (event.toolName === "read") {
			const p = String((event.input as any)?.path ?? "");
			if (p.endsWith(feltSkillSuffix) || p === "SKILL.md") openGate(sid);
			return undefined;
		}
		if (gateOpen(sid)) return undefined;
		return { block: true, reason: denyReason };
	});

	// /skill:felt expands in the input pipeline, before any tool call — honor
	// it as activation the same way the gate honors Claude's Skill tool.
	pi.on("input", async (event, ctx) => {
		if (event.text.trimStart().startsWith("/skill:felt")) {
			openGate(sessionId(ctx));
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const input = event.input as any;
		const sid = sessionId(ctx);

		// Every tool's return closes the interval its PreToolUse opened — the
		// activity stream pairs pre/post per session to fill the minutes a long
		// call actually ran, and a harness that only reports half the pair draws
		// holes where work happened. Bash additionally feeds the commit ledger;
		// direct fiber edits additionally get their recency stamp.
		emit("PostToolUse", { tool_name: event.toolName, tool_input: input ?? {} }, ctx);

		if (event.toolName === "bash") {
			runHook(
				["commit"],
				{
					hook_event_name: "PostToolUse",
					session_id: sid,
					cwd: ctx.cwd,
					tool_name: "Bash",
					tool_input: { command: String(input?.command ?? "") },
				},
			);
		}

		if (["edit", "write", "multiedit"].includes(event.toolName.toLowerCase())) {
			runHook(
				["posttool"],
				{
					tool_name: event.toolName,
					cwd: ctx.cwd,
					tool_input: { file_path: input?.path ?? input?.file_path ?? "" },
				},
			);
		}

		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		emit("Stop", {}, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		emit("SessionEnd", {}, ctx);
	});
}
