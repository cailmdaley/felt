#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""Rewrite every `shuttle.kind: pinned` fiber in a felt store as a oneshot.

`pinned` is a retired kind: the CLI, the daemon and the board already read it
as `oneshot`, and `shuttle check` warns about it. This script finds those
warnings and settles each fiber where it belongs:

  - at rest (status open or absent, or active with no live worker anywhere in
    the fleet) -> `shuttle rest`: status open + horizon stashed, in Resting;
  - running (a live worker on its owning host) -> left active;
  - closed -> left in Awaiting review, or wherever its verdict put it;

then `shuttle reshape <fiber> oneshot` stores the current kind. Both verbs
route through the owning daemon for a fiber another host owns, so run this
only once every daemon in the fleet understands `shuttle rest`.

Dry run by default: it prints the plan and writes nothing. Pass --apply to
write. Running it again finds nothing left to do.

    scripts/migrate-pinned.py ~/loom            # the plan
    scripts/migrate-pinned.py ~/loom --apply    # do it
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


def shuttle(store: str, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["shuttle", "-C", store, *args],
        capture_output=True,
        text=True,
        check=check,
    )


def legacy_fibers(store: str) -> list[str]:
    """Fiber ids `shuttle check` reports as carrying the retired kind."""
    out = shuttle(store, "check", "--json", check=False).stdout
    issues = json.loads(out or "[]")
    return sorted(
        {
            i["fiber_id"]
            for i in issues
            if i.get("path") == "shuttle.kind" and "pinned" in i.get("message", "")
        }
    )


def fleet_running(store: str) -> set[str] | None:
    """Fiber ids with a live worker anywhere in the fleet, or None if unknown."""
    done = shuttle(store, "status", "--all", "--json", check=False)
    if done.returncode != 0:
        return None
    try:
        rows = json.loads(done.stdout)
    except json.JSONDecodeError:
        return None
    return {r["fiber_id"] for r in rows if r.get("running")}


def fiber_status(store: str, fiber: str) -> str:
    done = subprocess.run(
        ["felt", "-C", store, "show", fiber, "--field", "status"],
        capture_output=True,
        text=True,
        check=False,
    )
    return done.stdout.strip() if done.returncode == 0 else ""


def plan(store: str, fiber: str, running: set[str] | None) -> tuple[list[list[str]], str]:
    """The verbs to run for one fiber, and a one-line reason."""
    status = fiber_status(store, fiber)
    reshape = ["reshape", fiber, "oneshot"]
    if status == "closed":
        return [reshape], "closed: keeps its place, kind rewritten"
    if status == "active":
        if running is None:
            return [], "active, fleet liveness unknown: skipped (rerun when every host answers)"
        if fiber in running:
            return [reshape], "running: stays active, kind rewritten"
    return [["rest", fiber], reshape], f"{status or 'no status'}: rests in Resting, kind rewritten"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("store", help="felt store root (the directory holding .felt/)")
    parser.add_argument("--apply", action="store_true", help="write; without it, print the plan only")
    args = parser.parse_args()

    fibers = legacy_fibers(args.store)
    if not fibers:
        print("no kind: pinned fibers; nothing to do")
        return 0
    running = fleet_running(args.store)
    failed = 0
    for fiber in fibers:
        steps, reason = plan(args.store, fiber, running)
        print(f"{fiber}: {reason}")
        for step in steps:
            print(f"  shuttle {' '.join(step)}")
            if not args.apply:
                continue
            done = shuttle(args.store, *step, check=False)
            if done.returncode != 0:
                failed += 1
                print(f"    failed: {(done.stderr or done.stdout).strip()}", file=sys.stderr)
                break
    if not args.apply:
        print("\ndry run: nothing written; pass --apply to write")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
