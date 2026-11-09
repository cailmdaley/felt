#!/usr/bin/env python3
"""What a day of turns cost on this host, by what started each turn.

Reads this host's Claude transcripts and, for every main-thread turn that began
in the window, sums the tokens its requests used. Cost is counted in
input-token equivalents: uncached input 1, cache write 1.25 (5 min) or 2 (1 h),
cache read 0.1, output 5. A turn is cold when its first request read less than
half of its prompt from the cache; its cold premium is what that request cost
beyond a full cache read. Turns are grouped by what started them: the human, a
Shuttle thread notice, another Shuttle message, a subagent or teammate of the
harness, or a background task finishing.

usage: wake-cost.py [--hours 24] [--until ISO] [--projects ~/.claude/projects]
"""
import argparse, collections, datetime as dt, glob, json, os, re

WAKE = "Another Claude session sent a message:"

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(p, dict) and p.get("type") == "tool_result" for p in content):
            return None
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return None

def turns(path):
    turn, seen = None, {}
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("isSidechain"):
                continue
            kind, message = r.get("type"), r.get("message") or {}
            if kind == "user":
                text = text_of(message.get("content"))
                origin = (r.get("origin") or {}).get("kind")
                # Peer messages and task notifications are meta records that start a turn like a typed prompt.
                if text is not None and (origin or not r.get("isMeta")):
                    if turn:
                        yield turn, list(seen.values())
                    turn, seen = {"at": r.get("timestamp"), "text": text, "origin": origin or "human"}, {}
            elif kind == "assistant" and turn and message.get("model") != "<synthetic>":
                usage = message.get("usage")
                if usage:
                    seen[message.get("id") or r.get("uuid")] = usage
    if turn:
        yield turn, list(seen.values())

def cost(u):
    write = u.get("cache_creation") or {}
    hour = write.get("ephemeral_1h_input_tokens", 0)
    short = (u.get("cache_creation_input_tokens") or 0) - hour
    return ((u.get("input_tokens") or 0) + 1.25 * short + 2 * hour
            + 0.1 * (u.get("cache_read_input_tokens") or 0) + 5 * (u.get("output_tokens") or 0))

def prompt(u):
    return (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--until")
    ap.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--top", type=int, default=8)
    a = ap.parse_args()
    until = dt.datetime.fromisoformat(a.until) if a.until else dt.datetime.now(dt.timezone.utc)
    since = until - dt.timedelta(hours=a.hours)
    rows = collections.defaultdict(lambda: collections.Counter())
    worst = []
    for path in glob.glob(os.path.join(a.projects, "*", "*.jsonl")):
        if os.path.getmtime(path) < since.timestamp():
            continue
        project = os.path.basename(os.path.dirname(path))
        for turn, usages in turns(path):
            try:
                at = dt.datetime.fromisoformat(turn["at"].replace("Z", "+00:00"))
            except (AttributeError, ValueError):
                continue
            if not (since <= at < until) or not usages:
                continue
            head = turn["text"].lstrip()
            if turn["origin"] == "task-notification":
                kind = "background task"
            elif turn["origin"] != "peer":
                kind = "human"
            elif re.search(r"\[from shuttle\]\s*\nthread \S+ ", head):
                kind = "thread notice"
            elif re.match(re.escape(WAKE) + r"\s*\[from ", head):
                kind = "shuttle message"
            else:
                kind = "subagent or teammate"
            first = usages[0]
            cold = prompt(first) > 0 and (first.get("cache_read_input_tokens") or 0) < 0.5 * prompt(first)
            spent = sum(cost(u) for u in usages)
            row = rows[(project, kind)]
            row["turns"] += 1
            row["cost"] += spent
            row["cold"] += cold
            row["cold_cost"] += cost(first) - 0.1 * prompt(first) if cold else 0
            row["first_request"] += cost(first)
            if kind in ("thread notice", "shuttle message"):
                worst.append((cost(first), prompt(first), cold, kind, project, turn["at"], re.sub(r"\s+", " ", head[len(WAKE):])[:90]))
    print(f"window {since:%Y-%m-%d %H:%M} to {until:%Y-%m-%d %H:%M} UTC; cost in input-token equivalents")
    print(f"{'project':42} {'kind':20} {'turns':>5} {'cold':>5} {'cost':>12} {'cold premium':>12} {'first req':>12}")
    for (project, kind), row in sorted(rows.items()):
        print(f"{project[-42:]:42} {kind:20} {row['turns']:5} {row['cold']:5} {row['cost']:12,.0f} {row['cold_cost']:12,.0f} {row['first_request']:12,.0f}")
    total = collections.Counter()
    for (_, kind), row in rows.items():
        for k, v in row.items():
            total[(kind, k)] += v
    for kind in ("human", "thread notice", "shuttle message", "subagent or teammate", "background task"):
        print(f"{'ALL':42} {kind:20} {total[(kind,'turns')]:5} {total[(kind,'cold')]:5} {total[(kind,'cost')]:12,.0f} {total[(kind,'cold_cost')]:12,.0f} {total[(kind,'first_request')]:12,.0f}")
    print(f"\ncostliest first requests of woken turns:")
    for first, size, cold, kind, project, at, head in sorted(worst, reverse=True)[:a.top]:
        print(f"  {first:10,.0f}  prompt {size:9,}  {'cold' if cold else 'warm'}  {kind:15} {at[:16]} {project[-24:]}  {head}")

if __name__ == "__main__":
    main()
