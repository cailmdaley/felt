import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { handoffThresholds, nextHandoff, handoffMessage } from "./lib/handoff.mjs";

export const TAIL_BYTES = 256 * 1024;

/** Bounded suffix only; skip partial/oversized JSONL records, never scan history. */
export function transcriptUsage(file, input = {}, env = process.env) {
  const fd = fs.openSync(file, "r");
  let tail;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    tail = buffer.subarray(0, bytes).toString("utf8");
    if (start) tail = tail.slice(tail.indexOf("\n") + 1);
  } finally { fs.closeSync(fd); }
  for (const line of tail.split("\n").reverse()) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    // Codex rollouts expose per-request (not cumulative) token_count events.
    if (row.type === "event_msg" && row.payload?.type === "token_count") {
      const info = row.payload.info;
      const tokens = info?.last_token_usage?.total_tokens;
      if (Number.isFinite(tokens)) return { tokens, contextWindow: info.model_context_window ?? null, harness: "codex" };
    }
    if (row.type !== "assistant" || row.message?.role !== "assistant") continue;
    const usage = row.message.usage;
    if (!usage || !Number.isFinite(usage.input_tokens)) continue;
    const values = [usage.input_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0, usage.output_tokens ?? 0];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) continue;
    // Do not guess a window from a model name: Claude aliases/account limits
    // can differ. Explicit metadata/override or the [1m] selector is knowable.
    const window = Number(input.context_window ?? usage.context_window ?? row.message.context_window ?? env.SHUTTLE_HANDOFF_CONTEXT_WINDOW);
    return {
      tokens: values.reduce((sum, value) => sum + value, 0),
      contextWindow: Number.isFinite(window) && window > 0 ? window : /\[1m\]/i.test(row.message.model ?? "") ? 1_000_000 : null,
      harness: "claude",
    };
  }
  return null;
}

export function runHandoffHook(input, env = process.env) {
  if (!["PostToolUse", "UserPromptSubmit"].includes(input.hook_event_name) || !input.session_id || !input.transcript_path) return;
  const usage = transcriptUsage(input.transcript_path, input, env);
  if (!usage) return;
  const thresholds = handoffThresholds(env);
  const root = env.SHUTTLE_HANDOFF_STATE_DIR || path.join(os.homedir(), ".shuttle", "handoff");
  const key = createHash("sha256").update(`${usage.harness}:${input.session_id}`).digest("hex");
  const directory = path.join(root, key);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sent = new Set(["soft", "hard"].filter((level) => fs.existsSync(path.join(directory, level))));
  const level = nextHandoff(usage, sent, thresholds);
  if (!level) return;
  // Atomic exclusive claim: simultaneous tool hooks cannot both emit a level.
  // No SessionEnd cleanup: resumes retain their one-shot claims.
  try { fs.writeFileSync(path.join(directory, level), JSON.stringify(usage), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code === "EEXIST") return; throw error; }
  return { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: handoffMessage(usage, level) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const output = runHandoffHook(JSON.parse(fs.readFileSync(0, "utf8")));
    if (output) process.stdout.write(JSON.stringify(output) + "\n");
  } catch { /* All errors are silent: a nudge must never fail a tool call. */ }
}
