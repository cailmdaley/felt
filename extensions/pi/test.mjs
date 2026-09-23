import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "felt-pi-extension-"));
const fakeFelt = path.join(root, "felt");
const fakeScript = `#!/usr/bin/env node
if (process.argv[2] === "session") {
  process.stdout.write("SESSION_CONTEXT");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  let payload = {};
  try { payload = JSON.parse(input); } catch {}
  if (payload.hook_event_name === "UserPromptSubmit") {
    process.stdout.write(JSON.stringify({hookSpecificOutput: {additionalContext: "PASSIVE_CONTEXT"}}));
  }
});
`;
fs.writeFileSync(fakeFelt, fakeScript, { mode: 0o700 });
process.env.HOME = root;
process.env.FELT_BIN = fakeFelt;

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
reply = await request({ type: "msg", requestId: "after-end", sessionId, message: "another turn" });
assert.equal(reply.delivery, "follow_up");
await handlers.get("session_shutdown")({}, ctx);
assert.equal(fs.existsSync(socketPath), false);
fs.rmSync(root, { recursive: true, force: true });
console.log("pi extension tests passed");
