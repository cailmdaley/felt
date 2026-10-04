// Shared by felt's Pi adapter and the Claude Code/Codex transcript hook.
export const HANDOFF_ENTRY = "shuttle-handoff";

export function handoffThresholds(env = process.env) {
  const read = (key, fallback, max = Infinity) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const soft = { pct: read("SHUTTLE_HANDOFF_PCT", 75, 100), tokens: read("SHUTTLE_HANDOFF_TOKENS", 500_000) };
  const hard = { pct: read("SHUTTLE_HANDOFF_HARD_PCT", 88, 100), tokens: read("SHUTTLE_HANDOFF_HARD_TOKENS", 750_000) };
  if (hard.pct < soft.pct || hard.tokens < soft.tokens) throw new Error("Hard handoff thresholds must not precede soft thresholds");
  return { soft, hard };
}

export function nextHandoff(usage, sent, thresholds = handoffThresholds()) {
  if (!Number.isFinite(usage?.tokens) || usage.tokens < 0) return null;
  const window = Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
  for (const level of ["soft", "hard"]) {
    const rule = thresholds[level];
    const threshold = window ? Math.min(window * rule.pct / 100, rule.tokens) : rule.tokens;
    if (!sent.has(level) && usage.tokens >= threshold) return level;
  }
  return null;
}

export function handoffMessage(usage, level) {
  const window = Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
  const percent = window ? `${(100 * usage.tokens / window).toFixed(1)}% of the window` : "window unknown";
  const instruction = `Context is at ${Math.round(usage.tokens).toLocaleString("en-US")} tokens (${percent}). Bring your handoff surfaces current now — your fiber's \`## Status\` (and report, if you keep one), commits — then hand off: a shuttle worker runs \`shuttle handoff <fiber>\`; a confer worker ends its reply with \`HANDOFF: <fiber or none>\` and stops; an interactive session tells the human it's time to hand off.`;
  return level === "hard" ? `HARD CONTEXT LIMIT: stop taking on work; finish only the durable handoff. ${instruction}` : instruction;
}
