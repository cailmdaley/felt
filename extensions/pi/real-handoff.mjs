#!/usr/bin/env node
// Opt-in real Pi engine with an isolated, local OpenAI-compatible provider.
// No operator credentials, account files, daemon, or paid API calls are used.
// Run: node extensions/pi/real-handoff.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "felt-real-pi-handoff-"));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
let calls = 0;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => raw += chunk);
  req.on("end", () => {
    const request = JSON.parse(raw);
    assert.ok(request.stream);
    calls++;
    const text = calls === 1 ? "READY" : calls === 3 ? "RESUMED" : "Saved.\nHANDOFF: none";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason, usage) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "handoff-test", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    chunk({ role: "assistant", content: text }, null);
    chunk({}, "stop", { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "handoff-local": {
  baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-test-key", api: "openai-completions",
  models: [{ id: "handoff-test", name: "Handoff test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1000 }],
} } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
// Deliberately controlled environment: this subprocess cannot inherit auth.
const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", FELT_BIN: "/nonexistent", SHUTTLE_BIN: "/nonexistent", SHUTTLE_HANDOFF_TOKENS: "100", SHUTTLE_HANDOFF_HARD_TOKENS: "750000" };
const binary = process.env.FELT_TEST_PI_BIN || "pi";
function run(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--mode", "json", "--print", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools", "--extension", repo, ...(process.env.FELT_TEST_SEAT_EXTENSION ? ["--extension", process.env.FELT_TEST_SEAT_EXTENSION] : []), "--model", "handoff-local/handoff-test", "--thinking", "off", "--session-id", "handoff-smoke", "--session-dir", path.join(root, "sessions"), prompt], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Pi timed out")); }, 60_000);
    child.stdout.on("data", (chunk) => out += chunk); child.stderr.on("data", (chunk) => err += chunk);
    child.on("error", reject); child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Pi exit ${code}: ${err}\n${out}`)); });
  });
}
const entries = () => fs.readdirSync(path.join(root, "sessions")).filter((file) => file.endsWith(".jsonl")).flatMap((file) => fs.readFileSync(path.join(root, "sessions", file), "utf8").trim().split("\n").map(JSON.parse));
const text = (entry) => typeof entry.message?.content === "string" ? entry.message.content : (entry.message?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
try {
  const output = await run("Reply READY, then follow any handoff instruction. No fiber or report exists.");
  assert.doesNotMatch(output, /"type":"extension_error"/);
  const first = entries();
  assert.equal(calls, 2, "real Pi schedules a second model call for the steer");
  assert.deepEqual(first.filter((e) => e.type === "custom" && e.customType === "shuttle-handoff").map((e) => e.data.level), ["soft"]);
  const nudges = first.filter((e) => e.message?.role === "user" && /^Context is at /.test(text(e)));
  assert.equal(nudges.length, 1);
  assert.match(text(nudges[0]), /tokens .*Bring your handoff surfaces current now/);
  assert.equal(first.some((e) => e.type === "compaction"), false);
  await run("Resume the same session. Reply RESUMED without a handoff line.");
  assert.equal(calls, 3);
  assert.equal(entries().filter((e) => e.message?.role === "user" && /^Context is at /.test(text(e))).length, 1);
  console.log("PASS real Pi: felt package loaded, one steer, second model request, resume without duplicate (isolated synthetic provider)");
  console.log(`Evidence: ${root}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (process.env.FELT_TEST_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
}
