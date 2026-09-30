import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "felt-pi-extension-"));
const fakeFelt = path.join(root, "felt");
const fakeShuttle = path.join(root, "shuttle");
const feltCalls = path.join(root, "felt-calls.jsonl");
const shuttleCalls = path.join(root, "shuttle-calls.jsonl");

function fakeBinaryScript(callsFile) {
	return `#!${process.execPath}
const fs = require("node:fs");
const callsFile = ${JSON.stringify(callsFile)};
const args = process.argv.slice(2);
if (args[0] === "session") {
  fs.appendFileSync(callsFile, JSON.stringify({args, payload: null}) + "\\n");
  process.stdout.write("SESSION_CONTEXT");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  let payload = {};
  try { payload = JSON.parse(input); } catch {}
  fs.appendFileSync(callsFile, JSON.stringify({args, payload}) + "\\n");
  if (payload.hook_event_name === "UserPromptSubmit") {
    process.stdout.write(JSON.stringify({hookSpecificOutput: {additionalContext: "PASSIVE_CONTEXT"}}));
  }
});
`;
}

fs.writeFileSync(fakeFelt, fakeBinaryScript(feltCalls), { mode: 0o700 });
fs.writeFileSync(fakeShuttle, fakeBinaryScript(shuttleCalls), { mode: 0o700 });
process.env.HOME = root;
process.env.FELT_BIN = fakeFelt;
process.env.SHUTTLE_BIN = fakeShuttle;
process.env.FELT_CALLS = feltCalls;
process.env.SHUTTLE_CALLS = shuttleCalls;

function readCalls(file) {
	try {
		return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function waitFor(predicate, message) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

const hasHook = (file, verb, eventName) => readCalls(file).some(({ args, payload }) =>
	args.join(" ") === `hook ${verb}` && (!eventName || payload?.hook_event_name === eventName));

const { default: install } = await import("./index.ts");
const handlers = new Map();
const sent = [];
let acknowledgeNativeMessages = true;
const pi = {
	on(name, handler) { handlers.set(name, handler); },
	sendUserMessage(message, options) {
		sent.push({ message, options });
		if (acknowledgeNativeMessages) queueMicrotask(() => handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: message }] } }));
	},
};
install(pi);

let sessionId = "pi-extension-test-session-a";
const ctx = {
	cwd: root,
	hasUI: false,
	ui: { notify() {} },
	sessionManager: {
		getSessionId: () => sessionId,
		getSessionFile: () => path.join(root, "session.jsonl"),
	},
};
await handlers.get("session_start")({}, ctx);
await waitFor(() => hasHook(shuttleCalls, "event", "SessionStart"), "SessionStart should reach shuttle");
const sessionStartHook = readCalls(shuttleCalls).find(({ args, payload }) => args.join(" ") === "hook event" && payload?.hook_event_name === "SessionStart");
assert.equal(typeof sessionStartHook.payload.native_socket, "string", "Shuttle receives the native messaging endpoint");
assert.equal(readCalls(feltCalls).some(({ args }) => args[0] === "hook" && args[1] === "event"), false);
function socketFor(id) {
	const digest = crypto.createHash("sha256").update(id).digest("hex").slice(0, 24);
	return path.join(os.tmpdir(), `felt-pi-${process.pid}-${digest}`, "worker.sock");
}
let socketPath = socketFor(sessionId);
assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

function request(payload, extra = "") {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let output = "";
		socket.setEncoding("utf8");
		// Go's encoder escapes HTML characters; exercise the actual wire expansion.
		socket.on("connect", () => socket.write(JSON.stringify(payload).replaceAll("<", "\\u003c") + "\n" + extra));
		socket.on("data", (chunk) => output += chunk);
		socket.on("end", () => resolve(JSON.parse(output.trim())));
		socket.on("error", reject);
	});
}

let reply = await request({ type: "msg", requestId: "idle", sessionId, message: "idle message" });
assert.deepEqual(reply, { ok: true, delivery: "follow_up", requestId: "idle", sessionId });
assert.deepEqual(sent.at(-1), { message: "idle message", options: { deliverAs: "followUp" } });

