import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcriptUsage, TAIL_BYTES } from "../claude-plugin/hooks/handoff.mjs";

const hook = fileURLToPath(new URL("../claude-plugin/hooks/handoff.sh", import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "felt-handoff-hook-"));
  const transcript = path.join(root, "session.jsonl");
  const env = { PATH: process.env.PATH, HOME: root, SHUTTLE_HANDOFF_STATE_DIR: path.join(root, "state") };
  const input = { hook_event_name: "PostToolUse", session_id: "session/../../test", transcript_path: transcript };
  const write = (tokens, extra = {}) => fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "unknown", usage: { input_tokens: tokens - 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 10, output_tokens: 10 }, ...extra } }) + "\n");
  const run = (payload = input, overrides = {}) => execFileSync(hook, { input: JSON.stringify(payload), env: { ...env, ...overrides }, encoding: "utf8", timeout: 5000 });
  return { root, transcript, env, input, write, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("Claude pipe: below, once soft, resumed once hard, new session", () => {
  const f = fixture();
  try {
    f.write(499_999); assert.equal(f.run(), "");
    f.write(500_000);
    const soft = JSON.parse(f.run()).hookSpecificOutput;
    assert.equal(soft.hookEventName, "PostToolUse");
    assert.match(soft.additionalContext, /500,000 tokens \(window unknown\)/);
    assert.equal(f.run(), "");
    assert.equal(f.run({ ...f.input, hook_event_name: "UserPromptSubmit" }), "");
    f.write(750_000);
    assert.match(JSON.parse(f.run()).hookSpecificOutput.additionalContext, /^HARD CONTEXT LIMIT:/);
    assert.equal(f.run(), "");
    assert.ok(JSON.parse(f.run({ ...f.input, session_id: "fresh" })).hookSpecificOutput.additionalContext);
  } finally { f.cleanup(); }
});

test("Claude explicit window uses percent and sums cached/output tokens", () => {
  const f = fixture();
  try {
    f.write(150_000);
    assert.equal(f.run(), "");
    assert.match(JSON.parse(f.run({ ...f.input, context_window: 200_000 })).hookSpecificOutput.additionalContext, /75.0% of the window/);
    f.write(150_000, { model: "claude-test[1m]" });
    assert.equal(transcriptUsage(f.transcript).contextWindow, 1_000_000);
  } finally { f.cleanup(); }
});

test("bounded tail skips old records, malformed lines, incomplete final write", () => {
  const f = fixture();
  try {
    f.write(800_000);
    fs.appendFileSync(f.transcript, JSON.stringify({ type: "user", padding: "x".repeat(TAIL_BYTES * 4) }) + "\n");
    assert.equal(f.run(), "", "no whole-history fallback");
    fs.appendFileSync(f.transcript, "bad json\n" + JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 600_000 } } }) + "\n{\"partial\":");
    assert.match(JSON.parse(f.run()).hookSpecificOutput.additionalContext, /600,000 tokens/);
  } finally { f.cleanup(); }
});

test("Codex uses last request usage/window, never cumulative or cached twice", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.transcript, JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 9_000_000 }, last_token_usage: { total_tokens: 149_999, cached_input_tokens: 149_999 }, model_context_window: 200_000 } } }) + "\n");
    assert.equal(f.run(), "");
    const row = JSON.parse(fs.readFileSync(f.transcript, "utf8")); row.payload.info.last_token_usage.total_tokens = 150_000;
    fs.appendFileSync(f.transcript, JSON.stringify(row) + "\n");
    assert.match(JSON.parse(f.run()).hookSpecificOutput.additionalContext, /75.0% of the window/);
    assert.equal(f.run(), "");
  } finally { f.cleanup(); }
});

test("concurrent Claude hooks claim each level only once", async () => {
  const f = fixture();
  try {
    f.write(500_000);
    const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(hook, { env: f.env }); let output = "";
      child.stdout.on("data", (data) => output += data);
      child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`exit ${code}`)));
      child.stdin.end(JSON.stringify(f.input));
    })));
    assert.equal(outputs.filter(Boolean).length, 1);
  } finally { f.cleanup(); }
});

test("bad input, missing runtime/file, invalid env, unwritable state fail open", () => {
  const f = fixture();
  try {
    assert.equal(f.run(), "");
    f.write(800_000);
    assert.equal(f.run({}, {}), "");
    assert.equal(f.run(f.input, { SHUTTLE_HANDOFF_PCT: "bad" }), "");
    assert.equal(f.run(f.input, { SHUTTLE_HANDOFF_STATE_DIR: f.transcript }), "");
    assert.equal(execFileSync(hook, { input: "not json", env: f.env, encoding: "utf8" }), "");
    assert.equal(f.run(f.input, { PATH: "/nonexistent" }), "");
  } finally { f.cleanup(); }
});
