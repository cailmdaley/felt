import assert from "node:assert/strict";
import { test } from "node:test";
import { HANDOFF_ENTRY, handoffThresholds, nextHandoff, handoffMessage } from "../../claude-plugin/hooks/lib/handoff.mjs";
import install from "./handoff.ts";

test("min(percent of window, absolute tokens), inclusive boundaries", () => {
  for (const [window, soft, hard] of [[200_000, 150_000, 176_000], [1_000_000, 500_000, 750_000], [2_000_000, 500_000, 750_000], [null, 500_000, 750_000]]) {
    assert.equal(nextHandoff({ tokens: soft - 1, contextWindow: window }, new Set()), null);
    assert.equal(nextHandoff({ tokens: soft, contextWindow: window }, new Set()), "soft");
    assert.equal(nextHandoff({ tokens: hard - 1, contextWindow: window }, new Set(["soft"])), null);
    assert.equal(nextHandoff({ tokens: hard, contextWindow: window }, new Set(["soft"])), "hard");
    assert.equal(nextHandoff({ tokens: hard + 1, contextWindow: window }, new Set(["soft", "hard"])), null);
  }
  for (const tokens of [null, undefined, NaN, Infinity, -1]) assert.equal(nextHandoff({ tokens }, new Set()), null);
});

test("environment thresholds validate and override both limits", () => {
  const rules = handoffThresholds({ SHUTTLE_HANDOFF_PCT: "1", SHUTTLE_HANDOFF_TOKENS: "10", SHUTTLE_HANDOFF_HARD_PCT: "2", SHUTTLE_HANDOFF_HARD_TOKENS: "20" });
  assert.deepEqual(rules, { soft: { pct: 1, tokens: 10 }, hard: { pct: 2, tokens: 20 } });
  assert.equal(nextHandoff({ tokens: 5, contextWindow: 500 }, new Set(), rules), "soft");
  assert.equal(nextHandoff({ tokens: 10 }, new Set(), rules), "soft");
  for (const value of ["", "0", "-1", "NaN", "Infinity", "101"]) assert.throws(() => handoffThresholds({ SHUTTLE_HANDOFF_PCT: value }));
  assert.throws(() => handoffThresholds({ SHUTTLE_HANDOFF_PCT: "90" }));
  assert.throws(() => handoffThresholds({ SHUTTLE_HANDOFF_TOKENS: "800000" }));
  assert.match(handoffMessage({ tokens: 500_000 }, "soft"), /500,000 tokens \(window unknown\)/);
});

function fixture(entries = []) {
  const handlers = new Map();
  const messages = [];
  const persisted = [...entries];
  install({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (text, options) => messages.push({ text, options }), appendEntry: (customType, data) => persisted.push({ type: "custom", customType, data }) });
  const ctx = { sessionManager: { getEntries: () => persisted }, getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000 }) };
  handlers.get("session_start")({}, ctx);
  const turn = (tokens, text = "working") => {
    ctx.getContextUsage = () => ({ tokens, contextWindow: 200_000 });
    handlers.get("turn_end")({ message: { content: [{ type: "text", text }] } }, ctx);
  };
  return { messages, persisted, handlers, ctx, turn };
}

test("Pi sends one steer per level, survives resume and branch rewinds", () => {
  const f = fixture();
  f.turn(149_999); assert.equal(f.messages.length, 0);
  f.turn(190_000); f.turn(190_000); f.turn(190_000);
  assert.deepEqual(f.persisted.map((entry) => entry.data.level), ["soft", "hard"]);
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[0].text, /190,000 tokens \(95.0% of the window\)/);
  assert.match(f.messages[1].text, /^HARD CONTEXT LIMIT:/);
  assert.deepEqual(f.messages.map((m) => m.options), [{ deliverAs: "steer" }, { deliverAs: "steer" }]);
  f.handlers.get("session_start")({}, f.ctx); f.turn(190_000);
  assert.equal(f.messages.length, 2);
  const resumed = fixture(f.persisted); resumed.turn(190_000);
  assert.equal(resumed.messages.length, 0);
  const fresh = fixture(); fresh.turn(160_000); assert.equal(fresh.messages.length, 1);
});

test("Pi respects existing confer warning markers and explicit handoff", () => {
  const f = fixture([{ type: "custom", customType: "confer-handoff", data: { level: "soft" } }]);
  f.turn(180_000, "Saved.\nHANDOFF: none\n"); assert.equal(f.messages.length, 0);
  f.turn(180_000); assert.equal(f.messages.length, 1);
  assert.equal(f.persisted.at(-1).customType, HANDOFF_ENTRY);
});

test("Pi missing usage/configuration never fails a turn or changes compaction", () => {
  const f = fixture();
  f.ctx.getContextUsage = () => { throw new Error("unavailable"); };
  assert.doesNotThrow(() => f.handlers.get("turn_end")({ message: {} }, f.ctx));
  process.env.SHUTTLE_HANDOFF_PCT = "bad";
  try { assert.doesNotThrow(() => f.turn(190_000)); } finally { delete process.env.SHUTTLE_HANDOFF_PCT; }
  assert.equal(f.handlers.has("session_before_compact"), false);
});