acknowledgeNativeMessages = false;
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 14_000 ? 100 : delay, ...args);
try {
	reply = await request({ type: "msg", requestId: "unconfirmed", sessionId, message: "Pi may have refused this" });
} finally {
	globalThis.setTimeout = nativeSetTimeout;
}
assert.equal(reply.ok, undefined, "a void API return without matching message_start is ambiguous");
assert.match(reply.error, /did not confirm/);
acknowledgeNativeMessages = true;

await handlers.get("agent_start")({}, ctx);
reply = await request({ type: "msg", requestId: "active", sessionId, message: "active message" });
assert.deepEqual(reply, { ok: true, delivery: "steer", requestId: "active", sessionId });
assert.deepEqual(sent.at(-1), { message: "active message", options: { deliverAs: "steer" } });

reply = await request({ type: "msg", requestId: "wrong-session", sessionId: "other", message: "must reject" });
assert.equal(reply.ok, false);
const beforeDuplicate = sent.length;
reply = await request({ type: "msg", requestId: "one-connection", sessionId, message: "first" }, JSON.stringify({ type: "msg", requestId: "second", sessionId, message: "second" }) + "\n");
assert.equal(reply.ok, true);
assert.equal(sent.length, beforeDuplicate + 1);

const large = "x".repeat(70_000);
reply = await request({ type: "msg", requestId: "large", sessionId, message: large });
assert.equal(reply.ok, true);

reply = await request({ type: "msg", requestId: "escaped-limit", sessionId, message: "<".repeat(64 << 10) });
assert.equal(reply.ok, true, "a legal message must fit after JSON escaping");

const beforeContext = sent.length;
const context = await handlers.get("before_agent_start")({ prompt: "prompt" }, ctx);
assert.match(context.message.content, /SESSION_CONTEXT/);
assert.match(context.message.content, /PASSIVE_CONTEXT/);
assert.equal(sent.length, beforeContext, "passive context must not invoke native steering or a new turn");
await waitFor(() => hasHook(shuttleCalls, "event", "UserPromptSubmit"), "mailbox offers should reach shuttle");
assert.equal(readCalls(feltCalls).some(({ args }) => args.length === 1 && args[0] === "session"), true, "session context should reach felt");

await handlers.get("tool_call")({ toolName: "Read", input: { path: "notes.md" } }, ctx);
await waitFor(() => hasHook(shuttleCalls, "event", "PreToolUse"), "tool events should reach shuttle");
await handlers.get("tool_result")({ toolName: "Bash", input: { command: "git commit -m test" } }, ctx);
await waitFor(() => hasHook(shuttleCalls, "event", "PostToolUse") && hasHook(shuttleCalls, "commit"), "Bash result and commit should reach shuttle");
const commitHook = readCalls(shuttleCalls).find(({ args }) => args.join(" ") === "hook commit");
assert.equal(commitHook.payload.tool_input.command, "git commit -m test");
await handlers.get("tool_result")({ toolName: "Edit", input: { path: path.join(root, "fiber.md") } }, ctx);
await waitFor(() => hasHook(shuttleCalls, "event", "PostToolUse") && hasHook(feltCalls, "posttool"), "edit result should reach shuttle and fiber stamp should reach felt");
assert.equal(readCalls(feltCalls).some(({ args }) => args[0] === "hook" && args[1] === "event"), false);
assert.equal(readCalls(feltCalls).some(({ args }) => args[0] === "hook" && args[1] === "commit"), false);
assert.equal(readCalls(shuttleCalls).some(({ args }) => args[0] === "hook" && ["session", "posttool"].includes(args[1])), false);

