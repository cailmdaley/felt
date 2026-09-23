/**
 * Felt extension for pi — the pi adapter over the same binary hooks the
 * Claude Code/Codex plugin drives (claude-plugin/hooks/).
 *
 * The `felt` binary owns routing, mailboxes, and records. This extension connects
 * Pi lifecycle events and native messaging to that shared surface. It also
 * enforces skill activation where Pi's reads of SKILL.md are visible.
 *
 * Graceful degradation: a missing or old felt binary loses the context
 * injection and the ledger entries, never the session. Activity hooks are
 * fire-and-forget; context hooks are awaited with a bounded timeout. Native
 * messaging reports acceptance or refusal without failing the receiving session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
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

function runHookOutput(args: string[], payload: unknown): Promise<string> {
	const bin = resolveFelt();
	if (!bin) return Promise.resolve("");
	return new Promise((resolve) => {
		let settled = false;
		const finish = (output: string) => {
			if (settled) return;
			settled = true;
			resolve(output);
		};
		try {
			const child = execFile(bin, ["hook", ...args], { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout) => {
				finish(err ? "" : stdout.toString());
			});
			child.stdin?.end(JSON.stringify(payload));
			child.on("error", () => finish(""));
		} catch {
			finish("");
		}
	});
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
	let nativeServer: net.Server | null = null;
	let nativeSocket: string | null = null;
	let nativeAccepting = false;
	let nativeSessionId: string | null = null;
	let nativeCwd: string | null = null;
	let nativeTranscript: string | null = null;
	let streaming = false;
	const nativeFrameLimit = 512 << 10;
	const pendingNativeMessages = new Map<string, { sessionId: string; resolve: (confirmed: boolean) => void }>();
	const nativeMessageAckTimeoutMs = 14_000;

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
			harness: "pi",
			session_id: sessionId(ctx),
			cwd: ctx.cwd,
			transcript_path: safeSessionFile(ctx),
			native_socket: nativeSocket,
			native_pid: process.pid,
			...extra,
		});
	}

	function nativePath(sid: string): string {
		const digest = createHash("sha256").update(sid).digest("hex").slice(0, 24);
		return path.join(os.tmpdir(), `felt-pi-${process.pid}-${digest}`, "worker.sock");
	}

	function writeNativeReply(socket: net.Socket, reply: Record<string, unknown>): void {
		try {
			socket.end(`${JSON.stringify(reply)}\n`);
		} catch {
			/* the sender may have gone away */
		}
	}

	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		const content = event.message.content;
		const text = typeof content === "string"
			? content
			: content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
		const pending = pendingNativeMessages.get(text);
		if (!pending || pending.sessionId !== nativeSessionId || !nativeAccepting) return;
		pendingNativeMessages.delete(text);
		pending.resolve(true);
	});

	async function startNative(ctx: any): Promise<void> {
		if (nativeServer) return;
		const sid = sessionId(ctx);
		if (sid === "anonymous") return;
		nativeSocket = nativePath(sid);
		nativeSessionId = sid;
		nativeCwd = ctx.cwd;
		nativeTranscript = safeSessionFile(ctx);
		try {
			const parent = path.dirname(nativeSocket);
			fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
			const parentStat = fs.lstatSync(parent);
			if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) || (parentStat.mode & 0o77) !== 0) throw new Error("native socket directory is not private");
			fs.rmSync(nativeSocket, { force: true });
		} catch {
			nativeSocket = null;
			nativeSessionId = null;
			nativeCwd = null;
			nativeTranscript = null;
			return;
		}
		const socketPath = nativeSocket;
		nativeServer = net.createServer((socket) => {
			let buffer = "";
			let handled = false;
			socket.setEncoding("utf8");
				socket.setTimeout(15_000, () => socket.destroy());
			socket.on("error", () => {});
			socket.on("data", async (chunk) => {
				if (handled) return;
				buffer += chunk;
				if (Buffer.byteLength(buffer) > nativeFrameLimit) {
					socket.destroy();
					return;
				}
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				handled = true;
				const line = buffer.slice(0, newline);
				let request: any;
				try {
					request = JSON.parse(line);
				} catch {
					writeNativeReply(socket, { ok: false, error: "malformed request" });
					return;
				}
				const requestId = typeof request?.requestId === "string" ? request.requestId : "";
				const replyBase = { requestId, sessionId: sid };
				if (!nativeAccepting || nativeSessionId !== sid) {
					writeNativeReply(socket, { ...replyBase, ok: false, error: "Pi receiver is closing or has switched sessions" });
					return;
				}
				if (request?.type !== "msg" || request.sessionId !== sid || !requestId || typeof request.message !== "string" || !request.message.trim() || request.message.includes("\0") || Buffer.byteLength(request.message) > (128 << 10)) {
					writeNativeReply(socket, { ...replyBase, ok: false, error: "invalid Pi message request" });
					return;
				}
				const delivery = streaming ? "steer" : "follow_up";
				let timer: NodeJS.Timeout;
				let resolveObserved: (confirmed: boolean) => void = () => {};
				const observed = new Promise<boolean>((resolve) => {
					resolveObserved = resolve;
					pendingNativeMessages.set(request.message, { sessionId: sid, resolve });
					timer = setTimeout(() => resolve(false), nativeMessageAckTimeoutMs);
				});
				try {
					// Pi's extension API catches rejected prompt promises internally and
					// returns void. Confirm only when Pi emits this exact user message.
					pi.sendUserMessage(request.message, { deliverAs: streaming ? "steer" : "followUp" });
				} catch (error) {
					if (pendingNativeMessages.get(request.message)?.resolve === resolveObserved) pendingNativeMessages.delete(request.message);
					clearTimeout(timer!);
					writeNativeReply(socket, { ...replyBase, ok: false, error: error instanceof Error ? error.message : String(error) });
					return;
				}
				if (await observed) {
					clearTimeout(timer!);
					writeNativeReply(socket, { ...replyBase, ok: true, delivery });
				} else {
					clearTimeout(timer!);
					if (pendingNativeMessages.get(request.message)?.resolve === resolveObserved) pendingNativeMessages.delete(request.message);
					// Missing lifecycle evidence is ambiguous, not a rejection: Pi may
					// have accepted the request but failed before starting its turn.
					writeNativeReply(socket, { ...replyBase, error: "Pi did not confirm this message starting" });
				}
			});
		});
		await new Promise<void>((resolve) => {
			nativeServer?.once("listening", () => resolve());
			nativeServer?.once("error", () => {
				nativeServer = null;
				nativeSocket = null;
				nativeSessionId = null;
				nativeCwd = null;
				nativeTranscript = null;
				resolve();
			});
			nativeServer?.listen(socketPath);
		});
		if (nativeServer) {
			try {
				fs.chmodSync(socketPath, 0o600);
				nativeAccepting = true;
			} catch {
				await new Promise<void>((resolve) => nativeServer?.close(() => resolve()));
				nativeServer = null;
				nativeSocket = null;
				nativeSessionId = null;
				nativeCwd = null;
				nativeTranscript = null;
			}
		}
	}

	async function stopNative(ctx: any): Promise<void> {
		nativeAccepting = false;
		for (const pending of pendingNativeMessages.values()) pending.resolve(false);
		pendingNativeMessages.clear();
		if (!nativeServer || !nativeSocket) {
			nativeServer = null;
			nativeSocket = null;
			nativeSessionId = null;
			nativeCwd = null;
			nativeTranscript = null;
			return;
		}
		const socketPath = nativeSocket;
		const sid = nativeSessionId;
		const cwd = nativeCwd ?? ctx.cwd;
		const transcript = nativeTranscript ?? safeSessionFile(ctx);
		await runHookOutput(["event"], {
			hook_event_name: "SessionEnd",
			harness: "pi",
			session_id: sid,
			cwd,
			transcript_path: transcript,
			native_socket: socketPath,
			native_pid: process.pid,
		});
		await new Promise<void>((resolve) => nativeServer?.close(() => resolve()));
		nativeServer = null;
		nativeSocket = null;
		nativeSessionId = null;
		nativeCwd = null;
		nativeTranscript = null;
		try {
			fs.rmSync(path.dirname(socketPath), { force: true, recursive: true });
		} catch {
			/* cleanup is best effort */
		}
	}

	async function offerMailbox(ctx: any, prompt: string): Promise<string> {
		const raw = await runHookOutput(["event"], {
			hook_event_name: "UserPromptSubmit",
			harness: "pi",
			session_id: sessionId(ctx),
			cwd: ctx.cwd,
			transcript_path: safeSessionFile(ctx),
			prompt,
			native_socket: nativeSocket,
			native_pid: process.pid,
		});
		try {
			const parsed = JSON.parse(raw);
			return parsed?.hookSpecificOutput?.additionalContext ?? "";
		} catch {
			return "";
		}
	}

	function safeSessionFile(ctx: any): string {
		try {
			return ctx.sessionManager.getSessionFile() ?? "";
		} catch {
			return "";
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// A switch may be cancelled before this event. Keeping the old endpoint
		// until this replacement event preserves it on cancellation; once this
		// event fires, close the old registration before opening the new one.
		await stopNative(ctx);
		streaming = false;
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
		await startNative(ctx);
		emit("SessionStart", {}, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const sid = sessionId(ctx);
		// Some Pi startup paths report an anonymous session before the first
		// prompt. Register lazily once the stable session identity is available.
		if (!nativeServer && sid !== "anonymous" && resolveFelt()) {
			await startNative(ctx);
			if (nativeServer) emit("SessionStart", {}, ctx);
		}
		const mailboxContext = await offerMailbox(ctx, event.prompt);

		// Session context reaches the model once per session, as the first
		// prompt lands — pi has no SessionStart additionalContext envelope, and
		// a before_agent_start message is the persistent equivalent.
		let sessionContext = "";
		if (injectedSessionId !== sid) {
			const bin = resolveFelt();
			if (bin) {
				const text = await runSession(bin);
				if (text.trim()) {
					injectedSessionId = sid;
					sessionContext = text;
				}
			}
		}
		const context = [sessionContext, mailboxContext].filter((text) => text.trim()).join("\n\n");
		if (context) return { message: { customType: "felt-context", content: context, display: true } };
		return undefined;
	});

	pi.on("agent_start", async () => {
		streaming = true;
	});

	pi.on("agent_end", async (_event, ctx) => {
		streaming = false;
		emit("Stop", {}, ctx);
	});

	pi.on("agent_settled", async () => {
		streaming = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		emit("PreToolUse", { tool_name: event.toolName, tool_input: event.input }, ctx);

		if (!isFeltProject(ctx.cwd)) return undefined;
		const sid = sessionId(ctx);

		// Reading is how pi activates skills — reads are always allowed, and a
		// read of the felt SKILL.md is the activation itself. Case-insensitive
		// like the tool_result branch: pi's names are lowercase today, by
		// convention rather than contract.
		if (event.toolName.toLowerCase() === "read") {
			const p = String((event.input as any)?.path ?? "");
			// The bare "SKILL.md" match is deliberate looseness: a relative read
			// of any SKILL.md (shuttle's included) means the model is already
			// working inside the skill tree, so the gate has done its job.
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

		if (event.toolName.toLowerCase() === "bash") {
			runHook(
				["commit"],
				{
					hook_event_name: "PostToolUse",
					session_id: sid,
					cwd: ctx.cwd,
					// Raw harness name; the binary matches tools
					// case-insensitively at its boundary.
					tool_name: event.toolName,
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

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopNative(ctx);
		try {
			fs.rmSync(flagPath(sessionId(ctx)), { force: true });
		} catch {
			/* tmpdir residue is the OS's problem, not the session's */
		}
	});
}
