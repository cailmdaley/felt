import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAIL_BYTES = 256 * 1024;

const hook = fileURLToPath(new URL("../claude-plugin/hooks/handoff.sh", import.meta.url));
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "felt-handoff-binary-"));
const shuttle = path.join(buildRoot, "shuttle");
execFileSync("go", ["build", "-o", shuttle, "./cmd/shuttle"], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
process.on("exit", () => fs.rmSync(buildRoot, { recursive: true, force: true }));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "felt-handoff-hook-"));
  const transcript = path.join(root, "session.jsonl");
  const env = { PATH: process.env.PATH, HOME: root, SHUTTLE_BIN: shuttle, SHUTTLE_HANDOFF_STATE_DIR: path.join(root, "state") };
  const input = { hook_event_name: "PostToolUse", session_id: "session/../../test", transcript_path: transcript };
  const write = (tokens, extra = {}) => fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "unknown", usage: { input_tokens: tokens - 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 10, output_tokens: 10 }, ...extra } }) + "\n");
  const run = (payload = input, overrides = {}) => execFileSync(hook, { input: JSON.stringify(payload), env: { ...env, ...overrides }, encoding: "utf8", timeout: 5000 });
  return { root, transcript, env, input, write, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const codexRow = (tokens, window = 200_000) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: tokens }, model_context_window: window } } }) + "\n";

test("a Claude worker is nudged once per level at 350k and 400k; other Claude sessions never", () => {
  const f = fixture();
  try {
    const transcript = path.join(f.root, ".claude", "projects", "repo", "session.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    const input = { ...f.input, transcript_path: transcript };
    const worker = { SHUTTLE_FIBER_PATH: path.join(f.root, "fiber.md") };
    const say = (tokens, env = worker) => {
      fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude", usage: { input_tokens: tokens - 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 } } }) + "\n");
      const out = f.run(input, env);
      return out && JSON.parse(out).hookSpecificOutput.additionalContext;
    };
    assert.equal(say(2_000_000, {}), "", "outside a worker");
    assert.equal(say(349_999), "");
    assert.match(say(362_000), /^Context is ~362k tokens \(soft threshold 350k\)\. .*`shuttle handoff`\.$/);
    assert.equal(say(360_000), "");
    assert.match(say(412_000), /^Context is ~412k tokens \(hard threshold 400k\)\. Finish your current step/);
    assert.equal(say(410_000), "");
  } finally { f.cleanup(); }
});

test("bounded tail skips old records, malformed lines, incomplete final write", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.transcript, codexRow(190_000));
    fs.appendFileSync(f.transcript, JSON.stringify({ type: "user", padding: "x".repeat(TAIL_BYTES * 4) }) + "\n");
    assert.equal(f.run(), "", "no whole-history fallback");
    fs.appendFileSync(f.transcript, "bad json\n" + codexRow(160_000) + "{\"partial\":");
    assert.match(JSON.parse(f.run()).hookSpecificOutput.additionalContext, /160,000 tokens/);
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

test("concurrent hooks claim each level only once", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.transcript, codexRow(160_000));
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
    fs.writeFileSync(f.transcript, codexRow(190_000));
    assert.equal(f.run({}, {}), "");
    assert.equal(f.run(f.input, { SHUTTLE_HANDOFF_PCT: "bad" }), "");
    assert.equal(f.run(f.input, { SHUTTLE_HANDOFF_STATE_DIR: f.transcript }), "");
    assert.equal(execFileSync(hook, { input: "not json", env: f.env, encoding: "utf8" }), "");
    assert.equal(f.run(f.input, { SHUTTLE_BIN: "/nonexistent", PATH: "/nonexistent" }), "");
  } finally { f.cleanup(); }
});