// A successful switch replaces the endpoint and identity. A stale sender
// cannot inject its old-session message into the new conversation.
const oldSocket = socketPath;
const oldSession = sessionId;
const inFlight = net.createConnection(oldSocket);
await new Promise((resolve, reject) => {
  inFlight.once("connect", resolve);
  inFlight.once("error", reject);
});
let closingResponse = "";
inFlight.setEncoding("utf8");
inFlight.on("data", (chunk) => closingResponse += chunk);
const closed = new Promise((resolve) => inFlight.once("end", resolve));
const beforeSwitch = sent.length;
sessionId = "pi-extension-second-session";
const switching = handlers.get("session_start")({}, ctx);
inFlight.end(JSON.stringify({type: "msg", requestId: "during-switch", sessionId: oldSession, message: "must not reach replacement"}) + "\n");
await closed;
assert.equal(JSON.parse(closingResponse).ok, false);
assert.equal(sent.length, beforeSwitch, "an in-flight old-session connection must not message its replacement");
await switching;
socketPath = socketFor(sessionId);
assert.equal(fs.existsSync(oldSocket), false);
assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
reply = await request({ type: "msg", requestId: "stale", sessionId: oldSession, message: "wrong conversation" });
assert.equal(reply.ok, false);
reply = await request({ type: "msg", requestId: "new", sessionId, message: "new conversation" });
assert.equal(reply.ok, true);
assert.equal(reply.delivery, "follow_up", "new idle session must not inherit the old session's streaming state");

await handlers.get("agent_start")({}, ctx);
await handlers.get("agent_end")({}, ctx);
await waitFor(() => hasHook(shuttleCalls, "event", "Stop"), "Stop should reach shuttle");
reply = await request({ type: "msg", requestId: "after-end", sessionId, message: "another turn" });
assert.equal(reply.delivery, "follow_up");
await handlers.get("session_shutdown")({}, ctx);
assert.equal(fs.existsSync(socketPath), false);
assert.equal(hasHook(shuttleCalls, "event", "SessionEnd"), true);

const fixedShuttleExists = ["/opt/homebrew/bin/shuttle", "/usr/local/bin/shuttle"].some((candidate) => {
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
});
if (fixedShuttleExists) {
	console.log("note: Shuttle absence is unreachable because a fixed system probe has shuttle; its Pi absence case is skipped");
} else {
	const absentHome = path.join(root, "home-without-shuttle");
	const emptyPath = path.join(root, "empty-path");
	const absentShuttleCalls = path.join(root, "absent-shuttle-calls.jsonl");
	fs.mkdirSync(absentHome, { recursive: true });
	fs.mkdirSync(emptyPath, { recursive: true });
	process.env.HOME = absentHome;
	process.env.PATH = emptyPath;
	process.env.FELT_BIN = fakeFelt;
	process.env.SHUTTLE_BIN = "";
	process.env.FELT_CALLS = feltCalls;
	process.env.SHUTTLE_CALLS = absentShuttleCalls;

	const { default: installWithoutShuttle } = await import(`./index.ts?shuttle-absent-${Date.now()}`);
	const absentHandlers = new Map();
	installWithoutShuttle({ on(name, handler) { absentHandlers.set(name, handler); } });
	const absentCtx = {
		cwd: absentHome,
		hasUI: false,
		ui: { notify() {} },
		sessionManager: {
			getSessionId: () => "pi-extension-without-shuttle",
			getSessionFile: () => path.join(absentHome, "session.jsonl"),
		},
	};
	await absentHandlers.get("session_start")({}, absentCtx);
	const absentContext = await absentHandlers.get("before_agent_start")({ prompt: "prompt without shuttle" }, absentCtx);
	assert.match(absentContext.message.content, /SESSION_CONTEXT/);
	assert.doesNotMatch(absentContext.message.content, /PASSIVE_CONTEXT/);
	const callsBeforeAbsentHooks = readCalls(feltCalls).length;
	await absentHandlers.get("tool_result")({ toolName: "Bash", input: { command: "git commit -m skipped" } }, absentCtx);
	await absentHandlers.get("tool_result")({ toolName: "Edit", input: { path: "fiber.md" } }, absentCtx);
	await waitFor(() => readCalls(feltCalls).slice(callsBeforeAbsentHooks).some(({ args }) => args.join(" ") === "hook posttool"), "felt posttool should still run without shuttle");
	const absentFeltCalls = readCalls(feltCalls).slice(callsBeforeAbsentHooks);
	assert.equal(absentFeltCalls.some(({ args }) => args.join(" ") === "hook event" || args.join(" ") === "hook commit"), false);
	await absentHandlers.get("session_shutdown")({}, absentCtx);
	assert.equal(fs.existsSync(absentShuttleCalls), false, "missing shuttle must silently skip its hooks");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("pi extension tests passed");
