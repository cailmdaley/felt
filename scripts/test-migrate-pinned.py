"""Tests for scripts/migrate-pinned.py's planning: liveness first, the owner's
state for every decision, and no plan at all when an owner cannot be vouched
for. Run: python3 scripts/test-migrate-pinned.py"""

import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    "migrate_pinned", pathlib.Path(__file__).with_name("migrate-pinned.py")
)
mp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mp)


def row(slug, origin, host, status, runtime=None):
    entry = {"origin": origin, "fiber": {"slug": slug, "status": status, "shuttle": {"host": host}}}
    if runtime is not None:
        entry["runtime"] = runtime
    return entry


def feed(*rows, stale=(), cache=None):
    cache = cache or {}
    origins = {h: {"stale": h in stale, "cache": {"state": cache.get(h, "fresh")}} for h in ("laptop", "cluster")}
    return {"host": "laptop", "origins": origins, "fibers": list(rows)}


class Plans(unittest.TestCase):
    def verbs(self, planned):
        return {f: [s[0] for s in steps] for f, steps, _ in planned}

    def test_a_live_worker_is_never_rested_whatever_the_mirror_says(self):
        # The local mirror says open; the owner runs a worker. Liveness wins.
        f = feed(
            row("hub", "laptop", "cluster", "open"),
            row("hub", "cluster", "cluster", "active", runtime={"state": "running"}),
        )
        self.assertEqual(self.verbs(mp.plans(["hub"], f)), {"hub": ["reshape"]})

    def test_the_owners_status_decides_not_the_mirrors(self):
        f = feed(
            row("seat", "laptop", "cluster", "active"),
            row("seat", "cluster", "cluster", "closed"),
            row("desk", "laptop", "cluster", "closed"),
            row("desk", "cluster", "cluster", "open"),
        )
        self.assertEqual(
            self.verbs(mp.plans(["desk", "seat"], f)),
            {"seat": ["reshape"], "desk": ["rest", "reshape"]},
        )

    def test_an_idle_active_or_statusless_owner_row_rests(self):
        f = feed(row("a", "laptop", "laptop", "active"), row("b", "laptop", "laptop", ""))
        self.assertEqual(self.verbs(mp.plans(["a", "b"], f)), {"a": ["rest", "reshape"], "b": ["rest", "reshape"]})

    def test_a_deferred_owner_is_skipped_and_the_rest_still_planned(self):
        # cluster's cache is partial; deferring it lets laptop's fiber migrate
        # while cluster's fiber gets no verbs at all.
        f = feed(
            row("ok", "laptop", "laptop", "open"),
            row("far", "cluster", "cluster", "active"),
            cache={"cluster": "partial"},
        )
        with self.assertRaises(mp.Incomplete):
            mp.plans(["far", "ok"], f)
        self.assertEqual(
            self.verbs(mp.plans(["far", "ok"], f, frozenset({"cluster"}))),
            {"far": [], "ok": ["rest", "reshape"]},
        )

    def test_a_stale_owner_refuses_the_whole_plan(self):
        f = feed(
            row("ok", "laptop", "laptop", "open"),
            row("far", "cluster", "cluster", "active"),
            stale=("cluster",),
        )
        with self.assertRaises(mp.Incomplete) as caught:
            mp.plans(["far", "ok"], f)
        self.assertIn("cluster", str(caught.exception))

    def test_a_missing_owner_origin_or_row_refuses(self):
        missing_origin = {"origins": {"laptop": {"stale": False, "cache": {"state": "fresh"}}}, "fibers": [row("x", "laptop", "nibi", "open")]}
        with self.assertRaises(mp.Incomplete):
            mp.plans(["x"], missing_origin)
        missing_row = feed(row("y", "laptop", "cluster", "open"))
        with self.assertRaises(mp.Incomplete):
            mp.plans(["y"], missing_row)

    def test_a_cold_or_partial_owner_cache_refuses(self):
        # Reachable (stale: false) yet serving old rows: no plan at all.
        for state in ("cold", "partial", None):
            f = feed(row("seat", "cluster", "cluster", "open"), cache={"cluster": state})
            with self.assertRaises(mp.Incomplete) as caught:
                mp.plans(["seat"], f)
            self.assertIn("cluster", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
