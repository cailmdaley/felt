#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""Rewrite every `shuttle.kind: pinned` fiber in a felt store as a oneshot.

`pinned` is a retired kind: the CLI, the daemon and the board already read it
as `oneshot`, and `shuttle check` warns about it. This script finds those
warnings in the local store, then decides each fiber from its OWNER's view —
the owning daemon's document and its live runtime, read off the local daemon's
composite feed (`/api/v1/fibers/composite`):

  - a live worker on the owner           -> left as it is; kind rewritten
  - closed on the owner                  -> left where its verdict put it;
                                            kind rewritten
  - anything else (open, active, absent) -> `shuttle rest` (status open +
                                            horizon stashed), kind rewritten

Liveness is checked first, whatever the documents say. If the feed cannot vouch
for an owner — its origin is missing or stale, or it serves no row for the
fiber — the script plans nothing at all and names the hosts to bring back.
Both verbs route through the owning daemon, so run this only once every
daemon in the fleet understands `shuttle rest`, and before
`shuttle daemon release`.

Dry run by default: it prints the plan and writes nothing. Pass --apply to
write. Running it again finds nothing left to do.

    scripts/migrate-pinned.py ~/loom            # the plan
    scripts/migrate-pinned.py ~/loom --apply    # do it

The daemon is read at $SHUTTLE_DAEMON_URL, else http://127.0.0.1:4000.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request


class Incomplete(Exception):
    """The feed cannot vouch for every owner of a pinned fiber."""


def shuttle(store: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["shuttle", "-C", store, *args], capture_output=True, text=True, check=False)


def legacy_fibers(store: str) -> list[str]:
    """Fiber ids `shuttle check` reports as carrying the retired kind."""
    issues = json.loads(shuttle(store, "check", "--json").stdout or "[]")
    return sorted(
        {
            i["fiber_id"]
            for i in issues
            if i.get("path") == "shuttle.kind" and "pinned" in i.get("message", "")
        }
    )


def composite_feed() -> dict:
    base = os.environ.get("SHUTTLE_DAEMON_URL", "http://127.0.0.1:4000").rstrip("/")
    with urllib.request.urlopen(f"{base}/api/v1/fibers/composite", timeout=30) as resp:
        return json.load(resp)


def _slug(fiber: dict) -> str:
    return fiber.get("slug") or fiber.get("id") or ""


def plans(
    fibers: list[str], feed: dict, defer: frozenset[str] = frozenset()
) -> list[tuple[str, list[list[str]], str]]:
    """(fiber, verbs, reason) for each fiber, decided from its owner's row.

    A fiber owned by a host in `defer` is planned with no verbs, left for a
    later run. Raises Incomplete, naming every unvouched owner, before
    planning anything.
    """
    origins = feed.get("origins") or {}
    rows: dict[str, list[dict]] = {}
    for entry in feed.get("fibers") or []:
        rows.setdefault(_slug(entry.get("fiber") or {}), []).append(entry)

    owners: dict[str, dict] = {}
    gaps: list[str] = []
    for fiber in fibers:
        mirrored = rows.get(fiber, [])
        host = next(
            ((e.get("fiber") or {}).get("shuttle", {}).get("host") for e in mirrored
             if (e.get("fiber") or {}).get("shuttle", {}).get("host")),
            None,
        )
        if not host:
            gaps.append(f"{fiber}: no owning host on any row of the feed")
            continue
        if host in defer:
            continue
        origin = origins.get(host)
        if origin is None or origin.get("stale"):
            gaps.append(f"{fiber}: owner {host} is {'missing from' if origin is None else 'stale in'} the feed")
            continue
        # A reachable owner can still serve old rows: its document cache must
        # be fresh, not cold or partial.
        cache = (origin.get("cache") or {}).get("state")
        if cache != "fresh":
            gaps.append(f"{fiber}: owner {host}'s cache is {cache or 'unreported'}, not fresh")
            continue
        owner = next((e for e in mirrored if e.get("origin") == host), None)
        if owner is None:
            gaps.append(f"{fiber}: owner {host} serves no row for it")
            continue
        owners[fiber] = owner
    if gaps:
        raise Incomplete("\n".join(gaps))

    out = []
    for fiber in fibers:
        if fiber not in owners:
            out.append((fiber, [], "owner deferred: left for a later run"))
            continue
        owner = owners[fiber]
        reshape = ["reshape", fiber, "oneshot"]
        if owner.get("runtime"):
            out.append((fiber, [reshape], "a worker is live on its owner: left as it is, kind rewritten"))
            continue
        status = (owner.get("fiber") or {}).get("status") or ""
        if status == "closed":
            out.append((fiber, [reshape], "closed on its owner: keeps its place, kind rewritten"))
        else:
            out.append((fiber, [["rest", fiber], reshape], f"{status or 'no status'} on its owner: rests in Resting, kind rewritten"))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("store", help="felt store root (the directory holding .felt/)")
    parser.add_argument("--apply", action="store_true", help="write; without it, print the plan only")
    parser.add_argument(
        "--defer-host",
        action="append",
        default=[],
        metavar="HOST",
        help="leave fibers this host owns for a later run (repeatable); the rest still need a fresh owner",
    )
    args = parser.parse_args()

    fibers = legacy_fibers(args.store)
    if not fibers:
        print("no kind: pinned fibers; nothing to do")
        return 0
    try:
        planned = plans(fibers, composite_feed(), frozenset(args.defer_host))
    except Incomplete as gaps:
        print("refusing to plan: the fleet feed cannot vouch for every owner\n" + str(gaps), file=sys.stderr)
        return 2
    failed = 0
    for fiber, steps, reason in planned:
        print(f"{fiber}: {reason}")
        for step in steps:
            print(f"  shuttle {' '.join(step)}")
            if not args.apply:
                continue
            done = shuttle(args.store, *step)
            if done.returncode != 0:
                failed += 1
                print(f"    failed: {(done.stderr or done.stdout).strip()}", file=sys.stderr)
                break
    if not args.apply:
        print("\ndry run: nothing written; pass --apply to write")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
