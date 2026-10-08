defmodule Shuttle.PollerTest do
  # group: the :dbg tracer and `:dbg.stop_clear/0` are VM-wide (they clear every
  # call-trace pattern, FileReadTrace's included).
  use ExUnit.Case, async: true, group: :call_trace

  import Shuttle.Test.TranscriptHelpers
  import Shuttle.Test.PollerHelpers

  alias Shuttle.ActionQueries
  alias Shuttle.DaemonHeartbeat
  alias Shuttle.FeltStores
  alias Shuttle.Poller
  alias Shuttle.Poller.Snapshot
  alias Shuttle.Dispatcher
  alias Shuttle.Test.FiberUid
  alias Shuttle.Test.FeltStoreRunner, as: MockRunner
  alias Shuttle.Test.Env

  # Every `:sys.get_state/2` on a Poller waits this long: on a loaded machine
  # a Poller applying a cycle can take longer than the 5 s default to answer,
  # and that is "not yet", not a failure.
  @state_timeout 30_000

  # ── Setup ──

  setup do
    MockRunner.start!()
    MockRunner.reset()
    mock_felt_root = MockRunner.felt_root()
    on_exit(fn -> File.rm_rf(mock_felt_root) end)

    # Isolate the per-host runtime markers (dispatch / handoff / re-arm) under a
    # throwaway SHUTTLE_DATA_DIR so continuation/orphan tests don't bleed across
    # each other or into the developer's real ~/.shuttle.
    data_dir =
      Path.join(System.tmp_dir!(), "shuttle-poller-markers-#{System.unique_integer([:positive])}")

    File.mkdir_p!(data_dir)
    Env.put_env("SHUTTLE_DATA_DIR", data_dir)

    # Session-ledger lines land under the same throwaway dir. test_helper.exs
    # pins a suite-wide SHUTTLE_SESSIONS_FILE (keeping the suite out of the real
    # ~/.shuttle) and it wins over SHUTTLE_DATA_DIR — drop it so each test reads
    # only its own pairings.
    Env.delete_env("SHUTTLE_SESSIONS_FILE")

    on_exit(fn -> rm_rf_settled!(data_dir) end)

    :ok
  end

  # ── Helpers ──

  # Companion to wait_until for when the check IS the assertion (e.g. a pattern
  # match or a snapshot-shape assert). It re-runs the assertion every 5ms,
  # catching its own failure, so it passes the instant the polled state settles.
  # The poll cycle is a multi-hop async chain (tick → 20ms timer → run_poll_cycle
  # → read Task → :poll_world → apply → dispatch → spawn_tmux) that a loaded
  # machine stretches arbitrarily, so the ceiling (~30s, as wait_until's) is
  # reached only when the state never settles.
  defp assert_eventually(fun, attempts \\ 6_000) do
    fun.()
  rescue
    error in [ExUnit.AssertionError, MatchError] ->
      if attempts > 0 do
        Process.sleep(5)
        assert_eventually(fun, attempts - 1)
      else
        reraise(error, __STACKTRACE__)
      end
  end

  # A ceiling of ~30 s, reached only when the condition never holds: a passing
  # test returns as soon as it does, however loaded the machine.
  defp wait_until(fun, attempts \\ 6_000)
  defp wait_until(fun, 0), do: fun.()

  defp wait_until(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(5)
      wait_until(fun, attempts - 1)
    end
  end

  # Drive exactly ONE poll cycle and return only once it has been applied.
  # Every cycle a test drives goes through here. A raw `send(poller,
  # :run_poll_cycle)` is dropped while another cycle is in flight, and when it
  # lands it can leave the boot cycle unsettled — a read taken before the
  # test's next mutation (a kill, an exit, a closed fiber) that then applies
  # after it and re-dispatches.
  #
  # What a cycle merely *observes* needs the bound too:
  # `reconcile/1` resets `state.orphans` to `[]` at the top of every cycle, so
  # an orphan reports what THIS cycle saw and is gone the moment the next one
  # runs. A wall-clock wait that re-nudges the poller (the old idiom here)
  # therefore races itself — the nudged cycle sees the re-dispatched fiber's
  # live session, records no orphan, and clears the one the test was waiting
  # for, unobservably and permanently. Assert on a cycle you bounded yourself.
  #
  # Bounding is two steps, and the first one belongs BEFORE the scenario is
  # built: `settle_poller!` absorbs the cycle the poller runs 20ms after boot,
  # which otherwise lands mid-scenario and does the reconcile itself — leaving
  # the test's own cycle nothing to observe. Then run one cycle and wait for
  # `poll_cycles` to tick. Callers pass a poll_interval_ms far longer than the
  # test, so no further cycle can start behind the assertions.
  defp settle_poller!(poller) do
    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)
             state.poll_cycles > 0 and not state.poll_check_in_progress
           end)

    :ok
  end

  defp sync_poll_cycle!(poller) do
    settle_poller!(poller)
    before = :sys.get_state(poller, @state_timeout).poll_cycles

    send(poller, :run_poll_cycle)

    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > before end)
    :ok
  end

  # Every trace the `:dbg` relay has forwarded from `poller`, oldest first, then
  # tracing stops. `trace_delivered` returns once the runtime has handed all of
  # the poller's traces so far to the tracer; a sentinel sent to the tracer
  # after that is relayed after them, so receiving it means nothing is still in
  # flight. (A non-`:call` sentinel, so the tracer does not suspend the sender.)
  defp drain_dbg_relay!(poller) do
    ref = :erlang.trace_delivered(poller)
    assert_receive {:trace_delivered, ^poller, ^ref}
    {:ok, tracer} = apply(:dbg, :get_tracer, [])
    sentinel = make_ref()
    send(tracer, {:trace, self(), :dbg_sentinel, sentinel})
    traces = receive_dbg_relay_until(sentinel, [])
    apply(:dbg, :stop_clear, [])
    traces
  end

  defp receive_dbg_relay_until(sentinel, acc) do
    receive do
      {:dbg_relay, {:trace, _pid, :dbg_sentinel, ^sentinel}} -> Enum.reverse(acc)
      {:dbg_relay, msg} -> receive_dbg_relay_until(sentinel, [msg | acc])
    after
      30_000 -> flunk("the :dbg relay never forwarded its sentinel")
    end
  end

  defp shuttle_show_count do
    Enum.count(MockRunner.commands(), fn {cmd, args} ->
      cmd == "shuttle" and Enum.take(args, 1) == ["show"]
    end)
  end

  defp new_session_scripts do
    MockRunner.commands()
    |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
    |> Enum.map(fn {_cmd, args} -> List.last(args) end)
  end

  # Mirror the dispatcher's at-spawn dispatch stamp: `session_uuid` +
  # `dispatched_at` into the fiber's `shuttle:` block. The optional `at` lets a
  # test back-date the dispatch so a later handoff can be ordered relative to it.
  defp write_dispatch_marker(id, session_id, at \\ DateTime.utc_now()) do
    MockRunner.put_shuttle_fields(id, %{
      "session_uuid" => session_id,
      "dispatched_at" => DateTime.to_iso8601(at)
    })
  end

  # Mirror the worker's `shuttle handoff`: stamp `shuttle.handed_off_at` in
  # RFC3339 UTC — the clean-exit signal the daemon compares against dispatched_at.
  defp write_handoff_marker(id, at \\ DateTime.utc_now()) do
    MockRunner.put_shuttle_fields(id, %{"handed_off_at" => DateTime.to_iso8601(at)})
  end

  # Inject the resolved occurrences Shuttle computes for a standing role — the
  # same way the mock's `with_resolved_agent` injects resolved.agent. Shuttle
  # inlines `prev_due` (the catch-up dispatch signal — most recent tick <= now)
  # and `next_due` (display and schedule-validity signals); the daemon reads them
  # from `shuttle show -j` without parsing cron. A `prev_due` after the role's
  # last service makes it due; an older one leaves it valid but sleeping.
  defp set_resolved_occurrences(id, prev_due, next_due) do
    MockRunner.put_shuttle_fields(id, %{
      "resolved" => %{
        "prev_due" => DateTime.to_iso8601(prev_due),
        "next_due" => DateTime.to_iso8601(next_due)
      }
    })
  end

  # ── Tests ──

  test "felt reads omit resolved facets and Shuttle reads include them" do
    id = "tests/resolved-surface"
    MockRunner.set_shuttle(id, "agent: claude-opus")

    assert {felt_listing, 0} = MockRunner.cmd("felt", ["ls", "--json"], [])
    assert [%{"id" => ^id, "shuttle" => felt_list_block}] = Jason.decode!(felt_listing)
    refute Map.has_key?(felt_list_block, "resolved")

    assert {shuttle_listing, 0} = MockRunner.cmd("shuttle", ["ls", "--json"], [])
    assert [%{"id" => ^id, "shuttle" => shuttle_list_block}] = Jason.decode!(shuttle_listing)
    assert get_in(shuttle_list_block, ["resolved", "agent", "id"]) == "claude-opus"

    assert {felt_show, 0} = MockRunner.cmd("felt", ["show", id, "--json"], [])
    assert %{"shuttle" => felt_show_block} = Jason.decode!(felt_show)
    refute Map.has_key?(felt_show_block, "resolved")

    assert {shuttle_show, 0} = MockRunner.cmd("shuttle", ["show", id, "--json"], [])
    assert %{"shuttle" => shuttle_show_block} = Jason.decode!(shuttle_show)
    assert get_in(shuttle_show_block, ["resolved", "agent", "id"]) == "claude-opus"
  end

  test "poller discovers and dispatches eligible fibers" do
    # Use a fiber ID unique to this test to avoid collisions with sessions left
    # alive by other tests' long-lived Pollers/Watchers.
    fiber = make_fiber("tests/haiku-dispatch")
    MockRunner.set_fiber("tests/haiku-dispatch", fiber)
    MockRunner.set_shuttle("tests/haiku-dispatch", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Trigger a poll cycle manually
    send(poller, {:tick, Poller.snapshot(poller) |> Map.get(:tick_token)})

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    # Check snapshot shows running worker
    assert wait_until(fn ->
             length(Poller.snapshot(poller).eligible) == 1
           end)

    snap = Poller.snapshot(poller)
    assert length(snap.eligible) == 1
    assert hd(snap.eligible).fiber_id == "tests/haiku-dispatch"
  end

  test "poller skips fibers targeted at a different shuttle host" do
    fiber = make_fiber("tests/host-mismatch")
    MockRunner.set_fiber("tests/host-mismatch", fiber)
    MockRunner.set_shuttle("tests/host-mismatch", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_mismatch,
        runner: MockRunner,
        own_host_id: "local",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0
  end

  test "poller dispatches fibers targeted at its own shuttle host" do
    fiber = make_fiber("tests/host-match")
    MockRunner.set_fiber("tests/host-match", fiber)
    MockRunner.set_shuttle("tests/host-match", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_match,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)
             length(snap.eligible) == 1 and hd(snap.eligible).fiber_id == "tests/host-match"
           end)
  end

  # The Poller's default `own_host_id` is SHUTTLE_HOST when set, else Shuttle's
  # answer from `shuttle host --json`. Explicit `own_host_id:` opts always win.
  describe "own_host_id resolution" do
    test "SHUTTLE_HOST, trimmed, wins without asking Shuttle" do
      Env.put_env("SHUTTLE_HOST", "  candide \n")
      MockRunner.set_host_json(~s({"id": "from-shuttle"}))

      {:ok, poller} = start_identity_poller(:test_poller_env_host)

      assert Poller.snapshot(poller).host == "candide"
      refute asked_shuttle_for_host?()
    end

    test "with SHUTTLE_HOST unset the id is Shuttle's, frozen for the Poller's life" do
      Env.delete_env("SHUTTLE_HOST")
      MockRunner.set_host_json(~s({"id": "candide", "class": "single-user"}))

      {:ok, poller} = start_identity_poller(:test_poller_shuttle_host)

      assert Poller.snapshot(poller).host == "candide"
      assert Poller.own_host_id(:test_poller_shuttle_host) == "candide"
      assert asked_shuttle_for_host?()

      # A later change in Shuttle's answer does not reach a booted Poller.
      MockRunner.set_host_json(~s({"id": "renamed"}))
      assert Poller.own_host_id(:test_poller_shuttle_host) == "candide"
    end

    test "a Poller whose shuttle cannot name the host refuses to boot" do
      Env.delete_env("SHUTTLE_HOST")
      MockRunner.set_host_json("parsing host.json: not a JSON object", 1)

      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, reason} =
                 start_supervised(%{
                   id: make_ref(),
                   start:
                     {Poller, :start_link,
                      [
                        [
                          name: :test_poller_no_host,
                          runner: MockRunner,
                          poll_interval_ms: 60_000,
                          felt_stores: [MockRunner.felt_root()],
                          daemon_heartbeat_file: test_heartbeat_file()
                        ]
                      ]},
                   restart: :temporary
                 })

        assert inspect(reason) =~ "shuttle host --json"
      end)
    end
  end

  defp start_identity_poller(name) do
    start_poller!(
      name: name,
      runner: MockRunner,
      poll_interval_ms: 60_000,
      felt_stores: [MockRunner.felt_root()]
    )
  end

  defp asked_shuttle_for_host? do
    Enum.member?(MockRunner.commands(), {"shuttle", ["host", "--json"]})
  end

  test "poller uses shuttle listing for discovery" do
    fiber = make_fiber("tests/projected-discovery")
    MockRunner.set_fiber("tests/projected-discovery", fiber)
    MockRunner.set_shuttle("tests/projected-discovery", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_projected_listing,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The poller uses shuttle's widened kanban projection (the full field set
    # the document cache builds entries from).
    projection = Enum.join(Shuttle.FiberDocuments.kanban_fields(), ",")

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "shuttle" and
                 args == [
                   "-C",
                   MockRunner.felt_root(),
                   "ls",
                   "--json",
                   "--has-field",
                   "shuttle",
                   "--json-field",
                   projection
                 ]
             end)
           end)

    assert {:ok, fiber} =
             Poller.fetch_fiber_full(
               "tests/projected-discovery",
               :sys.get_state(poller, @state_timeout)
             )

    assert get_in(fiber, ["shuttle", "resolved", "agent", "id"]) == "claude-sonnet"

    assert {"shuttle",
            ["-C", MockRunner.felt_root(), "show", "tests/projected-discovery", "--json"]} in MockRunner.commands()
  end

  test "poller builds document cache entries from candidate rows, no shuttle show" do
    uid = "01JZ00000000000000000000CA"

    fiber =
      make_fiber("tests/cached-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:00:00Z",
        "outcome" => "first"
      })

    MockRunner.set_fiber("tests/cached-document", fiber)
    MockRunner.set_shuttle("tests/cached-document", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_document_cache,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    first_stats = Poller.snapshot(poller)[:document_cache]

    assert %{"hits" => 0, "misses" => 1, "entries" => 1} = first_stats
    # The cache builds each entry directly from its candidate row — the widened
    # `shuttle ls` projection carries every field — so NO `shuttle show` fires.
    assert shuttle_show_count() == 0

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 1 and stats["misses"] == 0
           end)

    assert shuttle_show_count() == 0

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "slug" => "tests/cached-document"}}] = body.fibers

    changed_fiber =
      make_fiber("tests/cached-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:05:00Z",
        "name" => "changed document",
        "shuttle" => %{"enabled" => true, "kind" => "oneshot", "host" => "test-host"}
      })

    MockRunner.set_fiber("tests/cached-document", changed_fiber)
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 0 and stats["misses"] == 1
           end)

    assert shuttle_show_count() == 0
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "name" => "changed document"}}] = body.fibers
  end

  test "post-mutation document refresh keeps Shuttle's resolved agent" do
    id = "tests/refreshed-agent"
    uid = "01JZ00000000000000000000CC"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => uid}))
    MockRunner.set_shuttle(id, "kind: oneshot\nagent: claude-opus")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_refresh_resolved_agent,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    assert {:ok, before} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid} = fiber}] = before.fibers
    assert get_in(fiber, ["shuttle", "resolved", "agent", "id"]) == "claude-opus"

    assert :ok = Poller.refresh_document(poller, id)

    assert {:ok, refreshed} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid} = refreshed_fiber}] = refreshed.fibers
    assert get_in(refreshed_fiber, ["shuttle", "resolved", "agent", "id"]) == "claude-opus"
  end

  # The incident this guards: on an overloaded login node one failed `shuttle ls`
  # used to blank every fiber on the host for the tick — mass document-cache
  # eviction, cards flapping in and out. A failed listing is "world unknown", not
  # "fibers gone": the poller carries last-known candidates without re-shelling.
  test "a failed Shuttle listing carries last-known candidates instead of blanking the store" do
    uid = "01JZ00000000000000000000CB"

    fiber =
      make_fiber("tests/retained-document", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T02:00:00Z"
      })

    MockRunner.set_fiber("tests/retained-document", fiber)
    MockRunner.set_shuttle("tests/retained-document", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_retained_document,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    show_count = shuttle_show_count()

    # Shuttle's primary listing times out. The tick retains the last-known
    # candidate, keeps the card served, and reuses its mtime-keyed cache entry.
    # Capture the last all-fresh refreshed_at before the failure, so we can prove
    # the partial tick does NOT advance it.
    fresh_refreshed_at = Poller.snapshot(poller)[:document_cache]["refreshed_at"]
    assert is_binary(fresh_refreshed_at)

    MockRunner.set_listing_timeout(true)
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             stats = Poller.snapshot(poller)[:document_cache]
             stats["hits"] == 1 and stats["misses"] == 0 and stats["entries"] == 1
           end)

    assert shuttle_show_count() == show_count
    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{fiber: %{"id" => ^uid, "slug" => "tests/retained-document"}}] = body.fibers

    # A store's listing FAILED, so this tick is "partial": the cache state says
    # so and refreshed_at is frozen at the last all-fresh tick (staleness honest).
    partial_stats = Poller.snapshot(poller)[:document_cache]
    assert partial_stats["state"] == "partial"
    assert partial_stats["refreshed_at"] == fresh_refreshed_at
    assert body.cache.state == "partial"
    assert body.cache.refreshed_at == fresh_refreshed_at

    # Shuttle recovers: the live listing resumes, the entry is served, and the tick
    # is "fresh" again with an ADVANCED refreshed_at.
    MockRunner.set_listing_timeout(false)
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [%{fiber: %{"id" => ^uid, "slug" => "tests/retained-document"}}] = body.fibers
      assert body.cache.state == "fresh"
    end)
  end

  test "seam patch survives a poll built from a pre-mutation snapshot (prefer-newer merge)" do
    uid = "01JZ0000000000000000000SEA"

    fiber =
      make_fiber("tests/seam", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T01:00:00Z",
        "name" => "disk-old"
      })

    MockRunner.set_fiber("tests/seam", fiber)
    MockRunner.set_shuttle("tests/seam", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_seam_merge,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    # Simulate a mid-poll `refresh_document` patch landing on the LIVE cache: a
    # NEWER mtime and a fresh body. The on-disk candidate still reads the OLD
    # mtime, so the next poll's cache rebuild produces the stale "disk-old" entry.
    patched_entry = %{
      felt_store: MockRunner.felt_root(),
      path: "tests/seam/seam.md",
      fiber: %{
        "id" => uid,
        "slug" => "tests/seam",
        "uid" => uid,
        "name" => "patched-newer",
        "status" => "active",
        "shuttle" => %{"kind" => "oneshot", "host" => "test-host"}
      }
    }

    :sys.replace_state(poller, fn state ->
      %{
        state
        | document_cache: %{uid => %{modified_at: "2026-06-06T02:00:00Z", entry: patched_entry}}
      }
    end)

    sync_poll_cycle!(poller)

    # The Task-built cache carries "disk-old" (mtime m1); the merge prefers the
    # live "patched-newer" entry (mtime m2 > m1) instead of clobbering it.
    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [%{fiber: %{"name" => "patched-newer"}}] = body.fibers
    end)
  end

  test "mtime-reuse hit reconciles report_path when a sibling report is added/removed" do
    uid = "01JZ0000000000000000000RPT"

    fiber =
      make_fiber("tests/report-toggle", %{
        "uid" => uid,
        "modified_at" => "2026-06-06T03:00:00Z"
      })

    MockRunner.set_fiber("tests/report-toggle", fiber)
    MockRunner.set_shuttle("tests/report-toggle", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_report_toggle,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) == 1
           end)

    # No report yet.
    {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [entry] = body.fibers
    refute Map.has_key?(entry, :report_path)

    # A report.html appears — but adding it does NOT bump the fiber's mtime, so
    # the next poll is a mtime-REUSE hit. The reconcile must still surface it from
    # the candidate row's native report_path field.
    current = MockRunner.fiber("tests/report-toggle")

    MockRunner.set_fiber(
      "tests/report-toggle",
      Map.put(current, "report_path", "#{MockRunner.felt_dir()}/tests/report-toggle/report.html")
    )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [entry] = body.fibers
      assert Map.has_key?(entry, :report_path)
      assert String.ends_with?(entry.report_path, "report.html")
    end)

    # The report is removed (field drops) — again without an mtime bump. The
    # reconcile drops the stale report_path on the reuse hit.
    MockRunner.set_fiber("tests/report-toggle", Map.delete(current, "report_path"))
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert {:ok, body} = Poller.cached_fiber_documents(poller)
      assert [entry] = body.fibers
      refute Map.has_key?(entry, :report_path)
    end)
  end

  test "cold-cache serve logs once per cold period, not per request" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_cold_log,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # Let the boot poll warm the cache, then force it cold and re-arm the guard.
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).document_cache_ready end)

    :sys.replace_state(poller, fn state ->
      %{state | document_cache_ready: false, cold_feed_logged: false, document_cache: %{}}
    end)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        {:ok, _} = Poller.cached_fiber_documents(poller)
        {:ok, _} = Poller.cached_fiber_documents(poller)
        {:ok, _} = Poller.cached_fiber_documents(poller)
        # Flush the GenServer so its logging is done before capture_log returns.
        _ = :sys.get_state(poller, @state_timeout)
      end)

    occurrences =
      log
      |> String.split("owner feed served from COLD document cache")
      |> length()
      |> Kernel.-(1)

    assert occurrences == 1
    assert :sys.get_state(poller, @state_timeout).cold_feed_logged == true
  end

  test "owner feed stamps serve-time runtime onto an owned fiber with a live worker" do
    uid = "01JZ00000000000000000000RT"

    fiber =
      make_fiber("tests/aloft", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/aloft", fiber)
    MockRunner.set_shuttle("tests/aloft", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_stamp,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The fiber dispatches (lands in state.running) AND its document caches.
    assert wait_until(fn ->
             snap = Poller.snapshot(poller)

             length(snap.eligible) == 1 and
               get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [%{runtime: runtime} = entry] = body.fibers
    # Liveness joins by uid (rename-safe): the served row's fiber uid matches
    # the runtime_key under which state.running tracks the live worker.
    assert get_in(entry, [:fiber, "uid"]) == uid
    assert %{tmux_session: session, state: _state, started_at: started} = runtime
    assert is_binary(session)
    assert is_integer(started)
    # No activity source by default → no phase, but last_activity_at still
    # present (falls back to meta/started_at) so the field is never missing.
    refute Map.has_key?(runtime, :phase)
    assert is_integer(runtime.last_activity_at)
  end

  test "owner feed stamps the REAL last_activity_at, distinct from started_at" do
    uid = "01JZ00000000000000000000RA"

    fiber =
      make_fiber("tests/realactivity", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/realactivity", fiber)
    MockRunner.set_shuttle("tests/realactivity", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_real_activity,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)
             length(snap.eligible) == 1 and get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    # Discover the running worker's session and its started_at, then inject an
    # activity record whose last_event_at is deliberately 90s BEFORE started_at.
    assert {:ok, %{fibers: [%{runtime: %{tmux_session: session, started_at: started}}]}} =
             Poller.cached_fiber_documents(poller)

    last_event_at = started - 90_000

    Env.put_app_env(:waiting_phases_source, fn ->
      %{session => %{last_event_at: last_event_at, phase: "waiting"}}
    end)

    assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
    # The served last_activity_at is the tracker's real timestamp — NOT started_at.
    assert runtime.last_activity_at == last_event_at
    assert runtime.last_activity_at != runtime.started_at
    assert runtime.phase == "waiting"
  end

  test "owner feed stamps phase: waiting when the live worker's session is waiting for input" do
    uid = "01JZ00000000000000000000RW"

    fiber =
      make_fiber("tests/waiting", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/waiting", fiber)
    MockRunner.set_shuttle("tests/waiting", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_waiting,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             snap = Poller.snapshot(poller)

             length(snap.eligible) == 1 and
               get_in(snap, [:document_cache, "entries"]) >= 1
           end)

    # Discover the running worker's session, then inject it as waiting.
    assert {:ok, %{fibers: [%{runtime: %{tmux_session: session}}]}} =
             Poller.cached_fiber_documents(poller)

    Env.put_app_env(:waiting_phases_source, fn ->
      %{session => %{last_event_at: 1_700_000_000_000, phase: "waiting"}}
    end)

    assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
    assert runtime.phase == "waiting"
    assert runtime.last_activity_at == 1_700_000_000_000

    # The escalation phase stamps straight through the same path.
    Env.put_app_env(:waiting_phases_source, fn ->
      %{session => %{last_event_at: 1_700_000_000_000, phase: "attention"}}
    end)

    assert {:ok, %{fibers: [%{runtime: escalated}]}} = Poller.cached_fiber_documents(poller)
    assert escalated.phase == "attention"

    # Clearing the activity map drops the phase but keeps last_activity_at (the
    # meta/started_at fallback) — self-healing on the serve path.
    Env.put_app_env(:waiting_phases_source, fn -> %{} end)
    assert {:ok, %{fibers: [%{runtime: cleared}]}} = Poller.cached_fiber_documents(poller)
    refute Map.has_key?(cleared, :phase)
    assert is_integer(cleared.last_activity_at)
  end

  test "owner feed omits runtime for an owned fiber with no live worker" do
    uid = "01JZ00000000000000000000RX"

    fiber =
      make_fiber("tests/idle", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/idle", fiber)
    MockRunner.set_shuttle("tests/idle", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_idle,
        runner: MockRunner,
        own_host_id: "candide",
        # No worker slots: the document caches but nothing runs, so no runtime.
        max_concurrent_workers: 0,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             get_in(Poller.snapshot(poller), [:document_cache, "entries"]) >= 1
           end)

    assert {:ok, body} = Poller.cached_fiber_documents(poller)
    assert [entry] = body.fibers
    refute Map.has_key?(entry, :runtime)
  end

  test "kill_session SIGKILLs a live worker and tears down runtime immediately, writing no status" do
    uid = "01JZ00000000000000000000KS"

    fiber =
      make_fiber("tests/killme", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/killme", fiber)
    MockRunner.set_shuttle("tests/killme", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_kill_session,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # Wait until the fiber is live (stamped with runtime on the owner feed).
    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    {:ok, %{fibers: [live]}} = Poller.cached_fiber_documents(poller)
    session = get_in(live, [:runtime, :tmux_session])
    assert is_binary(session)

    # Kill by fiber id — owner-routed at the controller; here we hit the Poller
    # directly. Returns the session it killed.
    assert {:ok, ^session} = Poller.kill_session(poller, "tests/killme")

    # Runtime is gone NOW — not after the watcher's next poll. The fiber's
    # document status is untouched (no awaiting-review verdict written): the
    # owner feed still serves the row, just without a runtime stamp.
    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> not Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    {:ok, %{fibers: [after_kill]}} = Poller.cached_fiber_documents(poller)
    # status untouched by the kill (the drag's column write is the verdict).
    assert get_in(after_kill, [:fiber, "status"]) in [nil, "active", "open"]

    # Idempotent: killing again when nothing runs is a clean no-op.
    assert {:ok, :no_session} = Poller.kill_session(poller, "tests/killme")
  end

  # rest goes through the Poller like accept and resume: the --local write
  # lands `status: open` first, then the worker is stopped through its
  # backend and its runtime torn down, so no tick between the two can launch
  # a successor.
  test "a rest transition writes inside the Poller, then stops the live worker" do
    fiber_id = "tests/restme"
    store = MockRunner.felt_root()

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"uid" => "01JZ00000000000000000000RS", "status" => "active"})
    )

    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nhost: candide\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_rest_transition,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [store]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    assert {:ok, output} = Poller.lifecycle_transition(poller, :rest, fiber_id)
    assert output =~ "worker: stopped"

    commands = MockRunner.commands()

    write =
      Enum.find_index(commands, &(&1 == {"shuttle", ["-C", store, "rest", fiber_id, "--local"]}))

    stop =
      Enum.find_index(commands, fn {cmd, args} -> cmd == "tmux" and hd(args) == "kill-session" end)

    assert write != nil and stop != nil and write < stop, "rest must disarm before it stops"

    assert {:ok, %{fibers: [entry]}} = Poller.cached_fiber_documents(poller)
    refute Map.has_key?(entry, :runtime)
    assert entry.fiber["status"] == "open"
  end

  # A live worker nothing tracks — its watcher never started, or no restart
  # has adopted it yet — must not survive a rest (or a /kill): the stop looks
  # for it under the fiber's canonical session name before it reports that
  # nothing was running.
  test "a rest stops a live tmux worker the Poller does not track" do
    fiber_id = "tests/untracked"
    uid = "01JZ00000000000000000000WT"
    store = MockRunner.felt_root()

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "open"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nhost: candide\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_rest_untracked,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [store]
      )

    sync_poll_cycle!(poller)
    session = Dispatcher.session_name(fiber_id, uid)
    MockRunner.add_tmux_session(session)

    refute Enum.any?(:sys.get_state(poller, @state_timeout).running, fn {_k, m} ->
             m.session == session
           end)

    assert {:ok, output} = Poller.lifecycle_transition(poller, :rest, fiber_id)
    assert output =~ "worker: stopped #{session}"
    assert {"tmux", ["kill-session", "-t", session]} in MockRunner.commands()
  end

  # /kill may name a fiber by its uid. The untracked lookup resolves the
  # canonical slug first, so it finds `<slug>-<uid>-shuttle`, not a
  # `<uid>-<uid>-shuttle` that names nothing.
  test "a kill by uid stops an untracked worker under the canonical session" do
    fiber_id = "tests/untracked-by-uid"
    uid = "01JZ00000000000000000000WK"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "open"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nhost: candide\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_kill_untracked_uid,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    session = Dispatcher.session_name(fiber_id, uid)
    MockRunner.add_tmux_session(session)

    assert {:ok, ^session} = Poller.kill_session(poller, uid)
    assert {"tmux", ["kill-session", "-t", session]} in MockRunner.commands()
  end

  # Fail closed: a fiber the Poller cannot read has no verified identity, so the
  # untracked stop touches nothing — not even a live session that a lookup by
  # its name alone would have found.
  test "an untracked stop refuses when the fiber's identity cannot be verified" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_kill_unverified,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    MockRunner.add_tmux_session("ghost-01JZ00000000000000000000WG-shuttle")

    assert {:error, reason} = Poller.kill_session(poller, "tests/ghost")
    assert reason =~ "could not verify the identity of tests/ghost"

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "kill-session"
           end)
  end

  # An app-only host has no tmux. A readable `surface: app` fiber with no live
  # worker must make /kill and rest clean no-ops there: nothing probes tmux,
  # nothing tries a terminal stop.
  test "on a host without tmux, kill and rest of an idle app fiber are no-ops" do
    fiber_id = "tests/app-no-tmux"
    uid = "01JZ00000000000000000000WA"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nhost: candide\nsurface: app\nagent: codex-sol\n",
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_app_no_tmux,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    no_tmux = Path.join(System.tmp_dir!(), "no-tmux-#{System.unique_integer([:positive])}")
    File.mkdir_p!(no_tmux)
    on_exit(fn -> File.rm_rf(no_tmux) end)
    Env.put_env("PATH", no_tmux)
    before = length(MockRunner.commands())

    assert {:ok, :no_session} = Poller.kill_session(poller, fiber_id)
    assert {:ok, output} = Poller.lifecycle_transition(poller, :rest, fiber_id)
    refute output =~ "worker: stopped"

    after_calls = Enum.drop(MockRunner.commands(), before)
    refute Enum.any?(after_calls, fn {cmd, _} -> cmd == "tmux" end)
  end

  # The other half of the app-only guard: a TERMINAL fiber is probed even when
  # tmux is not on the daemon's PATH, because its worker can outlive the
  # daemon that lost tmux. A stop that cannot reach it fails; it never reports
  # nothing running while the worker lives on.
  test "on a host without tmux, kill of a terminal fiber's live worker fails closed" do
    fiber_id = "tests/cli-no-tmux"
    uid = "01JZ00000000000000000000WC"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "open"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nhost: candide\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_cli_no_tmux,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    session = Dispatcher.session_name(fiber_id, uid)
    MockRunner.add_tmux_session(session)
    no_tmux = Path.join(System.tmp_dir!(), "no-tmux-#{System.unique_integer([:positive])}")
    File.mkdir_p!(no_tmux)
    on_exit(fn -> File.rm_rf(no_tmux) end)
    Env.put_env("PATH", no_tmux)
    MockRunner.set_kill_session_failure(true)

    assert {:error, reason} = Poller.kill_session(poller, fiber_id)
    assert reason =~ "stopping the worker failed"
    assert {"tmux", ["kill-session", "-t", session]} in MockRunner.commands()
  end

  # The three tmux "already gone" phrasings session_already_gone? must treat as
  # success: the per-session "session not found" and "no such session", and a
  # whole-server-down "no server running". In every case tmux reports the
  # session is already gone (exit 1) - the poller must still treat this as a
  # successful kill and tear down runtime tracking, not surface it as a
  # failure. Each is its own test (not one shared body) so a fresh MockRunner +
  # poller keeps them from cross-claiming each other's fiber.
  for {variant, uid_suffix, gone_output} <- [
        {:not_found, "KN", "\"session not found\""},
        {:no_server, "K0", "\"no server running\""},
        {:no_such, "K1", "\"no such session\""}
      ] do
    test "kill_session treats tmux's #{gone_output} as a successful teardown" do
      variant = unquote(variant)
      fiber_id = "tests/killme-#{variant}"
      uid = "01JZ00000000000000000000#{unquote(uid_suffix)}"

      fiber =
        make_fiber(fiber_id, %{
          "uid" => uid,
          "modified_at" => "2026-06-08T01:00:00Z"
        })

      MockRunner.set_fiber(fiber_id, fiber)
      MockRunner.set_shuttle(fiber_id, "enabled: true\nkind: oneshot\nhost: candide\n")

      {:ok, poller} =
        start_poller!(
          name: :"test_poller_kill_session_#{variant}",
          runner: MockRunner,
          own_host_id: "candide",
          poll_interval_ms: 60_000,
          felt_stores: [MockRunner.felt_root()]
        )

      # Bound the cycles: a still-active fiber is re-dispatched by any cycle
      # applied after the kill, so none may be in flight or pending behind it.
      sync_poll_cycle!(poller)

      assert wait_until(fn ->
               case Poller.cached_fiber_documents(poller) do
                 {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
                 _ -> false
               end
             end)

      assert {:ok, %{fibers: [live]}} = Poller.cached_fiber_documents(poller)
      assert %{tmux_session: session} = live[:runtime]

      MockRunner.set_kill_session_failure(variant)
      assert {:ok, ^session} = Poller.kill_session(poller, fiber_id)

      assert wait_until(fn ->
               case Poller.cached_fiber_documents(poller) do
                 {:ok, %{fibers: [entry]}} -> not Map.has_key?(entry, :runtime)
                 _ -> false
               end
             end)
    end
  end

  test "kill_session surfaces a genuine tmux kill failure and leaves runtime tracking intact" do
    uid = "01JZ00000000000000000000KF"

    fiber =
      make_fiber("tests/killme-fail", %{
        "uid" => uid,
        "modified_at" => "2026-06-08T01:00:00Z"
      })

    MockRunner.set_fiber("tests/killme-fail", fiber)
    MockRunner.set_shuttle("tests/killme-fail", "enabled: true\nkind: oneshot\nhost: candide\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_kill_session_fail,
        runner: MockRunner,
        own_host_id: "candide",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             case Poller.cached_fiber_documents(poller) do
               {:ok, %{fibers: [entry]}} -> Map.has_key?(entry, :runtime)
               _ -> false
             end
           end)

    state_before = :sys.get_state(poller, @state_timeout)
    [{runtime_key, meta_before}] = Map.to_list(state_before.running)
    original_watcher_pid = meta_before.pid
    assert is_pid(original_watcher_pid) and Process.alive?(original_watcher_pid)

    # A genuine kill failure (session still alive, tmux refused): the ghost
    # worker keeps running, so tracking must NOT be torn down and the reply
    # must surface the failure rather than a false {:ok, ...}.
    MockRunner.set_kill_session_failure(true)
    assert {:error, reason} = Poller.kill_session(poller, "tests/killme-fail")
    assert reason =~ "stopping the worker failed"

    {:ok, %{fibers: [still_live]}} = Poller.cached_fiber_documents(poller)
    assert Map.has_key?(still_live, :runtime)

    # `kill_session` stops the watcher BEFORE attempting the kill, so a
    # failed kill must re-arm a fresh watcher against the still-live
    # session — otherwise nobody observes its eventual exit until this
    # daemon restarts, a second flavor of ghost worker.
    state_after = :sys.get_state(poller, @state_timeout)
    meta_after = Map.get(state_after.running, runtime_key)
    assert is_pid(meta_after.pid) and Process.alive?(meta_after.pid)
    refute meta_after.pid == original_watcher_pid
  end

  test "New session (force + resume_mode:fresh) CUTS an open session: marker stamped, live tmux killed, then dispatched fresh" do
    fiber_id = "tests/cut-open-session"
    uid = "01JZ00000000000000000000CT"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
      "active"
    )

    # max_concurrent_workers: 0 silences the autonomous tick; explicit
    # dispatch_fiber/3 is not slot-gated, so the cut path is fully exercised
    # without the poll racing the two manual dispatches.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_cut_open_session,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # First dispatch makes the fiber live (a fresh worker, a real tmux session).
    assert {:ok, first_session} =
             Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    assert Shuttle.Tmux.present?(MockRunner, first_session)

    before_cut = length(MockRunner.commands())

    # "New session" — a forced fresh dispatch against the now-live session. The
    # cut fires INSTEAD of bouncing off :already_running: marker + kill, fresh.
    assert {:ok, second_session} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               resume_mode: "fresh"
             )

    cut_commands = MockRunner.commands() |> Enum.drop(before_cut)

    marker_idx =
      Enum.find_index(cut_commands, fn
        {"shuttle", args} -> "mark-runtime" in args and "--handed-off-at" in args
        _ -> false
      end)

    kill_idx =
      Enum.find_index(cut_commands, fn
        {"tmux", ["kill-session", "-t", ^first_session]} -> true
        _ -> false
      end)

    new_idx =
      Enum.find_index(cut_commands, fn
        {"tmux", ["new-session" | _]} -> true
        _ -> false
      end)

    # The clean-exit marker was stamped, the live tmux was killed, and a fresh
    # session was spawned — all three happened.
    assert is_integer(marker_idx), "expected shuttle mark-runtime --handed-off-at during the cut"
    assert is_integer(kill_idx), "expected the live tmux session to be killed during the cut"
    assert is_integer(new_idx), "expected a fresh tmux session after the cut"

    # Order is load-bearing: marker BEFORE kill (so a failed re-dispatch still
    # leaves the cut session clean), and the fresh spawn AFTER the kill.
    assert marker_idx < kill_idx
    assert new_idx > kill_idx

    # The fiber is live again under a fresh session (same canonical name).
    assert Shuttle.Tmux.present?(MockRunner, second_session)
  end

  # A cut worker's run script outlives `tmux kill-session` for as long as its
  # harness takes to exit; the fresh session reuses the name, so the cut waits
  # for the worker to go rather than refusing the fresh dispatch as
  # :already_running (with no running entry left to name).
  defp start_live_cut_fiber!(fiber_id, uid, name) do
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: name,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    poller
  end

  test "New session waits out a cut worker that outlives kill-session, then dispatches fresh" do
    fiber_id = "tests/cut-lingering-worker"

    poller =
      start_live_cut_fiber!(fiber_id, "01JZ00000000000000000000WG", :test_poller_cut_linger)

    MockRunner.set_worker_linger(3)
    before_cut = length(MockRunner.commands())

    assert {:ok, session} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               resume_mode: "fresh"
             )

    assert Shuttle.Tmux.present?(MockRunner, session)
    cut_commands = MockRunner.commands() |> Enum.drop(before_cut)

    refute Enum.any?(cut_commands, &match?({"kill", _}, &1)),
           "a worker that exits needs no signal"
  end

  test "New session escalates to SIGTERM on a cut worker that survives its grace" do
    Env.put_app_env(:worker_stop_ladder, [
      {nil, 100},
      {"TERM", 2_000},
      {"KILL", 100}
    ])

    fiber_id = "tests/cut-stubborn-worker"

    poller =
      start_live_cut_fiber!(fiber_id, "01JZ00000000000000000000SB", :test_poller_cut_stubborn)

    MockRunner.set_worker_linger(:until_signalled)

    assert {:ok, _} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               resume_mode: "fresh"
             )

    assert {"kill", ["-TERM", "--", "-4242", "4242"]} in MockRunner.commands()
    refute Enum.any?(MockRunner.commands(), &match?({"kill", ["-KILL" | _]}, &1))
  end

  test "Resume (force + resume_mode:previous) does NOT cut a live session — it refuses with :already_running" do
    fiber_id = "tests/resume-no-cut"
    uid = "01JZ00000000000000000000RC"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_no_cut,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    before = length(MockRunner.commands())

    # Resume against a live session is refused — you don't resume what's already
    # running; only "fresh" cuts. The live transcript is the one Resume preserves.
    assert {:error, :already_running} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               resume_mode: "previous"
             )

    resume_commands = MockRunner.commands() |> Enum.drop(before)

    refute Enum.any?(resume_commands, fn
             {"shuttle", args} -> "mark-runtime" in args and "--handed-off-at" in args
             _ -> false
           end)

    refute Enum.any?(resume_commands, fn
             {"tmux", ["kill-session" | _]} -> true
             _ -> false
           end)

    # The live session is untouched.
    assert Shuttle.Tmux.present?(MockRunner, session)
  end

  test "snapshot remains responsive while poll cycle is reading felt" do
    fiber = make_fiber("tests/slow-felt-read")
    MockRunner.set_fiber("tests/slow-felt-read", fiber)
    MockRunner.set_shuttle("tests/slow-felt-read", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_slow_felt_snapshot,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The cycle under test is held inside its listing until the snapshot has
    # been answered, so the snapshot can only have been served while that
    # same read was in flight.
    settle_poller!(poller)
    MockRunner.hold_ls()
    send(poller, :run_poll_cycle)
    assert_receive {:ls_held, reader}

    %{poll_token: token, poll_cycles: cycles} = :sys.get_state(poller, @state_timeout)
    assert is_map(Poller.snapshot(poller, 30_000))

    state = :sys.get_state(poller, @state_timeout)
    assert state.poll_check_in_progress
    assert state.poll_token == token
    assert state.poll_cycles == cycles

    send(reader, :release_ls)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > cycles end)
  end

  test "a completed poll cycle cancels its stall watchdog" do
    # A cycle's read is held to catch its watchdog armed; the watchdog itself
    # is far longer than the test, so a timer that reads as gone after the
    # cycle completes was cancelled, not expired. (An empty store skips its
    # listing, so the store carries a fiber to list.)
    fiber = make_fiber("tests/watchdog-completion", %{"status" => "closed"})
    MockRunner.set_fiber("tests/watchdog-completion", fiber)
    MockRunner.set_shuttle("tests/watchdog-completion", oneshot_shuttle(), "closed")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_stall_watchdog_completion,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        stall_timeout_ms: 600_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    cycles = :sys.get_state(poller, @state_timeout).poll_cycles
    MockRunner.hold_ls()
    send(poller, :run_poll_cycle)
    assert_receive {:ls_held, reader}

    watchdog = :sys.get_state(poller, @state_timeout).poll_stall_timer_ref
    assert is_integer(Process.read_timer(watchdog))

    send(reader, :release_ls)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > cycles end)
    assert Process.read_timer(watchdog) == false
    state = :sys.get_state(poller, @state_timeout)
    assert state.poll_check_in_progress == false
    assert state.poll_token == nil
    assert state.poll_task_pid == nil
    assert state.poll_stall_timer_ref == nil

    health = Poller.snapshot(poller).poll_health
    assert health.state == "idle"
    assert health.stall_timeout_ms == 2_701_000
    assert health.stall_timeout_ms > :sys.get_state(poller, @state_timeout).full_scan_timeout_ms
    assert health.discovery[MockRunner.felt_root()].mode == :full
    assert health.stalls == 0
    assert health.last_stalled_at == nil
  end

  test "repeated stalled reads advance the poller and supersede late replies" do
    fiber = make_fiber("tests/stalled-read")
    MockRunner.set_fiber("tests/stalled-read", fiber)
    MockRunner.set_shuttle("tests/stalled-read", oneshot_shuttle())
    MockRunner.set_ls_delay(2_000)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_stall_watchdog_repeated,
        runner: MockRunner,
        poll_interval_ms: 20,
        stall_timeout_ms: 30,
        full_scan_timeout_ms: 1,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn -> is_pid(:sys.get_state(poller, @state_timeout).poll_task_pid) end)

    %{poll_task_pid: first_task, poll_token: abandoned_token} =
      :sys.get_state(poller, @state_timeout)

    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)

             state.poll_stalls >= 1 and is_pid(state.poll_task_pid) and
               state.poll_task_pid != first_task
           end)

    assert wait_until(fn -> not Process.alive?(first_task) end)

    second_task = :sys.get_state(poller, @state_timeout).poll_task_pid

    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)

             state.poll_stalls >= 2 and is_pid(state.poll_task_pid) and
               state.poll_task_pid != second_task
           end)

    assert wait_until(fn -> not Process.alive?(second_task) end)

    health = Poller.snapshot(poller).poll_health
    assert health.stalls >= 2
    assert is_binary(health.last_stalled_at)

    # Hold one cycle in flight for the rest of the test: its read outlasts the
    # test and its watchdog does not fire, so the current token cannot move
    # under the assertions. Every cycle that starts after the swap carries the
    # long watchdog; a different token than the one in flight at the swap is
    # such a cycle.
    MockRunner.set_ls_delay(60_000)
    :sys.replace_state(poller, &%{&1 | stall_timeout_ms: 600_000})
    token_at_swap = :sys.get_state(poller, @state_timeout).poll_token

    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)
             is_pid(state.poll_task_pid) and state.poll_token not in [nil, token_at_swap]
           end)

    # Inject the first, abandoned cycle's reply. The current cycle remains
    # authoritative: its token stands and no cycle is counted as applied.
    %{poll_token: current_token, poll_cycles: cycles} = :sys.get_state(poller, @state_timeout)
    send(poller, {:poll_world, abandoned_token, {:error, :late_abandoned_cycle}})
    _ = Poller.snapshot(poller)
    state = :sys.get_state(poller, @state_timeout)
    assert state.poll_token == current_token
    assert state.poll_cycles == cycles
  end

  test "poller supervision shuts down an in-flight read with its owner" do
    fiber = make_fiber("tests/shutdown-stalled-read")
    MockRunner.set_fiber("tests/shutdown-stalled-read", fiber)
    MockRunner.set_shuttle("tests/shutdown-stalled-read", oneshot_shuttle())
    MockRunner.set_ls_delay(1_000)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_stall_watchdog_shutdown,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        stall_timeout_ms: 10_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn -> is_pid(:sys.get_state(poller, @state_timeout).poll_task_pid) end)

    task_pid = :sys.get_state(poller, @state_timeout).poll_task_pid
    monitor = Process.monitor(poller)
    Process.exit(poller, :shutdown)

    assert_receive {:DOWN, ^monitor, :process, ^poller, :shutdown}
    assert wait_until(fn -> not Process.alive?(task_pid) end)
  end

  test "poller skips closed fibers" do
    fiber = make_fiber("tests/closed", %{"status" => "closed"})
    MockRunner.set_fiber("tests/closed", fiber)
    MockRunner.set_shuttle("tests/closed", oneshot_shuttle(), "closed")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller skips draft fibers" do
    fiber = make_fiber("tests/draft", %{"tags" => ["constitution", "draft"], "status" => "open"})
    MockRunner.set_fiber("tests/draft", fiber)

    # Draft = shuttle block present but enabled: false; status open (not yet committed to In flight).
    MockRunner.set_shuttle("tests/draft", "enabled: false\nkind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_3,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a legacy kind:pinned active fiber dispatches as a oneshot" do
    # `pinned` is a retired kind read as oneshot (`Poller.block_kind/1`, the
    # CLI's `shuttle.NormalizeKind`): an armed one dispatches on the tick like
    # any oneshot, with no kind-specific gate.
    fiber = make_fiber("tests/legacy-pinned", %{"status" => "active"})
    MockRunner.set_fiber("tests/legacy-pinned", fiber)
    MockRunner.set_shuttle("tests/legacy-pinned", "kind: pinned\nagent: claude-opus\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_legacy_pinned,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    _ = Poller.snapshot(poller)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end),
           "an armed legacy pinned fiber must dispatch as a oneshot"
  end

  test "poller never stats a pure-ineligible fiber's project_dir (iCloud/TCC guard)" do
    # `project_dir_available?/1` is the only per-tick filesystem read that
    # leaves the felt store — it stats `shuttle.project_dir`. On a fiber whose
    # project_dir lives on a macOS file provider (iCloud Drive,
    # ~/Library/CloudStorage), statting it every poll raises a repeating
    # un-grantable TCC "access data from other apps" prompt. `filter_eligible/2`
    # and `eligible?/2` must run every cheap, pure, in-memory gate BEFORE
    # touching that stat, so a fiber a pure predicate already rejects (here: a
    # paused oneshot, status: open) never reaches it. This
    # test proves that by tracing real calls to `File.dir?/1` inside the
    # poller process across a poll tick and asserting the sentinel
    # project_dir path is never among the args — a regression that
    # reintroduces `project_dir_available?` ahead of the pure gates would stat
    # it and fail this test, even though the resulting eligibility decision
    # (not dispatched) looks identical either way.
    sentinel_dir = "/tmp/felt-icloud-sentinel-#{System.unique_integer([:positive])}"
    refute File.exists?(sentinel_dir)

    fiber = make_fiber("tests/paused-icloud-sentinel", %{"status" => "open"})
    MockRunner.set_fiber("tests/paused-icloud-sentinel", fiber)

    MockRunner.set_shuttle(
      "tests/paused-icloud-sentinel",
      "kind: oneshot\nagent: claude-opus\nproject_dir: #{sentinel_dir}\n",
      "open"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_paused_icloud_sentinel,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # `:dbg` (runtime_tools) ships on-disk with the OTP install but, unlike
    # :logger/etc, isn't automatically on this project's code path — locate
    # and add it so the real stdlib :dbg tracer is usable without touching
    # mix.exs.
    [runtime_tools_ebin] =
      :code.root_dir()
      |> to_string()
      |> Path.join("lib/runtime_tools-*/ebin")
      |> Path.wildcard()

    :code.add_pathz(String.to_charlist(runtime_tools_ebin))
    {:ok, _} = Application.ensure_all_started(:runtime_tools)

    test_pid = self()

    # Called via apply/3 (not a compile-time :dbg.foo(...) call) because :dbg
    # only lands on the code path above, at runtime — the compiler can't see
    # it ahead of time and mix's --warnings-as-errors would otherwise choke
    # on "module :dbg is not available".
    apply(:dbg, :tracer, [
      :process,
      {fn msg, n ->
         send(test_pid, {:dbg_relay, msg})
         n + 1
       end, 0}
    ])

    apply(:dbg, :p, [poller, [:call]])
    apply(:dbg, :tpl, [File, :dir?, :x])

    on_exit(fn -> apply(:dbg, :stop_clear, []) end)

    sync_poll_cycle!(poller)
    stat_calls = drain_dbg_relay!(poller)

    refute Enum.any?(stat_calls, fn
             {:trace, _pid, :call, {File, :dir?, [^sentinel_dir]}} -> true
             _ -> false
           end),
           "poller must not stat a paused fiber's project_dir " <>
             "(the status gate must run before the filesystem gate)"

    refute Enum.any?(
             Poller.snapshot(poller).eligible,
             &(&1.fiber_id == "tests/paused-icloud-sentinel")
           )
  end

  test "a standing worker exit DOES close the role to awaiting-review (status:closed)" do
    # A STANDING (cron) worker's exit marks it awaiting, so the cron does not re-fire it this cycle.
    # This is what guards the gate against being broadened to skip standing too.
    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    fiber_id = "tests/standing-exit-closes"
    leaf = fiber_id |> String.split("/") |> List.last()
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * *"
        tz: Europe/Paris
      """,
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_exit_closes,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    end_worker_session(poller, fiber_id)
    _ = Poller.snapshot(poller)

    doc = File.read!("#{MockRunner.felt_dir()}/#{fiber_id}/#{leaf}.md")
    assert doc =~ ~r/status:\s*closed/
  end

  # Inject a running entry with a chosen start time, then deliver a worker exit —
  # the precise input the breaker keys on (a oneshot exit and its lifetime),
  # without the dispatch/watcher/resume machinery that makes a full
  # spawn→kill→resume loop nondeterministic under the mock runner.
  defp simulate_exit(poller, fiber_id, lifetime_seconds) do
    started = DateTime.add(DateTime.utc_now(), -lifetime_seconds, :second)
    watcher = spawn(fn -> :ok end)

    :sys.replace_state(poller, fn state ->
      meta = %{
        fiber_id: fiber_id,
        session: FiberUid.session(fiber_id),
        agent_id: "claude-sonnet",
        uid: FiberUid.for(fiber_id),
        started_at: started,
        last_activity_at: started,
        pid: watcher
      }

      %{
        state
        | running: Map.put(state.running, FiberUid.for(fiber_id), meta)
      }
    end)

    notify_worker_exit(poller, fiber_id)
    # Synchronous call flushes the exit message (mailbox order) before we read.
    _ = Poller.snapshot(poller)
  end

  defp loop_blocked?(poller, fiber_id) do
    Enum.any?(Poller.snapshot(poller).blocked, fn b ->
      b.fiber_id == fiber_id and b.reason =~ "resume_loop"
    end)
  end

  test "resume-loop breaker pauses a oneshot whose workers keep dying instantly, and force-dispatch overrides it" do
    # The kill-and-resume churn: a still-active oneshot whose worker dies almost
    # immediately (stale/unresumable session, wrong project_dir, TCC-blocked cwd)
    # is re-dispatched every poll, dying again each time — observed as 125 resumes
    # of one fiber in a day. After @resume_loop_max_rapid_exits consecutive rapid
    # exits the breaker opens: the fiber goes ineligible (surfaced as `blocked`)
    # until a cooldown or a human force-dispatch. Reverting the eligible? guard or
    # note_worker_lifetime re-arms the infinite loop.
    fiber_id = "tests/resume-loop-breaker"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    # max_concurrent_workers: 0 disables the autonomous tick's dispatch (the
    # first poll fires at 0ms and would otherwise spawn a real worker mid-test);
    # explicit Poller.dispatch_fiber/3 is not slot-gated, so the breaker path is
    # still fully exercised.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_loop_breaker,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # Four rapid (0s-lifetime) exits — one short of tripping; breaker stays closed.
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)
    refute loop_blocked?(poller, fiber_id)

    # The fifth rapid exit opens the breaker: now blocked, and an autonomous
    # (non-force) dispatch is refused.
    simulate_exit(poller, fiber_id, 0)
    assert loop_blocked?(poller, fiber_id)
    assert {:error, _} = Poller.dispatch_fiber(poller, fiber_id, [])

    # A human force-dispatch is an explicit "go": it clears the breaker and spawns.
    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute loop_blocked?(poller, fiber_id)
  end

  test "a refused wrapper preflight parks the fiber instead of re-probing every tick" do
    # The preflight closed the silent failure, but it also removed that failure's
    # only brake: the resume-loop breaker counts worker EXITS, and a refused
    # dispatch never spawns a worker to exit. Left ungated, a host whose wrapper
    # is missing would spawn a fresh `bash -l` for every fiber on every tick —
    # synchronously, inside this GenServer — forever. So a refusal parks the
    # fiber for @preflight_cooldown_ms.
    fiber_id = "tests/preflight-cooldown"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")
    MockRunner.set_wrapper_missing(true)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_preflight_cooldown,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:error, {:wrapper_unresolved, message}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    # It surfaces on the board carrying the message that names the fix — not an
    # inspected tuple.
    blocked =
      Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))

    assert blocked.reason == message
    assert blocked.reason =~ "did not resolve"

    # Parked: a second autonomous (non-force) dispatch is refused by the
    # cooldown WITHOUT spending another login shell. The probe count not moving
    # is the whole point of the gate.
    probes_before =
      Enum.count(MockRunner.commands(), &match?({"bash", ["-lc", _]}, &1))

    assert {:error, _} = Poller.dispatch_fiber(poller, fiber_id, [])

    assert Enum.count(MockRunner.commands(), &match?({"bash", ["-lc", _]}, &1)) ==
             probes_before

    # A human force-dispatch is an explicit "go" and bypasses the cooldown —
    # it still refuses (the wrapper is still missing) but it did re-probe,
    # which is what lets an operator retry the instant they fix it.

    assert {:error, {:wrapper_unresolved, _}} =
             Poller.dispatch_fiber(poller, fiber_id, force: true)

    probes_after = Enum.count(MockRunner.commands(), &match?({"bash", ["-lc", _]}, &1))
    assert probes_after > probes_before

    # And once the wrapper is installed, a successful dispatch clears the entry.
    MockRunner.set_wrapper_missing(false)
    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute Enum.any?(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
  end

  # The kitty seam with nobody home: no live remote-control socket, so on macOS
  # there is no way to get a tmux server that the daemon is not the root of.
  defmodule NoKitty do
    def run_background(_argv, _runner), do: {:error, "no live kitty remote-control socket"}
  end

  test "a refused tmux-server preflight parks the fiber for the cooldown" do
    # macOS only: a dispatch with no tmux server and no reachable kitty must
    # refuse rather than fork the server under the daemon (TCC would then charge
    # every worker's file access to the daemon binary). Like the wrapper
    # refusal, it never spawns a worker to exit, so the resume-loop breaker
    # cannot brake it — the preflight cooldown has to.
    fiber_id = "tests/tmux-server-cooldown"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    Env.put_app_env(:os_type, {:unix, :darwin})
    Env.put_app_env(:kitty_impl, NoKitty)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_tmux_server_cooldown,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # The boot cycle's own `tmux ls` lands before the probe count below.
    settle_poller!(poller)
    MockRunner.set_tmux_server_missing(true)

    assert {:error, {:tmux_server_unavailable, message}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    # The board shows the operator-facing message verbatim — the human's only
    # other clue is a stream of "erlexec" prompts that names nothing they own.
    blocked = Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
    assert blocked.reason == message
    assert blocked.reason =~ "erlexec"

    # Parked: the next autonomous attempt is refused by the cooldown without
    # spending another `tmux ls` / kitty round trip — and an explicit dispatch
    # during the cooldown still says WHY. Reporting "not yet due" here (the old
    # behaviour) pointed the human at the schedule for the whole five minutes,
    # while the real answer was already recorded.
    probes_before = Enum.count(MockRunner.commands(), &match?({"tmux", ["ls" | _]}, &1))

    assert {:error, {:tmux_server_unavailable, ^message}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    assert Enum.count(MockRunner.commands(), &match?({"tmux", ["ls" | _]}, &1)) == probes_before

    # Once a server exists, a dispatch succeeds and clears the entry.
    MockRunner.set_tmux_server_missing(false)
    assert {:ok, _} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    refute Enum.any?(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
  end

  test "a healthy worker run resets the resume-loop breaker count" do
    # A long-lived run (≥ the rapid-exit threshold) is the system working: it must
    # zero the consecutive-rapid-exit count so a fiber that occasionally has a fast
    # exit between real work never trips.
    fiber_id = "tests/resume-loop-reset"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_loop_reset,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    # 4 rapid exits — one short of tripping.
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)

    # A healthy run lands (lived well past the threshold): clears the count.
    simulate_exit(poller, fiber_id, 3600)

    # 4 more rapid exits still don't trip (the reset means it would take 5 fresh).
    for _ <- 1..4, do: simulate_exit(poller, fiber_id, 0)
    refute loop_blocked?(poller, fiber_id)
  end

  # ── Boot quarantine ──
  #
  # Restart is not dispatch authority: a just-(re)started daemon grants NO
  # autonomous dispatches of any kind (the crash-loop incident: each restart's
  # first poll dispatched every active, host-owned, workerless fiber). While
  # quarantined, the autonomous tick parks EVERY dispatchable candidate —
  # resumes included, since classifying on cached rows let stale rows escape;
  # release is pure manual. config/test.exs disables the quarantine globally,
  # so these tests opt back in via `boot_quarantine: true`.

  test "boot quarantine parks fresh launches and surfaces them as pending_launch" do
    fiber_id = "tests/quarantine-fresh"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_fresh,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    # Parked, not dispatched: the row lands in pending_launch with the
    # quarantine reason, and no tmux session is spawned.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: "boot quarantine — awaiting release"}] =
               Poller.snapshot(poller).pending_launch
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    assert snap.eligible == []

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # The held state reaches the per-fiber feed (board indicator): parked_index
    # is keyed by fiber_id, and put_held stamps the matching feed row `held`.
    index = Poller.parked_index(poller)
    assert %{parked_at: _} = Map.get(index, fiber_id)

    assert %{held: true, held_since: _} =
             Snapshot.put_held(%{fiber: %{"id" => fiber_id}}, index)

    refute Map.has_key?(Snapshot.put_held(%{fiber: %{"id" => "tests/not-held"}}, index), :held)
  end

  test "boot quarantine parks an on-disk resume marker the daemon never observed running" do
    # A dispatched_at with no newer handed_off_at LOOKS like a dirty-death
    # resume, but the quarantine gate keys off runtime observation
    # (`was_running`), NOT the on-disk marker. This daemon never saw a live
    # worker for the fiber (no adopted session), so its marker is exactly the
    # stale-row case the earlier resume exemption let escape: it is parked, not
    # dispatched. Only work the daemon actually observed running auto-resumes
    # (see the was-running test below).
    fiber_id = "tests/quarantine-dirty-resume"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    write_dispatch_marker(fiber_id, "b1e0a3c2-0000-4000-8000-000000000001")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_resume,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    # Parked like any other candidate — no session spawned, quarantine intact.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: "boot quarantine — awaiting release"}] =
               Poller.snapshot(poller).pending_launch
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    assert snap.eligible == []

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "boot quarantine does NOT park work it observed running; a was-running fiber re-dispatches on exit" do
    # The core of the fix: in-flight work the daemon observed running under its
    # own uptime auto-resumes even while quarantined — only genuinely-fresh
    # launches are held. Field scenario reproduced: a oneshot whose worker was
    # adopted at boot, then exits mid-uptime, must re-dispatch, not park.
    fiber_id = "tests/quarantine-was-running"
    session = FiberUid.session(fiber_id)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    # Live worker present at boot → adopt_orphans adopts it (adoption runs
    # regardless of quarantine), so its runtime key enters the durable
    # `was_running` set.
    MockRunner.add_tmux_session(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_was_running,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    # Adopted as running while quarantined (not parked): observed-running now
    # carries this fiber's key, and nothing is in pending_launch.
    assert_eventually(fn ->
      state = :sys.get_state(poller, @state_timeout)
      assert MapSet.member?(state.was_running, FiberUid.for(fiber_id))
      assert Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
    end)

    assert Poller.snapshot(poller).pending_launch == []

    # Worker exits mid-uptime; the next poll reconciles the missing session
    # (drops it from running, releases the claim) → the fiber is a candidate
    # again. Was-running membership survives the exit, so it re-dispatches.
    MockRunner.remove_tmux_session(session)
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    refute Enum.any?(snap.pending_launch, &(&1.fiber_id == fiber_id))
  end

  test "boot quarantine does NOT park a due standing role (cron is the human's pre-given go)" do
    # Field scenario: a deploy restarted the daemon overnight and nobody ran
    # `shuttle daemon release`; the 09:00 monthly and weekly roles were parked
    # and silently missed their runs. A cron occurrence is bounded and
    # human-authorized at a fixed time, so it flows through the quarantine.
    fiber_id = "tests/quarantine-standing"

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      review:
        state: scheduled
      """
    )

    now = DateTime.utc_now()
    set_resolved_occurrences(fiber_id, now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_standing,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, state: "running"}] = Poller.snapshot(poller).eligible
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == true
    assert snap.pending_launch == []
  end

  test "quarantine parking is rebuilt every cycle even when all slots are full" do
    # Parking is dispatch-authority bookkeeping, not capacity accounting: the
    # parked map used to be rebuilt only inside the `available_slots > 0`
    # gate, so with slots full a closed fiber kept its stale pending_launch
    # row and newly-eligible work never surfaced. Rebuild must run every
    # cycle; only actual dispatching is slot-gated.
    fiber_id = "tests/quarantine-slots-full"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_slots_full,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    # Parked despite zero slots — the bookkeeping runs regardless of capacity.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    # The fiber closes; the next cycle (slots still full) rebuilds the parked
    # map and the stale row drops out.
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "closed"}))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle(), "closed")
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Poller.snapshot(poller).pending_launch == []
    end)
  end

  test "releasing the boot quarantine dispatches the parked launches" do
    fiber_id = "tests/quarantine-release"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_release,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    # The human "go": clears the flag + parked set and ticks immediately, so
    # the fiber dispatches without waiting out the poll interval. Idempotent.
    assert :ok = Poller.release_boot_quarantine(poller)
    assert :ok = Poller.release_boot_quarantine(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).eligible
    end)

    snap = Poller.snapshot(poller)
    assert snap.boot_quarantine == false
    assert snap.pending_launch == []
  end

  test "force-dispatch bypasses the boot quarantine and does not clear it" do
    fiber_id = "tests/quarantine-force"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    # max_concurrent_workers: 0 disables the autonomous tick's dispatch;
    # explicit Poller.dispatch_fiber/3 is not slot-gated, so only the manual
    # path is exercised here.
    {:ok, poller} =
      start_poller!(
        name: :test_poller_quarantine_force,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    # First a poll parks it as a fresh launch (held): the autonomous tick's
    # parking is not slot-gated, so it runs even with 0 worker slots.
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert %{parked_at: _} = Map.get(Poller.parked_index(poller), fiber_id)
    end)

    # The human clicked dispatch: honor the intent — but one manual "go" on one
    # fiber is not a bulk release; the quarantine stays up for everything else.
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert Poller.snapshot(poller).boot_quarantine == true

    # Held clears the instant the worker exists — synchronously, not a poll cycle
    # later — so the card never co-renders the held and "aloft" pills.
    refute Map.has_key?(Poller.parked_index(poller), fiber_id)
  end

  # The heartbeat writer is linked to its Poller, but the exit signal lands
  # asynchronously: a write in flight can finish its `mkdir_p` while the data
  # dir is being removed. Retry until the tree stays gone.
  defp rm_rf_settled!(dir, tries \\ 20) do
    case File.rm_rf(dir) do
      {:ok, _} ->
        :ok

      {:error, _, _} when tries > 0 ->
        Process.sleep(50)
        rm_rf_settled!(dir, tries - 1)

      {:error, reason, file} ->
        raise File.Error,
          reason: reason,
          action: "remove files and directories recursively from",
          path: file
    end
  end

  # ── Boot-quarantine auto-release (daemon heartbeat continuity) ──
  #
  # A kernel that kills the beam on a CPU rlimit is not a human asking for a
  # hold, but every (re)start arms the quarantine — so a kill nobody asked for
  # silently stopped all new work until someone noticed. `Shuttle.DaemonHeartbeat`
  # gives the daemon evidence about its own previous incarnation, and
  # `Poller.init/1` releases the hold IFF that evidence proves a fast bounce:
  # fresh heartbeat, the recorded workers still live BY THIS DAEMON'S OWN
  # adoption, and no crash loop. Everything else — a real gap, a loop, a
  # missing/garbage file, a contract skew — still holds. These tests are the
  # boundary in both directions; the value of the change is entirely there.

  # Under this test's throwaway SHUTTLE_DATA_DIR (the suite-wide pin is dropped
  # in setup), so it is cleaned up with the rest of the markers.
  defp heartbeat_file, do: Path.join(Shuttle.Env.get("SHUTTLE_DATA_DIR"), "heartbeat.json")

  # A heartbeat that would auto-release on its own, with `fields` merged over:
  # written 4s ago by an incarnation that had been up half an hour, one boot in
  # the ring, and no workers recorded.
  defp write_heartbeat!(fields \\ %{}) do
    now = System.system_time(:millisecond)
    booted_at = now - 1_800_000

    record =
      Map.merge(
        %{
          "v" => 1,
          "host" => System.fetch_env!("SHUTTLE_HOST"),
          "node" => Shuttle.DaemonHeartbeat.node_name(),
          "held" => false,
          # Not this test VM's pid: these records stand in for a previous VM.
          "os_pid" => "0",
          "at" => now - 4_000,
          "booted_at" => booted_at,
          "workers" => [],
          "boots" => [booted_at]
        },
        fields
      )

    path = heartbeat_file()
    File.write!(path, Jason.encode!(record))
    path
  end

  defp start_quarantined_poller!(name, opts \\ []) do
    [
      name: name,
      runner: MockRunner,
      poll_interval_ms: 60_000,
      felt_stores: [MockRunner.felt_root()],
      boot_quarantine: true,
      quarantine_auto_release: true,
      daemon_heartbeat_file: heartbeat_file()
    ]
    |> Keyword.merge(opts)
    |> start_poller!()
  end

  # The fresh candidate every test below watches: parked while the hold stands,
  # dispatched the moment it is lifted.
  defp fresh_candidate!(fiber_id) do
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    fiber_id
  end

  # Every snapshot read in this section uses a generous call timeout: the poller
  # shells felt synchronously while dispatching, and on a loaded host that pushes
  # a default 5s `GenServer.call` past its ceiling — which fails the test for a
  # reason that has nothing to do with the quarantine.
  defp hb_snapshot(poller), do: Poller.snapshot(poller, 30_000)

  # Did a worker actually launch for `fiber_id`? Read from the recorded commands
  # rather than the poller's state, so the check never waits on the GenServer
  # that is busy doing the launching. That GenServer shells felt synchronously
  # per candidate, which on a loaded host takes seconds; `wait_until`'s ceiling
  # absorbs it and returns the instant the launch lands.
  defp assert_launched!(fiber_id) do
    session = FiberUid.session(fiber_id)

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session" and session in args
             end)
           end)
  end

  # Both directions assert on the SAME two observables, so a hold and a release
  # can't be confused for one another: the flag, and whether the fresh candidate
  # actually launched.
  defp assert_held!(poller, fiber_id) do
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = hb_snapshot(poller).pending_launch
    end)

    snap = hb_snapshot(poller)
    assert snap.boot_quarantine == true

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    snap
  end

  # Kill `poller` hard, then stand its last heartbeat in for a long,
  # healthy-looking uptime that ended seconds ago, with `fields` merged over.
  defp hard_kill_after_long_run!(poller, fields \\ %{}) do
    ref = Process.monitor(poller)
    Process.exit(poller, :kill)
    assert_receive {:DOWN, ^ref, :process, ^poller, :killed}

    {:ok, hb} = DaemonHeartbeat.read(heartbeat_file())
    now = System.system_time(:millisecond)

    record =
      hb
      |> Map.merge(%{"at" => now - 4_000, "booted_at" => now - 1_800_000})
      |> Map.merge(fields)

    File.write!(heartbeat_file(), Jason.encode!(record))
  end

  test "a fast bounce with its workers still alive auto-releases the boot quarantine" do
    # The whole point: the daemon was killed seconds ago, its worker is still in
    # tmux and gets adopted, so the fresh candidate launches without a human.
    live_id = "tests/hb-live"
    session = FiberUid.session(live_id)
    MockRunner.set_shuttle(live_id, oneshot_shuttle())
    MockRunner.add_tmux_session(session)

    fresh_id = fresh_candidate!("tests/hb-fresh")
    write_heartbeat!(%{"workers" => [FiberUid.for(live_id)]})

    {:ok, poller} = start_quarantined_poller!(:test_poller_hb_fast_bounce)
    # Nudge a cycle rather than relying on the boot tick alone, and nudge it
    # with a message rather than a call: the assertions below must not queue
    # behind the poller while it is shelling felt to launch.
    sync_poll_cycle!(poller)

    # The launch itself is the proof the hold is off, and reading it from the
    # recorded commands never waits on the busy poller.
    assert_launched!(fresh_id)

    snap = hb_snapshot(poller)
    assert snap.boot_quarantine == false
    assert snap.pending_launch == []
  end

  test "an idle fast bounce (no workers recorded) auto-releases" do
    # Nothing was running and the previous incarnation had been released, so
    # an empty recorded set is continuous.
    fresh_id = fresh_candidate!("tests/hb-idle")
    write_heartbeat!()

    {:ok, poller} = start_quarantined_poller!(:test_poller_hb_idle)
    sync_poll_cycle!(poller)

    assert_launched!(fresh_id)
    assert hb_snapshot(poller).boot_quarantine == false
  end

  test "an unreleased hold survives a hard kill (a held incarnation's heartbeat never releases)" do
    # The laundering case: an incarnation boots held (after an outage or a
    # deploy) and nobody releases it. It keeps writing fresh heartbeats with no
    # workers, since nothing dispatches while held. A hard kill after a long run
    # must not turn that into a release of the work it was holding back.
    fiber_id = fresh_candidate!("tests/hb-launder")
    refute File.exists?(heartbeat_file())

    {:ok, first} = start_quarantined_poller!(:test_poller_hb_launder_1)

    assert_eventually(fn ->
      assert {:ok, %{"held" => true}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    # A different VM, so the pid check is not what holds here.
    hard_kill_after_long_run!(first, %{"os_pid" => "0"})

    {:ok, second} = start_quarantined_poller!(:test_poller_hb_launder_2)
    send(second, :run_poll_cycle)

    assert_held!(second, fiber_id)
  end

  test "work parked behind a contract skew survives a human release and a hard kill" do
    # The quarantine was released by a human, but the skew kept parking fresh
    # work, so the incarnation was still holding it back. Once the CLI is fixed
    # the next boot must not release that backlog on a hard kill.
    MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))
    fiber_id = fresh_candidate!("tests/hb-skew-release")
    {:ok, first} = start_quarantined_poller!(:test_poller_hb_skew_release_1)
    assert :ok = Poller.release_boot_quarantine(first)

    assert_eventually(fn ->
      assert {:ok, %{"held" => true}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    hard_kill_after_long_run!(first, %{"os_pid" => "0"})

    MockRunner.set_contract_level(Integer.to_string(Shuttle.Contract.expected_level()))
    {:ok, second} = start_quarantined_poller!(:test_poller_hb_skew_release_2)
    send(second, :run_poll_cycle)

    assert_held!(second, fiber_id)
  end

  test "a Poller restart inside a live VM holds, even after a human release" do
    # No hard kill happened: the supervisor restarted the Poller. The record
    # is released, fresh and long-run, but its OS pid is this VM's.
    fiber_id = fresh_candidate!("tests/hb-poller-restart")
    {:ok, first} = start_quarantined_poller!(:test_poller_hb_restart_1)
    assert :ok = Poller.release_boot_quarantine(first)

    assert_eventually(fn ->
      assert {:ok, %{"held" => false}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    hard_kill_after_long_run!(first)

    MockRunner.reset()
    fresh_candidate!(fiber_id)

    {:ok, second} = start_quarantined_poller!(:test_poller_hb_restart_2)
    send(second, :run_poll_cycle)

    assert_held!(second, fiber_id)
  end

  test "a human release is recorded in the heartbeat at once" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_hb_release_write,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true,
        daemon_heartbeat_file: heartbeat_file(),
        daemon_heartbeat_interval_ms: 3_600_000
      )

    assert_eventually(fn ->
      assert {:ok, %{"held" => true}} = DaemonHeartbeat.read(heartbeat_file())
    end)

    assert :ok = Poller.release_boot_quarantine(poller)
    # The hour-long interval rules out the timer: only the release wrote this.
    assert_eventually(fn ->
      assert {:ok, %{"held" => false}} = DaemonHeartbeat.read(heartbeat_file())
    end)
  end

  # Every way the evidence can fall short of a fast bounce, one row each, all
  # judged by the same act and the same observables (`assert_held!/2`, then
  # the parked row's reason, the contract verdict and whether the boot scan
  # completed). A row arranges only what differs from a releasable boot: the
  # `heartbeat` on disk (fields merged over `write_heartbeat!/1`'s, with times
  # given as ms before now; `:missing`; or a raw `{:body, _}`), a stop marker
  # beside it, the Poller's own options, and what the runner reports. Its
  # `expect` overrides `@held_expectations` where it differs from a plain hold.
  @held_expectations [
    reason: ~r/\Aboot quarantine — awaiting release\z/,
    contract_ok: true,
    adopted?: true
  ]

  @unreleasable_boots [
    # A deploy or operator restart: fresh, released, long-run — everything a
    # hard kill would look like, except the stop marker its SIGTERM left.
    {"a gracefully stopped previous incarnation (stop marker)", stop_marker: true},
    {"a host that has not opted in, even on a provable hard-kill bounce",
     poller: [quarantine_auto_release: false]},
    # Five minutes of silence: far past the 60s grace, so the daemon has no
    # evidence the gap was short.
    {"a stale heartbeat (a real outage)", heartbeat: %{"at" => 300_000}},
    # The case freshness CANNOT catch: a daemon dying every few seconds has a
    # heartbeat that is always fresh. The recorded boot time is what exposes it.
    {"a crash loop (fresh heartbeat, short-lived previous incarnation)",
     heartbeat: %{"at" => 2_000, "booted_at" => 12_000, "boots" => [12_000]}},
    # The coarse brake: every incarnation lived just past the healthy-run
    # threshold, so the per-incarnation check passes — but the daemon has come
    # back five times in ten minutes (this boot included), which is a human's
    # problem, not new work's.
    {"too many recent boots, even when each incarnation looked healthy",
     heartbeat: %{
       "at" => 3_000,
       "booted_at" => 103_000,
       "boots" => [403_000, 303_000, 203_000, 103_000]
     }},
    # Fresh and loop-free, but the workers it vouched for are not in tmux — so
    # something ended them too, and this is not the fast bounce it looks like.
    # Continuity is established by adoption, never by trusting the file.
    {"a heartbeat whose recorded workers are gone",
     heartbeat: %{"workers" => ["tests/hb-ghost"]}},
    {"a missing heartbeat file (fail closed)", heartbeat: :missing},
    # A kill mid-write is exactly what this daemon is exposed to, so the parse
    # has to survive garbage — and a file that says the right keys with the
    # wrong types is no better evidence than one that says nothing.
    {"a truncated heartbeat file", heartbeat: {:body, ~s({"v":1,"at":17)}},
    {"a heartbeat that is not an object", heartbeat: {:body, ~s(["at", 17])}},
    {"a heartbeat with the right keys of the wrong types",
     heartbeat: {:body, ~s({"v":1,"at":"soon","booted_at":null,"workers":"nope"})}},
    {"an empty heartbeat file", heartbeat: {:body, ""}},
    # An empty recorded set is vacuously continuous, so the verdict alone would
    # release. It must not: without a completed adoption scan the daemon has not
    # observed what is live, and the `adopted?` guard fails the release closed.
    {"a boot whose tmux scan is unknown",
     runner: [tmux_server_missing: true, ps_fails: true], expect: [adopted?: false]},
    # Skew has no release endpoint by design: every shelled write is suspect, so
    # the auto-release must not become a back door into dispatching under one.
    # It names itself over the quarantine it rides on: the more actionable fix.
    {"a contract skew",
     runner: [contract_skew: true], expect: [reason: ~r/\Acontract skew — /, contract_ok: false]}
  ]

  for {{label, row}, index} <- Enum.with_index(@unreleasable_boots) do
    @row row
    @index index
    test "the boot quarantine holds on #{label}" do
      fiber_id = fresh_candidate!("tests/hb-hold-#{@index}")
      arrange_unreleasable_boot!(@row)

      {:ok, poller} =
        start_quarantined_poller!(
          :"test_poller_hb_hold_#{@index}",
          Keyword.get(@row, :poller, [])
        )

      sync_poll_cycle!(poller)

      snap = assert_held!(poller, fiber_id)
      assert Process.alive?(poller)

      expect = Keyword.merge(@held_expectations, Keyword.get(@row, :expect, []))
      assert [%{reason: reason}] = snap.pending_launch
      assert reason =~ expect[:reason]
      assert snap.contract.ok == expect[:contract_ok]
      assert :sys.get_state(poller, @state_timeout).adopted? == expect[:adopted?]
    end
  end

  defp arrange_unreleasable_boot!(row) do
    runner = Keyword.get(row, :runner, [])
    if runner[:tmux_server_missing], do: MockRunner.set_tmux_server_missing(true)
    if runner[:ps_fails], do: MockRunner.set_ps_result({"ps: boom", 1})

    if runner[:contract_skew],
      do: MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))

    case Keyword.get(row, :heartbeat, %{}) do
      :missing ->
        refute File.exists?(heartbeat_file())

      {:body, body} ->
        File.write!(heartbeat_file(), body)

      %{} = ago ->
        now = System.system_time(:millisecond)

        ago
        |> Map.new(fn
          {key, ms} when key in ["at", "booted_at"] -> {key, now - ms}
          {"boots", boots} -> {"boots", Enum.map(boots, &(now - &1))}
          other -> other
        end)
        |> write_heartbeat!()
    end

    if row[:stop_marker], do: :ok = DaemonHeartbeat.mark_stopped(heartbeat_file())
  end

  test "the daemon writes its own heartbeat while healthy" do
    # The other half of the contract: the evidence the next boot reads is
    # written by this one, at boot and then on its own interval, carrying this
    # incarnation's boot time, its live workers, and the boot ring it inherited.
    live_id = "tests/hb-writer-live"
    session = FiberUid.session(live_id)
    MockRunner.set_shuttle(live_id, oneshot_shuttle())
    MockRunner.add_tmux_session(session)

    previous_boot = System.system_time(:millisecond) - 1_800_000
    write_heartbeat!(%{"boots" => [previous_boot]})

    {:ok, poller} =
      start_poller!(
        name: :test_poller_hb_writer,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()],
        daemon_heartbeat_file: heartbeat_file(),
        daemon_heartbeat_interval_ms: 25
      )

    assert_eventually(fn ->
      assert {:ok, hb} = Shuttle.DaemonHeartbeat.read(heartbeat_file())
      # This incarnation's own boot time, appended to the inherited ring.
      assert hb["boots"] == [
               previous_boot,
               :sys.get_state(poller, @state_timeout).daemon_booted_at
             ]

      assert hb["booted_at"] == :sys.get_state(poller, @state_timeout).daemon_booted_at
      assert FiberUid.for(live_id) in hb["workers"]
      # Stamped with this daemon's fleet identity and this machine's node name.
      assert hb["host"] == :sys.get_state(poller, @state_timeout).own_host_id
      assert hb["node"] == Shuttle.DaemonHeartbeat.node_name()
      assert hb["os_pid"] == System.pid()
      # And it keeps writing: `at` advances past the boot write.
      assert hb["at"] > hb["booted_at"]
    end)
  end

  # ── CLI/daemon contract handshake ──
  #
  # `Shuttle.Poller.init/1` shells `shuttle contract` once and compares it
  # to `Shuttle.Contract.expected_level/0`. A mismatch or unparseable/nonzero
  # exit, including an unknown subcommand, rides the same dispatch gate
  # as boot quarantine: fresh launches park, already-observed work still
  # resumes, and the reason surfaces on `snapshot().contract` /
  # `pending_launch`. `config/test.exs` disables `boot_quarantine`, so these
  # tests exercise the skew gate in isolation from it.

  # A CLI level the daemon does not expect.
  defp skewed_contract_level, do: Shuttle.Contract.expected_level() + 1

  test "a matching contract level dispatches normally and reports ok in the snapshot" do
    MockRunner.set_contract_level(Integer.to_string(Shuttle.Contract.expected_level()))
    fiber_id = "tests/contract-match"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_match,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    level = Shuttle.Contract.expected_level()

    assert Poller.snapshot(poller).contract == %{
             expected: level,
             observed: level,
             ok: true,
             reason: nil
           }

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    assert Poller.snapshot(poller).pending_launch == []
  end

  test "a mismatched contract level holds fresh launches and surfaces the skew" do
    MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))
    fiber_id = "tests/contract-mismatch"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_mismatch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    snap = Poller.snapshot(poller)

    level = Shuttle.Contract.expected_level()
    skewed = skewed_contract_level()
    assert %{expected: ^level, observed: ^skewed, ok: false, reason: reason} = snap.contract
    assert reason =~ "expected contract level #{level}"
    assert reason =~ "CLI reports #{skewed}"

    sync_poll_cycle!(poller)

    # Held, not dispatched: parked as a pending_launch with the skew reason,
    # and no tmux session spawned — same shape as a boot-quarantine park.
    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, reason: parked_reason}] =
               Poller.snapshot(poller).pending_launch

      assert parked_reason =~ "contract skew"
      assert parked_reason =~ "CLI reports #{skewed}"
    end)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "unparseable contract output (unknown subcommand) is treated as skew, not a crash" do
    # When `shuttle contract` is unavailable, the CLI exits nonzero with usage
    # text on stdout. The daemon cannot determine the level, so it treats that
    # shape as incompatible, just like an explicit mismatch.
    MockRunner.set_contract_level("Error: unknown command \"contract\"", 1)
    fiber_id = "tests/contract-garbage"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_garbage,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    level = Shuttle.Contract.expected_level()
    assert %{expected: ^level, ok: false} = Poller.snapshot(poller).contract

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id}] = Poller.snapshot(poller).pending_launch
    end)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a contract skew does not strand work observed running; a was-running fiber still resumes" do
    # Same was-running exemption as boot quarantine: skew means "no NEW
    # autonomous work", not "abandon what's alive". A worker this daemon
    # observed running (adopted at boot) must still re-dispatch on exit.
    MockRunner.set_contract_level(Integer.to_string(skewed_contract_level()))
    fiber_id = "tests/contract-skew-was-running"
    session = FiberUid.session(fiber_id)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    MockRunner.add_tmux_session(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_contract_skew_was_running,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert_eventually(fn ->
      state = :sys.get_state(poller, @state_timeout)
      assert MapSet.member?(state.was_running, FiberUid.for(fiber_id))
      assert Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
    end)

    assert Poller.snapshot(poller).pending_launch == []

    MockRunner.remove_tmux_session(session)
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end)

    snap = Poller.snapshot(poller)
    refute snap.contract.ok
    refute Enum.any?(snap.pending_launch, &(&1.fiber_id == fiber_id))
  end

  test "poller does not dispatch a scheduled standing role before it is due" do
    fiber = make_fiber("tests/standing-sleeping", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-sleeping", fiber)

    # Slice 2: the dispatch gate is the cron schedule vs now (the stored
    # next_due_at no longer gates). A weekday-09:00 Paris schedule fires no tick
    # inside the poll window during a test run, so the role is not due. The future
    # next_due_at remains only to keep the display path (`due?`) reading
    # `scheduled`.
    MockRunner.set_shuttle(
      "tests/standing-sleeping",
      """
      enabled: true
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    # Just serviced (a "worker dispatched" event at ~now): under the one due rule,
    # a role is due only once a scheduled occurrence elapses AFTER its last
    # service, so a freshly-serviced weekday-09:00 role is not due now. felt's
    # prev_due (the last weekday-09:00 tick) sits before this service; next_due is
    # the future tick → valid (so the snapshot reads "scheduled", not invalid).
    write_dispatch_marker("tests/standing-sleeping", "seed-recent")

    set_resolved_occurrences(
      "tests/standing-sleeping",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_sleeping,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert [%{fiber_id: "tests/standing-sleeping", state: "scheduled"}] =
             Poller.snapshot(poller).standing_roles
  end

  test "poller surfaces a standing-role snapshot from the document (no runtime store)" do
    fiber_id = "tests/standing-lifecycle-persist"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    # The standing role is read straight from the document, with no runtime
    # store. Phase is schedule-derived; awaiting/accepted are document facts
    # (status:closed/tempered), not stored.
    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """
    )

    # Recently serviced ⇒ not due now (so it stays scheduled, not running). felt
    # resolves a valid schedule (last tick before this service, next in the
    # future) so the snapshot reads a genuine valid-but-sleeping role, not an
    # invalid one.
    write_dispatch_marker(fiber_id, "seed-recent")
    set_resolved_occurrences(fiber_id, ~U[2026-05-01 09:00:00Z], ~U[2999-01-01 09:00:00Z])

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_lifecycle_persist,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The schedule-derived snapshot state is scheduled or due (cron + now), never
    # a review-derived "review"/"accepted".
    assert wait_until(fn ->
             match?([%{fiber_id: ^fiber_id}], Poller.snapshot(poller).standing_roles)
           end)

    assert [%{fiber_id: ^fiber_id, state: state}] = Poller.snapshot(poller).standing_roles
    assert state in ["scheduled", "due"]
  end

  # A status:active standing role dispatches off the cron schedule read straight
  # from the document, with no runtime overlay. An every-minute
  # schedule is reliably due now regardless of wall-clock.
  test "a status:active standing role dispatches off the cron schedule" do
    fiber_id = "tests/standing-wedge"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      """
    )

    # An every-minute schedule's most recent tick is ~now; with no prior service
    # (last_serviced = created_at, old) that elapsed occurrence makes it due.
    now = DateTime.utc_now()
    set_resolved_occurrences(fiber_id, now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_wedge,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: ^fiber_id, state: "running"}] = Poller.snapshot(poller).eligible
    end)
  end

  test "an awaiting-review (status:closed) standing role is NOT relaunched even with an elapsed occurrence" do
    # Cail's rule, the other half of catch-up: a role that ran is awaiting review
    # (status:closed) until a human tempers (accepts) it. Catch-up must never
    # resurrect it — eligible?'s status gate excludes closed before the due rule
    # is ever consulted. Every-minute schedule ⇒ an occurrence has certainly
    # elapsed since the fixed past created_at, so only the closed gate stops it.
    fiber_id = "tests/standing-awaiting-no-relaunch"

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"status" => "closed", "tags" => ["constitution", "standing"]})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_awaiting_no_relaunch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # Awaiting is a DOCUMENT fact (status:closed + untempered), not a runtime-store
  # review row (slices 4/6). Action resolution reads the document straight — so
  # `accept-run` is available on a closed+untempered standing role (the kanban
  # "temper the weekly arXiv role" gesture re-arms it).
  test "actions reflect doc awaiting (status:closed + untempered) for a standing role" do
    fiber_id = "tests/standing-actions-overlay"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    # The document is the authority: status:closed with no `tempered` is the
    # awaiting signal. No review block anywhere.
    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_actions_overlay,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    query_opts = [felt_stores: [MockRunner.felt_root()], runner: MockRunner]

    assert_eventually(fn ->
      {:ok, actions} = ActionQueries.actions_for(fiber_id, query_opts)
      ids = Enum.map(actions, &(Map.get(&1, :id) || Map.get(&1, "id")))
      assert "accept-run" in ids

      assert {:ok, %{id: "accept-run"}} =
               ActionQueries.resolve_action(fiber_id, "tempered", query_opts)
    end)
  end

  # Accepting a standing run through the Poller re-arms the felt document
  # (status:active, verdict cleared) and that re-arm survives the next poll —
  # there is no runtime cache to clobber it. The document is the truth.
  test "accept through the Poller re-arms the document and survives the next poll" do
    fiber_id = "tests/standing-accept-sticks"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # Awaiting is a document fact (status:closed + untempered). accept re-arms it
    # from the doc schedule (status:active).
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_accept_sticks,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _output} = Poller.lifecycle_transition(poller, :accept, fiber_id)

    # The document is re-armed to status:active.
    armed = File.read!("#{MockRunner.felt_dir()}/#{fiber_id}/standing-accept-sticks.md")
    assert armed =~ "status: active"

    sync_poll_cycle!(poller)

    # Still active after the poll — nothing clobbers the document back to awaiting.
    assert File.read!("#{MockRunner.felt_dir()}/#{fiber_id}/standing-accept-sticks.md") =~
             "status: active"
  end

  # Shuttle writes accept/resume: the Poller shells `shuttle -C <owning store>
  # <verb> <slug> --local` between poll cycles,
  # then re-reads the fiber into its document cache so the board shows the
  # re-arm without waiting for the next poll.
  test "lifecycle_transition shells Shuttle's --local writer and refreshes the document cache" do
    fiber_id = "tests/standing-accept-refresh"
    store = MockRunner.felt_root()

    MockRunner.set_fiber(
      fiber_id,
      make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "closed"})
    )

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_accept_refresh,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [store]
      )

    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).document_cache_ready end)

    assert {:ok, _output} = Poller.lifecycle_transition(poller, :accept, fiber_id)

    assert {"shuttle", ["-C", store, "accept", fiber_id, "--local"]} in MockRunner.commands()

    assert {:ok, body} = Poller.cached_fiber_documents(poller)

    assert %{fiber: %{"status" => "active"}} =
             Enum.find(body.fibers, &(&1.fiber["slug"] == fiber_id))
  end

  test "an accept that lands during a poll read is not clobbered when the poll completes" do
    # Regression for Symptom B of the poll-merge wedge: a standing-role `accept`
    # re-arms the felt document (status:active), but a poll Task already in flight
    # — snapshotted while the role was still the closed (awaiting) document —
    # must not revert the acceptance when it completes. The poll Task only reads;
    # the document is the single source of truth, so the accept stands.
    fiber_id = "tests/standing-accept-during-poll"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # Awaiting is a document fact (status:closed + untempered).
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"], "status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      schedule:
        expr: "0 9 * * 1"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_accept_during_poll,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-accept-during-poll.md"

    # Hold the next poll inside its read-only felt walk; its snapshot still sees
    # the role as the closed (awaiting) document.
    settle_poller!(poller)
    cycles = :sys.get_state(poller, @state_timeout).poll_cycles
    MockRunner.hold_ls()
    send(poller, :run_poll_cycle)
    assert_receive {:ls_held, reader}

    # Accept while the poll is still reading (the GenServer stays responsive).
    assert {:ok, _output} = Poller.lifecycle_transition(poller, :accept, fiber_id)
    assert File.read!(doc_path) =~ "status: active"

    # The held poll completes and applies against current state.
    send(reader, :release_ls)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > cycles end)

    assert File.read!(doc_path) =~ "status: active",
           "a poll completing after the accept reverted the acceptance to awaiting"
  end

  test "direct ad-hoc dispatch creates an ad-hoc standing run before the schedule is due" do
    fiber_id = "tests/standing-force-now"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    # Recently serviced ⇒ the scheduler treats it as not-due, so a plain dispatch
    # is refused; only force/ad-hoc overrides (the point of this test).
    write_dispatch_marker(fiber_id, "seed-recent")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_now,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Enabled standing role whose schedule is far in the future: a plain
    # dispatch is refused as not-yet-due (force/ad_hoc overrides the schedule).
    assert {:error, {:not_eligible, :not_due_or_blocked}} =
             Poller.dispatch_fiber(poller, fiber_id, [])

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    assert session == FiberUid.session(fiber_id)

    assert [%{fiber_id: ^fiber_id, state: "running", run_id: run_id}] =
             Poller.snapshot(poller).eligible

    assert String.starts_with?(run_id, "adhoc-")

    end_worker_session(poller, fiber_id)
    sync_poll_cycle!(poller)

    assert MockRunner.commands()
           |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
           |> length() == 1
  end

  test "ad-hoc dispatch of an awaiting standing role spawns" do
    # Awaiting is represented in the document as status:closed + untempered. Every
    # explicit dispatch carries `force` (the controller folds `force or ad_hoc`;
    # Shuttle.Transition passes both), and force IS the human's "go" from the
    # board (New session / Resume / drag) — so an awaiting role spawns, re-arming
    # the doc on the way (the re-arm itself is exercised in
    # dispatch_integration_test against a real store).
    fiber_id = "tests/standing-awaiting-refuses-adhoc"

    fiber =
      make_fiber(fiber_id, %{
        "status" => "closed",
        "closed-at" => "2026-05-24T10:00:00Z",
        "tags" => ["constitution", "standing"]
      })

    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """,
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_awaiting_refuses_adhoc,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # Forced ad_hoc (the human board action) dispatches the awaiting role.
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "actions/resolve read tmux-live running state, not a stale registry hit" do
    # :dispatch reconciles against tmux before reading state.running,
    # but :actions and :resolve_action used to read the registry raw. So in the
    # window after a worker's session dies (before the poll tick reconciles), a
    # drag→inFlight resolved to `pause` for a worker that no longer exists — and
    # invoke (which reconciles) then 409s. The read legs now derive `running?`
    # from a live tmux check (`live_running?`), matching the dispatch leg —
    # without the eviction side effects (those stay on the poll/dispatch path).
    fiber_id = "tests/reconcile-dead-session"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_reconcile_dead_session,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Let the initial poll auto-dispatch the eligible fiber and settle, so the
    # worker is in state.running and no further poll cycle is queued behind the
    # read legs below. (Driving dispatch via `force:` here instead would race
    # the initial poll's reconcile, which — landing after the kill — would
    # re-dispatch the fiber and re-create a live session.)
    session = FiberUid.session(fiber_id)
    assert wait_until(fn -> Poller.worker_status(poller, fiber_id) != nil end)

    query_opts = [felt_stores: [MockRunner.felt_root()], runner: MockRunner]

    # While the session is live, the running branch is read: inFlight → pause.
    assert {:ok, %{id: "pause"}} = ActionQueries.resolve_action(fiber_id, "inFlight", query_opts)

    # Kill the tmux session WITHOUT a poll tick or :worker_exited message.
    MockRunner.remove_tmux_session(session)

    # The read legs now see the session is gone (live tmux check), so the fiber
    # reads idle and inFlight resolves to a fresh dispatch (not pause). The
    # discriminator is the inFlight resolution — `pause` is in the idle
    # availability set too (drafts→pause), so we assert on resolve, not the set.
    assert {:ok, %{id: "dispatch-ad-hoc"}} =
             ActionQueries.resolve_action(fiber_id, "inFlight", query_opts)

    {:ok, actions} = ActionQueries.actions_for(fiber_id, query_opts)
    ids = Enum.map(actions, &(Map.get(&1, :id) || Map.get(&1, "id")))
    assert "dispatch-ad-hoc" in ids
  end

  test "forced non-ad-hoc standing dispatch keeps scheduled run context for resume" do
    fiber_id = "tests/standing-force-scheduled"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      review:
        state: scheduled
      next_due_at: "2999-01-01T09:00:00+01:00"
      """
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_scheduled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)

    assert [%{fiber_id: ^fiber_id, state: "running", run_id: run_id}] =
             Poller.snapshot(poller).eligible

    refute String.starts_with?(run_id, "adhoc-")
    assert String.starts_with?(run_id, "29990101T080000")
  end

  test "forced standing dispatch honors just-filed resume intent before next scheduled window" do
    fiber_id = "tests/standing-force-resume-before-window"
    fiber = make_fiber(fiber_id, %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "0 9 * * 1-5"
        tz: Europe/Paris
      """
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_force_resume_before_window,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The prior run's session id lives in the per-host dispatch marker; a forced
    # resume reads it from there. The resume directive (`resume_mode: "previous"`)
    # now rides the dispatch call as a transient parameter, not a
    # persisted felt review-comment — so there is no since-window to scope and the
    # "morning-post blocked for days" pathology cannot recur.
    write_dispatch_marker(fiber_id, "stored-standing-session-id")

    assert {:ok, _session} =
             Poller.dispatch_fiber(poller, fiber_id, force: true, resume_mode: "previous")

    script_path = new_session_scripts() |> List.last()
    assert script_path, "expected at least one new-session script"
    script = File.read!(script_path)

    assert script =~ "--resume"
    assert script =~ "stored-standing-session-id"
  end

  test "a worker's run script is named for its tmux session" do
    fiber_id = "tests/script-named"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_script_named,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    script = new_session_scripts() |> List.last() |> Path.basename()
    assert script =~ ~r/^shuttle-run-#{Regex.escape(session)}\.\d+\.sh$/
  end

  describe "a resume onto a transcript a live process tmux cannot see still holds" do
    setup do
      fiber_id = "tests/transcript-held"
      MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"status" => "active"}))
      MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "active")
      write_dispatch_marker(fiber_id, "held-session-uuid-0001")

      {:ok, poller} =
        start_poller!(
          name: :test_poller_transcript_held,
          runner: MockRunner,
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      %{fiber_id: fiber_id, poller: poller}
    end

    test "is refused and parks the fiber blocked with what is true and what to do", ctx do
      # The pre-socket-loss worker: an old-style run script under an orphaned
      # tmux server, its claude still holding the session.
      MockRunner.set_ps_result(
        {"""
           700     1 tmux new-session -d -s shuttle-anchor
           812   700 bash -l /tmp/shuttle-run-9859.sh
           813   812 claude --resume held-session-uuid-0001
         """, 0}
      )

      assert {:error, {:transcript_held, message}} =
               Poller.dispatch_fiber(ctx.poller, ctx.fiber_id,
                 force: true,
                 resume_mode: "previous"
               )

      assert message =~ "pid 813"
      assert message =~ "kill -USR1 700"
      assert new_session_scripts() == []

      blocked = Enum.find(Poller.snapshot(ctx.poller).blocked, &(&1.fiber_id == ctx.fiber_id))
      assert blocked.reason == message

      # Once that process is gone, the resume proceeds.
      MockRunner.set_ps_result({"", 0})

      assert {:ok, _} =
               Poller.dispatch_fiber(ctx.poller, ctx.fiber_id,
                 force: true,
                 resume_mode: "previous"
               )

      assert File.read!(List.last(new_session_scripts())) =~ "held-session-uuid-0001"
    end

    test "is held back when the process scan cannot run", ctx do
      # Uncertainty counts as present: with tmux answering "can't find session"
      # and no process scan, the fiber's own session may still be running, so
      # the dispatch reads as already running (and is adopted) — nothing spawns.
      MockRunner.set_ps_result({"ps: boom", 1})

      assert {:error, :already_running} =
               Poller.dispatch_fiber(ctx.poller, ctx.fiber_id,
                 force: true,
                 resume_mode: "previous"
               )

      assert new_session_scripts() == []
    end
  end

  describe "list_shuttle_sessions/1" do
    @live_script """
      700     1 tmux: server
      812   700 bash -l /tmp/shuttle-run-orphan-01KTHDNZS287ZSSG8X8V59XKW1-shuttle.3.sh
      900   700 bash -l /tmp/shuttle-run-resume-held-uuid.4.sh
    """

    test "unites tmux's listing with sessions whose run script still runs" do
      MockRunner.add_tmux_session("visible-01KTHDNZS287ZSSG8X8V59XKW2-shuttle")
      MockRunner.set_ps_result({@live_script, 0})

      assert {:ok, sessions} = Poller.list_shuttle_sessions(%{runner: MockRunner})

      assert Enum.sort(sessions) == [
               "orphan-01KTHDNZS287ZSSG8X8V59XKW1-shuttle",
               "visible-01KTHDNZS287ZSSG8X8V59XKW2-shuttle"
             ]
    end

    test "a server tmux cannot reach still lists its live workers" do
      MockRunner.set_tmux_server_missing(true)
      MockRunner.set_ps_result({@live_script, 0})

      assert Poller.list_shuttle_sessions(%{runner: MockRunner}) ==
               {:ok, ["orphan-01KTHDNZS287ZSSG8X8V59XKW1-shuttle"]}
    end

    test "tmux absence the process scan cannot check is unknown, not empty" do
      MockRunner.set_tmux_server_missing(true)
      MockRunner.set_ps_result({"ps: boom", 1})
      assert Poller.list_shuttle_sessions(%{runner: MockRunner}) == {:error, :unknown}

      MockRunner.set_ps_result({"", 0})
      assert Poller.list_shuttle_sessions(%{runner: MockRunner}) == {:ok, []}
    end
  end

  test "force-dispatch runs a closed fiber while leaving its status untouched" do
    # Manual "New session" / "Resume" buttons on a closed kanban card must
    # spawn a worker even though the fiber is closed (composted/tempered).
    # The Poller's force path bypasses the status check; the Dispatcher's
    # check_not_closed honors `force: true`. Status itself is *not* reopened
    # — closed fibers stay closed; the worker just runs against the current
    # outcome.
    fiber_id = "tests/closed-force"
    fiber = make_fiber(fiber_id, %{"status" => "closed"})
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      "enabled: true\nkind: oneshot\nagent: claude-sonnet\n",
      "closed"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_closed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Without force, a closed fiber is not eligible — and the reason now names
    # the cause (closed) so the kanban can say "reopen it first".
    assert {:error, {:not_eligible, :closed}} = Poller.dispatch_fiber(poller, fiber_id, [])
    # With force, the same fiber dispatches.
    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert session == FiberUid.session(fiber_id)
  end

  test "force-dispatch runs a draft fiber (status: open)" do
    # A draft (status: open) is not auto-dispatched because status is the sole
    # gate, but it remains available for explicit manual launch —
    # the click is the override.
    fiber_id = "tests/disabled-force"
    fiber = make_fiber(fiber_id, %{"status" => "open"})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_disabled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:error, {:not_eligible, :disabled}} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
  end

  test "force-dispatch still refuses fibers pinned to a different host" do
    # Host is a real hardware constraint — we can't conjure a worker on
    # another machine. Force relaxes intent, not topology.
    fiber_id = "tests/wrong-host-force"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      "enabled: true\nkind: oneshot\nagent: claude-sonnet\nhost: some-other-machine\n"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_wrong_host,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The refusal now NAMES the cause: the fiber is homed elsewhere, carrying
    # both its declared host and this daemon's own id. The kanban surfaces this
    # as "homed on <host>, can only run there" instead of the misleading
    # "disabled, not yet due, or closed" — the Bug-3 fix.
    assert {:error, {:not_eligible, {:homed_elsewhere, "some-other-machine", "test-host"}}} =
             Poller.dispatch_fiber(poller, fiber_id, force: true)
  end

  test "poller dispatches a due standing role with run context and does not hot-loop after exit" do
    # Uses new-format "kind: standing" (vs legacy "mode: standing") to test backward compat.
    fiber = make_fiber("tests/standing-due", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-due", fiber)

    # Slice 2: due-ness is computed from the cron schedule + now, not a stored
    # next_due_at. `* * * * *` fires every minute, so a tick always lands inside
    # the poll window → the role is due now, deterministically.
    MockRunner.set_shuttle(
      "tests/standing-due",
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      review:
        state: scheduled
      """
    )

    # `* * * * *`'s most recent tick is ~now; with no prior service it is due.
    now = DateTime.utc_now()
    set_resolved_occurrences("tests/standing-due", now, DateTime.add(now, 60, :second))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_due,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert [%{fiber_id: "tests/standing-due", state: "running", run_id: run_id}] =
               Poller.snapshot(poller).eligible

      assert is_binary(run_id)
    end)

    # Simulate the worker exit. In production the exit handler's standing branch
    # writes status:closed to the felt document (mark_standing_awaiting) BEFORE it
    # releases the claim, so no poll after the exit ever sees the role armed. The
    # MockRunner's `felt ls` reads its in-memory map, not the on-disk write
    # mark_awaiting performs, so mirror that document close here — atomically with
    # the exit — to reproduce the production ordering. With an every-minute cron,
    # this closed-state is the ONLY thing preventing immediate re-dispatch (slice
    # 2 dropped the completed_standing_runs MapSet): the `active → closed → active`
    # document transition is the sole per-cycle gate.
    MockRunner.set_shuttle(
      "tests/standing-due",
      """
      enabled: true
      kind: standing
      agent: claude-sonnet
      schedule:
        expr: "* * * * *"
        tz: Europe/Paris
      """,
      "closed"
    )

    end_worker_session(poller, "tests/standing-due")
    sync_poll_cycle!(poller)

    assert MockRunner.commands()
           |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
           |> length() == 1

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "felt" and Enum.take(args, 2) == ["standing", "review"]
           end)
  end

  # Slice 4: a stale stored next_due_at no longer fires the role — due-ness is
  # cron-computed against the poll window (the morning-post-drift rule). A role
  # whose only past tick fell outside the window is not dispatched, and its
  # snapshot is a valid schedule-derived state (no review/accepted validation).
  test "poller does not dispatch a standing role whose stored next_due is stale" do
    fiber = make_fiber("tests/standing-stale", %{"tags" => ["constitution", "standing"]})
    MockRunner.set_fiber("tests/standing-stale", fiber)

    MockRunner.set_shuttle(
      "tests/standing-stale",
      """
      enabled: true
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      next_due_at: "2000-01-03T09:00:00+01:00"
      """
    )

    # Recently serviced ⇒ not due now (what gates is "has an occurrence elapsed
    # since last service"). Shuttle's prev_due (the last real tick) sits before
    # this service; next_due is the future tick → valid (validation_errors
    # empty) but not due. Shuttle's resolved occurrences provide the schedule
    # times.
    write_dispatch_marker("tests/standing-stale", "seed-recent")
    write_handoff_marker("tests/standing-stale")

    set_resolved_occurrences(
      "tests/standing-stale",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_stale,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    MockRunner.set_ls_delay(100)
    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert [%{fiber_id: "tests/standing-stale", state: state, validation_errors: []}] =
             Poller.snapshot(poller).standing_roles

    assert state in ["scheduled", "due"]
  end

  # Slice 4: the snapshot state is schedule-derived (scheduled/due/dormant/
  # running), never a review-derived "review"/"accepted". Awaiting/accepted are
  # document facts the kanban classifier reads from status/tempered.
  test "snapshot standing state is schedule-derived, not review-derived" do
    sleeping = make_fiber("tests/standing-review", %{"tags" => ["constitution", "standing"]})

    paused =
      make_fiber("tests/standing-accepted", %{
        "status" => "open",
        "tags" => ["constitution", "standing"]
      })

    MockRunner.set_fiber("tests/standing-review", sleeping)
    MockRunner.set_fiber("tests/standing-accepted", paused)

    # A leftover review block is ignored because no review axis exists; the role reads
    # scheduled (its next weekday-09:00 tick is in the future).
    MockRunner.set_shuttle(
      "tests/standing-review",
      """
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      """
    )

    # Recently serviced ⇒ not due ⇒ stays "scheduled" (not dispatched/"running").
    # Shuttle resolves a valid schedule (prev before service, next in the future) so
    # the snapshot reads a genuine "valid but sleeping", not an invalid role.
    write_dispatch_marker("tests/standing-review", "seed-recent")

    set_resolved_occurrences(
      "tests/standing-review",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    # A draft role (status: open) still reads scheduled in the schedule-derived
    # snapshot — paused/draft is a document fact (status), surfaced by the kanban
    # classifier from the document, not a StandingRole phase.
    MockRunner.set_shuttle(
      "tests/standing-accepted",
      """
      kind: standing
      schedule:
        kind: cron
        expr: "0 9 * * 1-5"
        timezone: Europe/Paris
      """,
      "open"
    )

    # A draft (status: open) still resolves a valid schedule; its last tick is in
    # the past (outside the 90s display window) so it reads "scheduled".
    set_resolved_occurrences(
      "tests/standing-accepted",
      ~U[2026-05-01 09:00:00Z],
      ~U[2999-01-01 09:00:00Z]
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_snapshot_states,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             length(Poller.snapshot(poller).standing_roles) == 2
           end)

    roles = Poller.snapshot(poller).standing_roles
    assert Enum.find(roles, &(&1.fiber_id == "tests/standing-review")).state == "scheduled"
    assert Enum.find(roles, &(&1.fiber_id == "tests/standing-accepted")).state == "scheduled"
  end

  test "poller skips untracked fibers" do
    fiber = make_fiber("tests/untracked", %{"status" => "untracked"})
    MockRunner.set_fiber("tests/untracked", fiber)
    MockRunner.set_shuttle("tests/untracked", oneshot_shuttle(), "untracked")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_untracked,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    commands = MockRunner.commands()

    refute Enum.any?(commands, fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # `depends_on` has zero dispatch meaning: it's a board-only ordering
  # annotation ("filed after that"), never a gate. An active oneshot whose
  # `depends_on` names a fiber that is neither tempered nor pinned — the
  # shape that used to block it under the old sequence gate — is eligible
  # regardless, and this holds for every accepted `depends_on` shape (bare
  # scalar, list of ids, list of {id: ...} maps).
  test "poller dispatches a oneshot whose depends_on names an untempered fiber" do
    dep = make_fiber("tests/dep", %{"tempered" => false, "tags" => []})

    for {label, deps} <- [
          {"scalar", "tests/dep"},
          {"list of ids", ["tests/dep"]},
          {"list of maps", [%{"id" => "tests/dep"}]}
        ] do
      fiber_id = "tests/dependent-#{String.replace(label, " ", "-")}"
      fiber = make_fiber(fiber_id, %{"depends_on" => deps})

      MockRunner.set_fiber(fiber_id, fiber)
      MockRunner.set_fiber("tests/dep", dep)
      MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

      {:ok, poller} =
        start_poller!(
          name: :"test_poller_dep_ignored_#{String.replace(label, " ", "_")}",
          runner: MockRunner,
          poll_interval_ms: 60_000,
          felt_stores: [MockRunner.felt_root()]
        )

      sync_poll_cycle!(poller)

      assert_eventually(fn ->
        commands = MockRunner.commands()

        assert Enum.any?(commands, fn {cmd, args} ->
                 cmd == "tmux" and hd(args) == "new-session" and
                   Enum.member?(args, FiberUid.session(fiber_id))
               end)
      end)
    end
  end

  test "poller does not double-dispatch" do
    fiber = make_fiber("tests/haiku-dedup")
    MockRunner.set_fiber("tests/haiku-dedup", fiber)
    MockRunner.set_shuttle("tests/haiku-dedup", oneshot_shuttle())
    MockRunner.add_tmux_session(FiberUid.session("tests/haiku-dedup"))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_6,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # Should not create a new session
    new_session_count =
      MockRunner.commands()
      |> Enum.filter(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
      |> length()

    assert new_session_count == 0
  end

  test "poller re-dispatches a still-active oneshot after its worker exits (retry collapsed into poll loop)" do
    # Retries run through the poll loop: when a multi-session oneshot worker
    # exits but its document is still status:active, the claim is
    # released and the next poll re-picks it (status:active + no live session →
    # eligible) and starts a fresh session.
    fiber = make_fiber("tests/haiku-retry")
    MockRunner.set_fiber("tests/haiku-retry", fiber)
    MockRunner.set_shuttle("tests/haiku-retry", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_7,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Dispatch
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      snap1 = Poller.snapshot(poller)
      assert length(snap1.eligible) == 1
    end)

    # Simulate worker exit (tmux session dies). The claim is released; the fiber
    # is no longer running, and the snapshot carries no retry queue.
    end_worker_session(poller, "tests/haiku-retry")

    assert_eventually(fn ->
      snap2 = Poller.snapshot(poller)
      assert length(snap2.eligible) == 0
      refute Map.has_key?(snap2, :retrying)
    end)

    # The next poll re-dispatches it: a second new-session call.
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             MockRunner.commands()
             |> Enum.count(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)
             |> Kernel.==(2)
           end)
  end

  test "running snapshot keys the in-memory registry and rows by intrinsic uid" do
    fiber_id = "tests/running-uid-keyed"
    uid = "01KTCA2CWXBSNHETE66MXKPVE7"

    fiber = make_fiber(fiber_id, %{"uid" => uid})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_running_uid_keyed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, _session} = Poller.dispatch_fiber(poller, fiber_id, [])

    # The in-memory running registry is keyed by uid.
    state = :sys.get_state(poller, @state_timeout)
    assert Map.has_key?(state.running, uid)
    refute Map.has_key?(state.running, fiber_id)

    # Slice 7: no separate `:runtime` index. The live worker rides the
    # `eligible` row, which carries both the intrinsic uid (the join key) and the
    # felt address (the display/CLI handle).
    snap = Poller.snapshot(poller)
    refute Map.has_key?(snap, :runtime)

    assert [%{fiber_id: ^fiber_id, uid: ^uid, state: "running"}] = snap.eligible
  end

  test "force-dispatch honors resume_mode: previous dispatch param (unified resume path)" do
    # The old kanban-modal flow had two separate paths: "New session"
    # (ad-hoc, force-fresh) and "Resume" (a special accept-then-dispatch
    # dance via shuttle resume). Under unified force semantics, BOTH
    # buttons carry resume_mode on the dispatch call and dispatch with
    # force: true. resolve_resume_intent honors the carried resume_mode
    # regardless of dispatch context (oneshot, standing scheduled, standing
    # ad-hoc).
    fiber_id = "tests/force-resume-unified"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: oneshot
      agent: claude-sonnet
      """
    )

    # The prior session id lives in the per-host dispatch marker the daemon wrote
    # at spawn (the only structured session-id home). resume_mode rides the
    # dispatch call, not a persisted review-comment.
    write_dispatch_marker(fiber_id, "stored-session-id")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_force_resume_unified,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # An explicit force-dispatch carrying resume_mode: "previous" produces a
    # --resume invocation against the dispatch marker's session id, not a fresh
    # new-session.
    _ = Poller.dispatch_fiber(poller, fiber_id, force: true, resume_mode: "previous")

    assert wait_until(fn -> new_session_scripts() != [] end)

    script = new_session_scripts() |> List.last() |> File.read!()

    assert script =~ "--resume"
    assert script =~ "stored-session-id"
  end

  test "poller continuation RESUMES a oneshot that died without a handoff marker" do
    # The resume-on-no-handoff fix. A multi-session oneshot's autonomous
    # continuation: a dispatch marker (with the session id) is on file but there
    # is NO worker-authored handoff marker after it — so the previous session
    # died mid-thought (the remote-machine kill case), and the dispatch must
    # RESUME the transcript rather than loop a fresh, context-less worker.
    fiber_id = "tests/continuation-died"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n")

    session = "d1ed0000-0000-4000-8000-000000000001"
    write_dispatch_marker(fiber_id, session)
    write_transcript(session)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_continuation_died,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    assert wait_until(fn -> new_session_scripts() != [] end)

    script = new_session_scripts() |> List.last() |> File.read!()
    assert script =~ "--resume"
    assert script =~ session
  end

  test "poller continuation re-dispatches FRESH when the worker left a clean handoff" do
    # The clean-close half: a handoff marker written at or after the last dispatch
    # marks an intentional handoff, so the continuation starts fresh and the next
    # worker reads the `## Status` block (the intentional loop, unchanged).
    fiber_id = "tests/continuation-handoff"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\nagent: claude-sonnet\n")

    # Back-date the dispatch so the handoff (now) is unambiguously >= dispatch.
    write_dispatch_marker(
      fiber_id,
      "old-session-id",
      DateTime.add(DateTime.utc_now(), -60, :second)
    )

    write_handoff_marker(fiber_id)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_continuation_handoff,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    assert wait_until(fn -> new_session_scripts() != [] end)

    script = new_session_scripts() |> List.last() |> File.read!()
    assert script =~ "Fiber: #{fiber_id}"
    refute script =~ "--resume"
    # Fresh means a new transcript, not amnesia: the prompt may NAME the
    # predecessor's session (the lineage line, 3ffc8dc) — what it must never
    # do is resume it.
    assert script =~ "Previous session: old-session-id"
  end

  test "poller releases claim when worker exits and fiber is closed" do
    # Use a fiber ID unique to this test — shared names (like "tests/haiku") can
    # collide with sessions left over from other tests' Pollers/Watchers.
    fiber = make_fiber("tests/haiku-close")
    MockRunner.set_fiber("tests/haiku-close", fiber)
    MockRunner.set_shuttle("tests/haiku-close", oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_8,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Wait for dispatch to install the watcher before closing the fixture.
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert %{pid: watcher} = Poller.worker_status(poller, "tests/haiku-close")
      assert is_pid(watcher)
      assert Poller.snapshot(poller).claimed_count == 1
    end)

    %{pid: watcher, session: session} = Poller.worker_status(poller, "tests/haiku-close")

    # Close the fiber
    MockRunner.set_fiber("tests/haiku-close", %{fiber | "status" => "closed"})
    MockRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, "tests/haiku-close", watcher, session, :normal_exit})

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)
      assert snap.claimed_count == 0
    end)
  end

  test "reconciling a closed fiber with a still-running worker stamps the clean-exit handoff marker" do
    # closed-implies-handoff: a fiber flipping to status:closed while its
    # worker is still running IS the worker's deliberate exit — a crash never
    # changes status, so closed is deliberate by construction. The reaper must
    # stamp handed_off_at exactly as the worker's own `shuttle handoff`
    # would, so the exit reads back as clean (fresh redispatch), never a dirty
    # death (resume).
    fiber_id = "tests/closed-implies-handoff"
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_closed_implies_handoff,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Wait for the autonomous tick to dispatch and install the watcher.
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert %{pid: watcher} = Poller.worker_status(poller, fiber_id)
      assert is_pid(watcher)
    end)

    %{session: session} = Poller.worker_status(poller, fiber_id)

    dispatched_fiber = MockRunner.fiber(fiber_id)
    dispatched_at = get_in(dispatched_fiber, ["shuttle", "runtime", "dispatched_at"])
    assert is_binary(dispatched_at)
    refute get_in(dispatched_fiber, ["shuttle", "runtime", "handed_off_at"])

    # The worker's own deliberate exit: status flips to closed while the tmux
    # session (and the daemon's watcher) are still alive. No `shuttle
    # handoff` call — closed itself is now the deliberate-exit signal.
    MockRunner.set_fiber(fiber_id, Map.put(dispatched_fiber, "status", "closed"))

    sync_poll_cycle!(poller)

    # The reap here only stops the daemon's watcher (the closed-externally
    # branch never kills the worker's own tmux session — a real worker ends
    # its own session as its final act, same as a clean `shuttle
    # handoff` exit); wait on the stamp itself rather than tmux teardown.
    assert wait_until(fn ->
             get_in(MockRunner.fiber(fiber_id), ["shuttle", "runtime", "handed_off_at"]) != nil
           end)

    assert Shuttle.Tmux.present?(MockRunner, session)

    closed_fiber = MockRunner.fiber(fiber_id)
    handed_off_at = get_in(closed_fiber, ["shuttle", "runtime", "handed_off_at"])
    assert is_binary(handed_off_at)

    {:ok, dispatched_dt, _} = DateTime.from_iso8601(dispatched_at)
    {:ok, handed_off_dt, _} = DateTime.from_iso8601(handed_off_at)
    assert DateTime.compare(handed_off_dt, dispatched_dt) != :lt

    assert Shuttle.Continuation.clean_handoff_since_dispatch?(closed_fiber)

    assert Enum.any?(MockRunner.commands(), fn
             {"shuttle", args} -> "mark-runtime" in args and "--handed-off-at" in args
             _ -> false
           end)
  end

  # Startup adoption recognizes every live worker session by the
  # `<leaf>-<uid>-shuttle` name its fiber resolves to, whatever the fiber id
  # looks like and whatever else the listing prints. The boot quarantine is on,
  # so a fresh launch cannot stand in for adoption: the only way a row's fiber
  # shows running in its live session is the boot scan having recognized it.
  @adoptable_orphans [
    {"a fiber's worker", "tests/orphan", []},
    {"a uid-carrying fiber's worker under the uid-keyed session", "tests/orphan-uid",
     uid: "01KTHDNZS287ZSSG8X8V59XKWB"},
    {"uid workers when Shuttle listing warnings go to stderr", "life/french/daily-practice",
     uid: "01KTHDNZS287ZSSG8X8V59XKWB",
     shuttle: "kind: oneshot\nagent: claude-opus\n",
     ls_stderr_warning: true},
    {"a literal hyphenated fiber id", "ai-futures/shuttle/constitution-shuttle-standalone",
     shuttle: "enabled: true\nkind: oneshot\nagent: claude-sonnet\n"}
  ]

  for {{label, fiber_id, row}, index} <- Enum.with_index(@adoptable_orphans) do
    @fiber_id fiber_id
    @row row
    @index index
    test "poller adopts on startup #{label}" do
      fiber_id = @fiber_id
      uid = Keyword.get(@row, :uid, FiberUid.for(fiber_id))
      session = Dispatcher.session_name(fiber_id, uid)
      MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid}))
      MockRunner.set_shuttle(fiber_id, Keyword.get(@row, :shuttle, oneshot_shuttle()))
      MockRunner.set_ls_stderr_warning(Keyword.get(@row, :ls_stderr_warning, false))
      MockRunner.add_tmux_session(session)

      {:ok, poller} =
        start_poller!(
          name: :"test_poller_adopt_orphan_#{@index}",
          runner: MockRunner,
          poll_interval_ms: 60_000,
          felt_stores: [MockRunner.felt_root()],
          boot_quarantine: true
        )

      assert_eventually(fn ->
        snap = Poller.snapshot(poller)

        assert [%{fiber_id: ^fiber_id, state: "running", tmux_session: ^session}] =
                 snap.eligible

        assert snap.pending_launch == []
      end)

      refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
    end
  end

  test "a fiber without an intrinsic id is refused and shown blocked, naming the fix" do
    # Its worker would have no `<leaf>-<uid>-shuttle` name, so the poll's own
    # dispatch attempt is refused, and the board's `blocked` row says why and
    # what to run. A live session under the bare leaf is not a worker and is
    # not adopted in its place.
    fiber_id = "tests/no-uid"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => nil}))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    MockRunner.add_tmux_session("no-uid-shuttle")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_no_uid,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert_eventually(fn ->
      blocked = Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
      assert blocked
      assert blocked.reason =~ "has no intrinsic id"
      assert blocked.reason =~ "felt backfill-ids"
    end)

    refute Enum.any?(Poller.snapshot(poller).eligible, &(&1.state == "running"))

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    # Once the fiber has an id (`felt backfill-ids`), an explicit dispatch
    # launches it, and the next poll drops the row recorded under its slug.
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())
    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true)
    assert session == FiberUid.session(fiber_id)

    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      refute Enum.any?(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))
    end)
  end

  test "poller adopts a live orphan session for an armed oneshot (no duplicate dispatch)" do
    # Regression for the daemon-restart-drops-all-adoptions bug. After a restart,
    # `candidate_session_lookup` must record the fiber_id for a session name seen
    # exactly once — every uid-keyed name is unique to one fiber. A `Map.update/4`
    # misuse inserted the default grouped sets VERBATIM (the update fun is not
    # applied to the default), so a single-occurrence session kept empty sets,
    # resolved to nil, and the live worker was never adopted.
    #
    # An armed oneshot (status:active dispatches) with a live worker must be
    # adopted as running — NOT duplicate-dispatched by the loop —
    # whether via `candidate_session_lookup` or the dispatch→:already_running
    # adopt. The field symptom this guards: operator/morning-post showing at-rest
    # on the board while a live worker existed.
    fiber_id = "tests/armed-orphan"
    uid = "01KTHDNZS287ZSSG8X8V59XKWD"
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))
    MockRunner.set_shuttle(fiber_id, "kind: oneshot\n", "active")
    MockRunner.add_tmux_session(Dispatcher.session_name(fiber_id, uid))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_armed_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert_eventually(fn ->
      snap = Poller.snapshot(poller)

      assert Enum.any?(snap.eligible, &(&1.fiber_id == fiber_id and &1.state == "running")),
             "an armed oneshot with a live orphan session must be adopted as running"
    end)
  end

  # A status:active oneshot whose worker died while the daemon was down has no
  # live tmux session, so it is simply eligible again — the next poll re-dispatches
  # it. There is no separate
  # "resurrection" path or retry row to assert; the contract is that a fresh
  # session is spawned.
  test "poller re-dispatches a status:active oneshot whose worker died while the daemon was down" do
    fiber_id = "tests/orphan-dispatched-dead"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    agent: claude-sonnet
    """)

    # A prior dispatch is recorded in the dispatch marker but no tmux session is alive.
    write_dispatch_marker(fiber_id, "577af64b-644a-4733-9e6a-f60d86b6941f")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))
  end

  # A whole-loom sync can make the same constitution file readable on every
  # host, but it does not transfer execution ownership. The poll path keeps the
  # strict `shuttle.host` predicate on both ordinary eligibility and orphan
  # recovery, so this host must leave the synced copy alone.
  test "poller does not dispatch a synced fiber copy owned by another host" do
    fiber_id = "tests/orphan-foreign-host"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    host: some-other-machine
    """)

    write_dispatch_marker(fiber_id, "577af64b-644a-4733-9e6a-f60d86b6941f")

    # own_host_id is the default "test-host", which does not equal
    # "some-other-machine".
    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_foreign_host,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    snap = Poller.snapshot(poller)
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # The project_dir disqualifier applies to the poll path: a checkout that does
  # not exist on this host means the worker can't run here, owned or not.
  test "poller does not dispatch an active oneshot whose declared project_dir is missing" do
    fiber_id = "tests/orphan-missing-project-dir"

    MockRunner.set_shuttle(fiber_id, """
    kind: oneshot
    host: test-host
    project_dir: /nonexistent/path/shuttle-orphan-missing
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resurrect_missing_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  # The poll path: an absent host: is unowned everywhere (no nil-wildcard).
  # This is the failure mode that, before the cutover, made the wrong daemon
  # grab single-host work. Distinct from the wrong-host case (host present but
  # mismatched) — here host is structurally absent.
  test "poller treats a host-less fiber as ineligible (absent host is unowned)" do
    fiber_id = "tests/host-absent"

    # Write the .md file directly (discovery walks files), bypassing the
    # factory's host injection so the block genuinely has no host: key —
    # exercising the literal "absent host" branch. The fiber is discovered
    # (it carries a shuttle block) but unowned, hence ineligible everywhere.
    dir_path = Path.join([MockRunner.felt_dir(), fiber_id <> ".md"])
    File.mkdir_p!(Path.dirname(dir_path))

    File.write!(dir_path, """
    ---
    status: active
    shuttle:
      enabled: true
      kind: oneshot
      agent: claude-sonnet
    ---
    body
    """)

    fiber = make_fiber(fiber_id)

    MockRunner.set_fiber(
      fiber_id,
      Map.put(fiber, "shuttle", %{
        "enabled" => true,
        "kind" => "oneshot",
        "agent" => "claude-sonnet"
      })
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_host_absent,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    snap = Poller.snapshot(poller)
    assert snap.eligible == []
    assert snap.claimed_count == 0

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  after
    File.rm_rf!(Path.join([MockRunner.felt_dir(), "tests/host-absent.md"]))
  end

  test "poller marks an armed standing role awaiting when its worker died while the daemon was down" do
    # Slice 6 dead-orphan handling on the tmux-scan substrate: a standing role
    # whose document is armed (status:active, no verdict) but whose tmux session
    # is gone never fired handle_worker_exit (daemon was down across the exit), so
    # the poll-scan marks it awaiting (status:closed) — never re-dispatched, never
    # re-fired off the schedule mid-cycle.
    fiber_id = "tests/standing-dead-orphan"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # A far-future schedule so the role is NOT cron-due — the only thing that
    # could touch it is the dead-orphan marker, not a scheduled dispatch.
    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # The marker discriminator: a dispatch marker with no handoff (and no re-arm)
    # after it marks this as a daemon-down-across-exit dead orphan.
    write_dispatch_marker(fiber_id, "dead-session-uuid")

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-dead-orphan.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_dead_orphan,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    assert wait_until(fn -> File.read!(doc_path) =~ "status: closed" end)

    # No worker was spawned — the role was marked awaiting, not dispatched.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller self-heals (does not close) a standing role whose markers are time-inverted" do
    # Regression: a run whose `handed_off_at` is EARLIER than its `dispatched_at`
    # is physically impossible (you can't hand off before you're dispatched), so
    # the markers are corrupt — NOT a genuine "dispatched, never handed off"
    # orphan. The dead-orphan predicate misreads the inversion as an orphan and,
    # with no live tmux session, force-closes a healthy `status: active` role on
    # every poll. The reconciler must instead SELF-HEAL: stamp handed_off_at=now
    # (concluding the phantom run) and leave the role armed.
    fiber_id = "tests/standing-inverted-markers"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # Dispatch at T, handoff 94ms BEFORE T — the observed inversion.
    dispatched = DateTime.utc_now()
    write_dispatch_marker(fiber_id, "inverted-session-uuid", dispatched)
    write_handoff_marker(fiber_id, DateTime.add(dispatched, -94, :millisecond))

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-inverted-markers.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_inverted,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # Self-heal fired: a `shuttle mark-runtime --handed-off-at` write was
    # issued to conclude the phantom run.
    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
                 "--handed-off-at" in args
             end)
           end)

    # The document was NEVER closed — the role stays armed.
    assert File.read!(doc_path) =~ "status: active"
    refute File.read!(doc_path) =~ "status: closed"

    # No worker was spawned.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller leaves a scheduled standing role armed when a dead ADHOC extra-run is its last run" do
    # Fix #2: a force-dispatched ad-hoc extra-run that dies dirty (daemon down
    # across its exit) must NOT close the SCHEDULED standing role to awaiting —
    # that would disrupt the cron cadence and force a human temper. A COMPLETED
    # ad-hoc run reaches awaiting-review through handle_worker_exit, not this
    # reconciler, so leaving a crashed ad-hoc run's role armed is safe.
    fiber_id = "tests/standing-dead-adhoc"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    # Plausible-but-orphaned markers (dispatched, NO handoff — a genuine dirty
    # death, not an inversion) carrying an ad-hoc run_id.
    write_dispatch_marker(fiber_id, "dead-adhoc-uuid")
    MockRunner.put_shuttle_fields(fiber_id, %{"run_id" => "adhoc-1751558400000"})

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-dead-adhoc.md"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_dead_adhoc,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The scheduled role's document is untouched: still armed, never closed.
    assert File.read!(doc_path) =~ "status: active"
    refute File.read!(doc_path) =~ "status: closed"

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "a wedged tmux ls does not mark live standing roles dead" do
    # `tmux ls` timing out means the session list is UNKNOWN, not empty.
    # Reading it as "no sessions" mass-marked every armed standing role
    # awaiting (status:closed — a fiber WRITE) off a single wedged scan.
    # Uncertainty counts as present (Shuttle.Tmux): the dead-orphan pass must
    # skip the tick and let the next healthy scan decide.
    fiber_id = "tests/standing-tmux-wedged"

    Env.put_env("SHUTTLE_STORES", MockRunner.felt_root())

    # Same shape as the dead-orphan case — armed, dispatched, un-exited, not
    # cron-due — except tmux cannot answer.
    MockRunner.set_shuttle(fiber_id, """
    kind: standing
    agent: claude-sonnet
    schedule:
      expr: "0 9 1 1 *"
      tz: Europe/Paris
    """)

    write_dispatch_marker(fiber_id, "wedged-session-uuid")

    doc_path = "#{MockRunner.felt_dir()}/#{fiber_id}/standing-tmux-wedged.md"

    # MockRunner is reset per test, so the wedge does not bleed across tests.
    MockRunner.set_tmux_ls_timeout(true)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_standing_tmux_wedged,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # The role's document is untouched: still armed, never flipped to closed.
    assert File.read!(doc_path) =~ "status: active"
    refute File.read!(doc_path) =~ "status: closed"
  end

  test "poller does not re-dispatch a closed oneshot whose worker is dead" do
    fiber_id = "tests/closed-with-session"

    MockRunner.set_shuttle(
      fiber_id,
      """
      kind: oneshot
      agent: claude-sonnet
      """,
      "closed"
    )

    write_dispatch_marker(fiber_id, "closed-uuid")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_closed_not_resurrected,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # Closed is the don't-re-fire gate: no new session is spawned.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)
  end

  test "poller clears stale running state when the tmux session disappears" do
    fiber_id = "tests/missing-running-session"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_missing_running_session,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Absorb the boot cycle before the dead session exists, so the only cycle
    # that can observe it is the one this test drives.
    settle_poller!(poller)

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert session == FiberUid.session(fiber_id)

    MockRunner.remove_tmux_session(session)

    # One cycle does the whole job, and `sync_poll_cycle!` makes it exactly one:
    # `reconcile` clears the dead-session running entry and records the orphan,
    # then the same cycle's dispatch pass finds the fiber eligible again and
    # re-dispatches it. The orphan is a per-cycle observation (see
    # `sync_poll_cycle!`), so bounding the cycle is what makes it assertable —
    # a second cycle would wipe it, having nothing left to observe.
    sync_poll_cycle!(poller)

    new_session_count =
      MockRunner.commands()
      |> Enum.count(fn {cmd, args} -> cmd == "tmux" and hd(args) == "new-session" end)

    # Whether the fiber is *currently* in `running` is a transient: the watcher
    # for the now-dead session fires a late `{:worker_exited}` that flips it
    # toward a retry, and the retry re-dispatches again — so "running right now"
    # flaps on watcher timing. The stable invariants are the orphan record and
    # the recovery dispatch, so assert those instead of catching the flap.
    assert new_session_count == 2

    snap = Poller.snapshot(poller)

    assert [
             %{
               fiber_id: ^fiber_id,
               tmux_session: ^session,
               reason: "missing_tmux_session"
             }
             | _
           ] = snap.orphans
  end

  test "poller re-adopts a live tmux worker on restart (running is tmux-derived)" do
    # Daemon state is derived and disposable. After a
    # restart the live tmux session is re-adopted by adopt_orphans, so the worker
    # is tracked again — running work survives because tmux owns the process.
    fiber_id = "tests/runtime-rehydrate-live"

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_live_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    assert Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))

    GenServer.stop(poller)

    # The tmux session is still alive (the MockRunner tracks it across the
    # GenServer restart) — the restarted poller re-adopts it from the tmux scan.
    # Its boot quarantine keeps a fresh dispatch from standing in for that.
    {:ok, restarted} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_live_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()],
        boot_quarantine: true
      )

    assert wait_until(fn ->
             Poller.snapshot(restarted).eligible
             |> Enum.any?(&(&1.fiber_id == fiber_id and &1.tmux_session == session))
           end)
  end

  test "poller does not track a worker whose tmux session disappeared while daemon was down" do
    # There is no runtime store to rehydrate from: a restart re-scans tmux, and
    # a dead session is simply absent — nothing is tracked as running, and the
    # still-active fiber is re-dispatched fresh on the next poll.
    fiber_id = "tests/runtime-rehydrate-missing"

    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_missing_1,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])

    GenServer.stop(poller)
    MockRunner.remove_tmux_session(session)

    {:ok, restarted} =
      start_poller!(
        name: :test_poller_runtime_rehydrate_missing_2,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The dead session is not adopted: the restarted poller has no running entry
    # for this fiber.
    state = :sys.get_state(restarted)
    refute Map.has_key?(state.running, fiber_id)
    refute Enum.any?(state.running, fn {_k, m} -> Map.get(m, :fiber_id) == fiber_id end)
  end

  test "poller clears stale parent running state when only a child session exists" do
    fiber_id = "tests/prefix-parent"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_prefix_parent,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The boot cycle runs before the fiber exists, so no poll re-dispatches it
    # behind the test's own calls once its session is gone.
    settle_poller!(poller)
    fiber = make_fiber(fiber_id)
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, [])
    MockRunner.remove_tmux_session(session)
    MockRunner.add_tmux_session(session <> "/child")

    assert {:ok, ^session} = Poller.dispatch_fiber(poller, fiber_id, [])

    assert Enum.any?(MockRunner.commands(), fn
             {"tmux", ["has-session", "-t", target]} -> target == "=" <> session
             _ -> false
           end)
  end

  test "poller uses shuttle.project_dir as work_dir when it exists" do
    project_dir =
      Path.join(System.tmp_dir!(), "shuttle-test-proj-#{System.unique_integer([:positive])}")

    File.mkdir_p!(project_dir)

    fiber = make_fiber("tests/project-dir-fiber")
    MockRunner.set_fiber("tests/project-dir-fiber", fiber)

    MockRunner.set_shuttle("tests/project-dir-fiber", """
    enabled: true
    kind: oneshot
    project_dir: #{project_dir}
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    # tmux args: ["new-session", "-d", "-s", session, "-c", work_dir, "bash", "-l", script]
    # work_dir is at index 5
    assert_eventually(fn ->
      {_, args} =
        Enum.find(MockRunner.commands(), fn {cmd, args} ->
          cmd == "tmux" and hd(args) == "new-session"
        end)

      assert Enum.at(args, 5) == project_dir
    end)
  after
    File.rm_rf(Path.join(System.tmp_dir!(), "shuttle-test-proj-*"))
  end

  test "poller disqualifies (does not downgrade) a fiber whose declared project_dir is missing" do
    # A declared project_dir absent on this host means the checkout lives on
    # another machine. The pre-cutover behavior downgraded the worker cwd to a
    # felt store and dispatched anyway (native-desktop misdispatch root cause
    # #2); the cutover makes it *ineligible* — disqualify, don't downgrade.
    # host: test-host matches so the only disqualifier under test is the dir.
    fiber = make_fiber("tests/missing-project-dir")
    MockRunner.set_fiber("tests/missing-project-dir", fiber)

    MockRunner.set_shuttle("tests/missing-project-dir", """
    enabled: true
    kind: oneshot
    host: test-host
    project_dir: /nonexistent/path/shuttle-test-missing
    """)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_missing_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session"
           end)

    assert Poller.snapshot(poller).eligible == []
  end

  test "poller touches no filesystem path under a parked fiber's project_dir (per-tick TCC guard)" do
    # The per-tick path must be PURE. Everything the poller does with a
    # `project_dir` short of dispatching — eligibility, parking, the snapshot —
    # reads frontmatter and runtime maps, so a fiber it merely looks at is
    # never touched. It has twice been otherwise: a `File.dir?` stat, and a
    # per-segment `Shuttle.Realpath` symlink walk (the latter for a
    # checkout-exclusion rule that no longer exists), both running for every
    # candidate every tick. For a project_dir inside a macOS file provider
    # either one raises the un-grantable "access data from other apps" TCC
    # prompt, tick after tick, for a fiber (here `status: open`) the poller
    # never intended to dispatch.
    #
    # HOME is repointed so the project_dir is a genuine file-provider path, and
    # the directory really exists, so a regression cannot pass by virtue of an
    # early "nothing there" return. Both `:file.read_link/1` (the realpath
    # walk) and `File.dir?/1` (the dispatch-time stat) are traced inside the
    # poller process; neither may be called with anything under that root.
    home = Path.join(System.tmp_dir!(), "shuttle-test-home-#{System.unique_integer([:positive])}")
    protected_root = Path.join([home, "Library", "Mobile Documents"])
    project_dir = Path.join(protected_root, "checkout")
    File.mkdir_p!(project_dir)
    Env.put_env("HOME", home)

    # BOTH spellings of the fake home. `System.tmp_dir!/0` is `/var/folders/…`
    # on macOS, but `/var` is a symlink, so the realpath walk this test exists
    # to catch emits `/private/var/folders/…` — matching only the unresolved
    # prefix would make every assertion below vacuously true.
    home_prefixes =
      case Shuttle.Realpath.resolve(home) do
        {:ok, resolved} -> Enum.uniq([home, resolved])
        {:error, _} -> [home]
      end

    on_exit(fn -> File.rm_rf(home) end)

    fiber = make_fiber("tests/parked-icloud-project-dir", %{"status" => "open"})
    MockRunner.set_fiber("tests/parked-icloud-project-dir", fiber)

    MockRunner.set_shuttle(
      "tests/parked-icloud-project-dir",
      "kind: oneshot\nhost: test-host\nproject_dir: #{project_dir}\n",
      "open"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_parked_protected_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Same :dbg setup as the paused-sentinel test above — runtime_tools is on
    # disk but not on this project's code path, and :dbg is reached through
    # apply/3 so the compiler never sees an unavailable module.
    [runtime_tools_ebin] =
      :code.root_dir()
      |> to_string()
      |> Path.join("lib/runtime_tools-*/ebin")
      |> Path.wildcard()

    :code.add_pathz(String.to_charlist(runtime_tools_ebin))
    {:ok, _} = Application.ensure_all_started(:runtime_tools)

    test_pid = self()

    apply(:dbg, :tracer, [
      :process,
      {fn msg, n ->
         send(test_pid, {:dbg_relay, msg})
         n + 1
       end, 0}
    ])

    apply(:dbg, :p, [poller, [:call]])
    apply(:dbg, :tpl, [File, :dir?, :x])
    apply(:dbg, :tpl, [:file, :read_link, :x])

    on_exit(fn -> apply(:dbg, :stop_clear, []) end)

    sync_poll_cycle!(poller)

    touched =
      drain_dbg_relay!(poller)
      |> Enum.flat_map(fn
        {:trace, _pid, :call, {_mod, _fun, [arg]}} -> [to_string(arg)]
        _other -> []
      end)
      |> Enum.filter(fn arg -> Enum.any?(home_prefixes, &String.starts_with?(arg, &1)) end)

    assert touched == [],
           "poller touched a TCC-protected path on a plain tick: #{inspect(touched)}"

    refute Enum.any?(
             Poller.snapshot(poller).eligible,
             &(&1.fiber_id == "tests/parked-icloud-project-dir")
           )
  end

  test "an active fiber's unreachable project_dir is stat'd once, then sits out the cooldown" do
    # The dispatch-time gate, and the breaker behind it. A project_dir that is
    # absent and one this daemon is DENIED are the same `File.dir?` answer, and
    # under a macOS file provider the denial arrives as an un-grantable TCC
    # prompt — so re-stat'ing every tick puts a dialog on someone's screen
    # forever, on exactly the configuration that cannot come good by itself.
    # The refusal lands in `dispatch_failures`, and `preflight_cooldown_open?`
    # keeps the fiber out of the eligible set until the window lapses.
    home = Path.join(System.tmp_dir!(), "shuttle-test-home-#{System.unique_integer([:positive])}")
    project_dir = Path.join([home, "Library", "Mobile Documents", "unreachable"])
    File.mkdir_p!(Path.join([home, "Library", "Mobile Documents"]))
    Env.put_env("HOME", home)

    on_exit(fn -> File.rm_rf(home) end)

    expanded_dir = Path.expand(project_dir)
    fiber_id = "tests/unreachable-project-dir"
    shuttle = "enabled: true\nkind: oneshot\nhost: test-host\nproject_dir: #{project_dir}\n"

    {:ok, poller} =
      start_poller!(
        name: :test_poller_unreachable_project_dir,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    # `:dbg` again — runtime_tools is on disk but not on this project's code
    # path, and :dbg is reached through apply/3 so the compiler never sees an
    # unavailable module.
    [runtime_tools_ebin] =
      :code.root_dir()
      |> to_string()
      |> Path.join("lib/runtime_tools-*/ebin")
      |> Path.wildcard()

    :code.add_pathz(String.to_charlist(runtime_tools_ebin))
    {:ok, _} = Application.ensure_all_started(:runtime_tools)

    test_pid = self()

    apply(:dbg, :tracer, [
      :process,
      {fn msg, n ->
         send(test_pid, {:dbg_relay, msg})
         n + 1
       end, 0}
    ])

    apply(:dbg, :p, [poller, [:call]])
    apply(:dbg, :tpl, [File, :dir?, :x])
    apply(:dbg, :tpl, [:file, :read_link, :x])

    on_exit(fn -> apply(:dbg, :stop_clear, []) end)

    drain = fn ->
      Stream.repeatedly(fn ->
        receive do
          {:dbg_relay, {:trace, _pid, :call, {mod, fun, [arg]}}} ->
            {:ok, {mod, fun, to_string(arg)}}

          {:dbg_relay, _other} ->
            {:ok, nil}
        after
          0 -> :done
        end
      end)
      |> Enum.take_while(&(&1 != :done))
      |> Enum.map(fn {:ok, call} -> call end)
      |> Enum.filter(fn
        {_mod, _fun, arg} -> String.contains?(arg, "Mobile Documents")
        nil -> false
      end)
    end

    # Registered only now: the settling ticks above would otherwise have taken
    # the one stat this test is here to observe.
    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id))
    MockRunner.set_shuttle(fiber_id, shuttle)

    sync_poll_cycle!(poller)
    first = drain.()

    assert first == [{File, :dir?, expanded_dir}],
           "the dispatch attempt must stat the project_dir exactly once: #{inspect(first)}"

    # The refusal shows as a blocked row rather than the fiber silently
    # vanishing, and it IS the breaker's state — no parallel bookkeeping.
    assert %{reason: reason} =
             Enum.find(Poller.snapshot(poller).blocked, &(&1.fiber_id == fiber_id))

    assert reason =~ "project_dir"

    sync_poll_cycle!(poller)
    sync_poll_cycle!(poller)

    assert drain.() == [], "a fiber inside its cooldown must not be re-stat'd"
    refute Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == fiber_id))

    # ── A stable fleet touches nothing either ──
    #
    # Two healthy checkouts under the same provider root. Each is stat'd once,
    # by its own dispatch; from then on their fibers are running and every
    # later tick reads runtime maps alone.
    for leaf <- ["checkout-a", "checkout-c"] do
      dir = Path.join([home, "Library", "Mobile Documents", leaf])
      File.mkdir_p!(dir)
      id = "tests/#{leaf}"
      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "enabled: true\nkind: oneshot\nhost: test-host\nproject_dir: #{dir}\n"
      )
    end

    assert wait_until(fn ->
             sync_poll_cycle!(poller)

             running =
               :sys.get_state(poller, @state_timeout).running
               |> Enum.map(fn {_k, meta} -> meta.fiber_id end)
               |> MapSet.new()

             MapSet.subset?(MapSet.new(["tests/checkout-a", "tests/checkout-c"]), running)
           end)

    # Discard the two dispatches' own stats; from here the world is stable.
    drain.()

    sync_poll_cycle!(poller)
    sync_poll_cycle!(poller)
    sync_poll_cycle!(poller)

    assert drain.() == [], "a stable fleet must touch no project_dir at all"
  end

  # Regression: a fiber with a shuttle: block but *no* constitution tag must be
  # discovered and dispatched. This is the core invariant from the cutover —
  # the block is the source of truth, not the tag.
  test "poller discovers and dispatches a fiber with shuttle block but no constitution tag" do
    fiber_id = "tests/untagged-shuttle"
    fiber = make_fiber(fiber_id, %{"tags" => []})
    MockRunner.set_fiber(fiber_id, fiber)
    MockRunner.set_shuttle(fiber_id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        name: :test_poller_untagged_shuttle,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    send(poller, {:tick, Poller.snapshot(poller) |> Map.get(:tick_token)})

    assert wait_until(fn ->
             Enum.any?(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session"
             end)
           end)

    assert wait_until(fn ->
             Poller.snapshot(poller).eligible
             |> Enum.any?(&(&1.fiber_id == fiber_id))
           end)
  end

  test "dispatch_fiber waits past the default GenServer timeout for slow successful dispatches" do
    # The worker-changing calls wait 30 s, well past GenServer's 5 s default...
    assert Poller.dispatch_call_timeout_ms() == 30_000

    {:ok, poller} =
      start_poller!(
        name: :test_poller_slow_dispatch,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # The fibers arrive after the boot cycle, so only these calls dispatch them.
    settle_poller!(poller)
    slow_id = "tests/slow-api-dispatch"
    MockRunner.set_fiber(slow_id, make_fiber(slow_id))
    MockRunner.set_shuttle(slow_id, oneshot_shuttle())
    late_id = "tests/late-api-dispatch"
    MockRunner.set_fiber(late_id, make_fiber(late_id))
    MockRunner.set_shuttle(late_id, oneshot_shuttle())

    # ...a slow spawn still answers...
    MockRunner.set_new_session_delay(300)
    assert {:ok, session} = Poller.dispatch_fiber(poller, slow_id, [])
    assert session == FiberUid.session(slow_id)
    assert Poller.snapshot(poller).eligible |> Enum.any?(&(&1.fiber_id == slow_id))

    # ...and the wait is that timeout, not GenServer's default: shrunk well
    # below a spawn's duration, the caller gives up first, at the timeout its
    # exit names.
    Shuttle.Test.Env.put_app_env(:dispatch_call_timeout_ms, 200)
    MockRunner.set_new_session_delay(2_000)

    assert {:timeout, {GenServer, :call, [_server, _msg, 200]}} =
             catch_exit(Poller.dispatch_fiber(poller, late_id, []))
  end

  test "every worker-changing call gives up at the configured dispatch timeout" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_call_timeouts,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    Shuttle.Test.Env.put_app_env(:dispatch_call_timeout_ms, 100)

    # A suspended Poller never answers, so each call exits on its own timeout,
    # and the exit names the timeout it waited: the shrunk 100 ms, not
    # GenServer's 5 s default or the 30 s production value.
    :sys.suspend(poller)

    calls = [
      dispatch_fiber: fn -> Poller.dispatch_fiber(poller, "tests/t", []) end,
      claim_session: fn -> Poller.claim_session(poller, "tests/t", "s", []) end,
      kill_session: fn -> Poller.kill_session(poller, "tests/t") end,
      capture: fn -> Poller.capture(poller, "yap", []) end,
      lifecycle_transition: fn -> Poller.lifecycle_transition(poller, :accept, "tests/t") end
    ]

    for {name, call} <- calls do
      task = Task.async(fn -> catch_exit(call.()) end)

      assert {:ok, {:timeout, {GenServer, :call, [_server, _msg, 100]}}} =
               Task.yield(task, 30_000),
             "#{name} did not give up at the configured timeout"
    end
  end

  # ── Multi-host tests ──
  #
  # These tests exercise the multi-felt-store path directly against the file
  # system; they bypass MockRunner's in-memory fiber store and write real
  # .felt/ directories instead. Store resolution is the Poller's cold path,
  # `FeltStores.store_for_fiber/2` over its configured `felt_stores`.

  # Helper: write a minimal fiber .md file with a shuttle: block into
  # <host>/.felt/<id>/<basename>.md so read_fiber_shuttle_block can find it.
  defp write_fiber_file(host, fiber_id, shuttle_yaml \\ "enabled: true\nkind: oneshot\n") do
    felt_dir = Path.join(host, ".felt")
    segments = String.split(fiber_id, "/")
    basename = List.last(segments)
    dir_path = Path.join([felt_dir | segments] ++ ["#{basename}.md"])
    File.mkdir_p!(Path.dirname(dir_path))

    indented =
      shuttle_yaml
      |> String.trim()
      |> String.split("\n")
      |> Enum.map_join("\n", &("  " <> &1))

    File.write!(dir_path, "---\nstatus: active\nshuttle:\n#{indented}\n---\nbody\n")
    dir_path
  end

  # A throwaway felt store dir for the multi-host tests, swept by this test's
  # own `on_exit` — scoped to the dir this test made, so a sweep can't take
  # another test's store out from under it (this module is not async).
  defp multi_host_dir(label) do
    dir =
      Path.join(
        System.tmp_dir!(),
        "shuttle-multi-host-#{label}-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    dir
  end

  # The project-cities-on-loom topology: the physical fiber is rooted in loom
  # under ai-futures/portolan/, and the project's `.felt/` symlinks into that
  # subdir, so the same kanban-modal.md is also reachable as
  # project/.felt/kanban-modal/.
  defp loom_project_symlink! do
    loom = multi_host_dir("loom")
    project = multi_host_dir("project")

    write_fiber_file(loom, "ai-futures/portolan/kanban-modal")

    File.ln_s!(
      Path.join([loom, ".felt", "ai-futures", "portolan"]),
      Path.join(project, ".felt")
    )

    {loom, project}
  end

  test "store_for_fiber finds a fiber in the first configured store" do
    host_a = multi_host_dir("a")

    host_b = multi_host_dir("b")

    write_fiber_file(host_a, "tests/fiber-in-a")

    assert {:ok, ^host_a} = FeltStores.store_for_fiber("tests/fiber-in-a", [host_a, host_b])
  end

  test "store_for_fiber finds a fiber in the second configured store" do
    host_a = multi_host_dir("a")

    host_b = multi_host_dir("b")

    write_fiber_file(host_b, "tests/fiber-in-b")

    assert {:ok, ^host_b} = FeltStores.store_for_fiber("tests/fiber-in-b", [host_a, host_b])
  end

  test "store_for_fiber returns :not_found for an unknown fiber" do
    host_a = multi_host_dir("a")

    assert {:error, :not_found} = FeltStores.store_for_fiber("tests/no-such-fiber", [host_a])
  end

  test "first-configured host wins for ID collisions" do
    host_a = multi_host_dir("a")

    host_b = multi_host_dir("b")

    # Same fiber ID in both hosts
    write_fiber_file(host_a, "tests/collision-fiber")
    write_fiber_file(host_b, "tests/collision-fiber")

    # host_a is first-configured → wins
    assert {:ok, ^host_a} = FeltStores.store_for_fiber("tests/collision-fiber", [host_a, host_b])
  end

  test "subdirectory symlink: loom-walks-into-project subtree skipped" do
    # Mirrors loom→lightcone topology: physical .felt lives in host_b
    # (project-canonical, like lightcone). host_a (loom) symlinks INTO
    # host_b's tree at .felt/ai-futures/lightcone. Walking host_a should
    # NOT enumerate the symlinked subtree — host_b enumerates canonically.
    # This is load-bearing: if loom enumerates the lightcone fiber under
    # its loom-relative id, dispatch later runs `felt -C ~/loom show
    # ai-futures/lightcone/...` which fails (loom's index doesn't have
    # the entry) and dispatch silently never happens.
    host_a = multi_host_dir("loom")

    host_b = multi_host_dir("lightcone")

    File.mkdir_p!(Path.join(host_a, ".felt/ai-futures"))

    # The real fiber file is rooted in host_b's .felt/, accessible via the
    # project-canonical id `lightcone-ui/myst-as-ast/dual-branch`.
    write_fiber_file(host_b, "lightcone-ui/myst-as-ast/dual-branch")

    # host_a (loom) symlinks INTO host_b's tree, so the same physical file
    # is reachable as host_a/.felt/ai-futures/lightcone/lightcone-ui/.../dual-branch.md.
    File.ln_s!(
      Path.join(host_b, ".felt"),
      Path.join([host_a, ".felt", "ai-futures", "lightcone"])
    )

    {:ok, poller} =
      start_poller!(
        name: :test_subdir_symlink_skip,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [host_a, host_b]
      )

    # The fiber should resolve to host_b (canonical), not host_a (symlink view).
    assert {:ok, ^host_b} =
             FeltStores.store_for_fiber("lightcone-ui/myst-as-ast/dual-branch", [host_a, host_b])

    snap = Poller.snapshot(poller)
    candidate_ids = Enum.map(snap.eligible, & &1.fiber_id)

    refute "ai-futures/lightcone/lightcone-ui/myst-as-ast/dual-branch" in candidate_ids,
           "loom-relative symlink-aliased id leaked into eligible: #{inspect(candidate_ids)}"
  end

  test "host with symlinked .felt/ skipped entirely" do
    # Mirrors project-cities-on-loom topology: project's `.felt/` is a
    # symlink into loom's tree. Walking the project host should skip
    # everything — loom enumerates the same files canonically.
    {loom, project} = loom_project_symlink!()

    {:ok, poller} =
      start_poller!(
        name: :test_symlinked_felt_skipped,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [loom, project]
      )

    # The fiber resolves to loom (canonical), not project (symlinked .felt).
    assert {:ok, ^loom} =
             FeltStores.store_for_fiber("ai-futures/portolan/kanban-modal", [loom, project])

    snap = Poller.snapshot(poller)
    candidate_ids = Enum.map(snap.eligible, & &1.fiber_id)

    refute "kanban-modal" in candidate_ids,
           "project-symlink alias surfaced: #{inspect(candidate_ids)}"
  end

  test "store_for_fiber ignores the symlinked project view" do
    {loom, project} = loom_project_symlink!()

    assert {:ok, ^loom} =
             FeltStores.store_for_fiber("ai-futures/portolan/kanban-modal", [loom, project])
  end

  test "snapshot includes felt_stores list" do
    {:ok, poller} =
      start_poller!(
        name: :test_multi_host_snap,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: ["/tmp/host-one", "/tmp/host-two"]
      )

    snap = Poller.snapshot(poller)
    assert snap.felt_stores == ["/tmp/host-one", "/tmp/host-two"]
  end

  test "poller reads configured hosts from persisted registration" do
    config_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-poller-#{System.unique_integer([:positive])}.json"
      )

    Env.put_env("SHUTTLE_STORES_FILE", config_path)
    Env.delete_env("SHUTTLE_STORES")
    File.mkdir_p!(Path.dirname(config_path))

    File.write!(
      config_path,
      Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-a", "/tmp/host-b"]})
    )

    on_exit(fn -> File.rm(config_path) end)

    {:ok, poller} =
      start_poller!(
        name: :test_registered_felt_stores,
        runner: MockRunner,
        poll_interval_ms: 60_000
      )

    assert Poller.snapshot(poller).felt_stores == ["/tmp/host-a", "/tmp/host-b"]
  end

  test "poller refreshes configured hosts when the persisted registration changes" do
    config_path =
      Path.join(
        System.tmp_dir!(),
        "shuttle-felt-stores-refresh-#{System.unique_integer([:positive])}.json"
      )

    Env.put_env("SHUTTLE_STORES_FILE", config_path)
    Env.delete_env("SHUTTLE_STORES")
    File.mkdir_p!(Path.dirname(config_path))
    File.write!(config_path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-a"]}))

    on_exit(fn -> File.rm(config_path) end)

    {:ok, poller} =
      start_poller!(
        name: :test_refresh_registered_felt_stores,
        runner: MockRunner,
        poll_interval_ms: 60_000
      )

    assert Poller.snapshot(poller).felt_stores == ["/tmp/host-a"]

    File.write!(config_path, Jason.encode!(%{"version" => 1, "felt_stores" => ["/tmp/host-c"]}))
    sync_poll_cycle!(poller)

    assert_eventually(fn ->
      assert Poller.snapshot(poller).felt_stores == ["/tmp/host-c"]
    end)
  end

  # ── Claim (write-and-claim) ──

  test "claim registers a live external session: rename, runtime, exit handling" do
    id = "tests/claim-me"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01KTHDNZS287ZSSG8X8V59XKC1"}))
    MockRunner.set_shuttle(id, oneshot_shuttle())
    MockRunner.add_tmux_session("capture-abc123")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, %{session: session}} =
             Poller.claim_session(poller, id, "capture-abc123",
               session_uuid: "uuid-claim-1",
               meeting: "launch-xyz"
             )

    # Renamed to the canonical worker name — indistinguishable from a dispatch.
    assert session == "claim-me-01KTHDNZS287ZSSG8X8V59XKC1-shuttle"

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "rename-session"
           end)

    snap = Poller.snapshot(poller)
    assert Enum.any?(snap.eligible, &(&1.fiber_id == id))

    # The claim shells `shuttle mark-runtime` to stamp the session UUID into
    # `shuttle.runtime`. Shuttle owns that nested write; the command path and
    # its YAML update are covered by the CLI suite.
    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
               "--session" in args and "uuid-claim-1" in args
           end)

    # A meeting capture's claim stamps the meeting's launch id in the same
    # write: that stamp is how the recording's daemon, on any host, finds the
    # fiber its scribe filed.
    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
               Enum.chunk_every(args, 2, 1, :discard) |> Enum.member?(["--meeting", "launch-xyz"])
           end)

    # …and the same fact structurally: a claim is the moment this host learns
    # that an externally-spawned session belongs to this fiber. Recorded under
    # the CANONICAL tmux name, so the ledger matches what everything downstream
    # sees rather than the pre-rename capture name.
    assert [ledger] = Shuttle.SessionLedger.read_since(0)
    assert ledger["kind"] == "claim"
    assert ledger["fiber"] == id
    assert ledger["uid"] == "01KTHDNZS287ZSSG8X8V59XKC1"
    assert ledger["session"] == "uuid-claim-1"
    assert ledger["tmux"] == session
    assert ledger["host"] == Shuttle.Poller.own_host_id()
    refute Map.has_key?(ledger, "agent")

    new_sessions_before =
      Enum.count(MockRunner.commands(), fn {cmd, args} ->
        cmd == "tmux" and hd(args) == "new-session" and Enum.at(args, 3) == session
      end)

    # Exit handling works exactly as for a dispatched active oneshot: the dead
    # session is noticed by reconciliation, the stale running entry clears, and
    # the same poll tick retries the active fiber under its canonical name.
    MockRunner.remove_tmux_session(session)
    sync_poll_cycle!(poller)

    assert wait_until(fn ->
             Enum.count(MockRunner.commands(), fn {cmd, args} ->
               cmd == "tmux" and hd(args) == "new-session" and Enum.at(args, 3) == session
             end) > new_sessions_before and
               Enum.any?(Poller.snapshot(poller).eligible, &(&1.fiber_id == id))
           end)
  end

  test "claim ledger records an explicit agent but never infers the fiber recipe" do
    id = "tests/claim-explicit-agent"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01KTHDNZS287ZSSG8X8V59XKC2"}))
    MockRunner.set_shuttle(id, oneshot_shuttle())
    MockRunner.add_tmux_session("capture-explicit-agent")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_explicit_agent,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, %{agent_id: "codex-external"}} =
             Poller.claim_session(poller, id, "capture-explicit-agent",
               agent: "codex-external",
               session_uuid: "uuid-claim-explicit-agent"
             )

    assert [ledger] = Shuttle.SessionLedger.read_since(0)
    assert ledger["kind"] == "claim"
    assert ledger["agent"] == "codex-external"
  end

  test "claim refuses unknown fibers, dead sessions, and double claims" do
    id = "tests/claim-guards"
    MockRunner.set_fiber(id, make_fiber(id, %{"uid" => "01KTHDNZS287ZSSG8X8V59XKC3"}))
    # host: other-host keeps the boot poll from AUTO-dispatching this active fiber
    # — which would claim it first and race the manual claim_session calls below.
    # claim_session is host-agnostic (do_claim_session/register_claimed_session
    # never check host), so every guard under test still fires.
    MockRunner.set_shuttle(id, "enabled: true\nkind: oneshot\nhost: other-host\n")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_guards,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    # Session not live in tmux.
    assert {:error, :session_not_found} =
             Poller.claim_session(poller, id, "capture-dead", [])

    # Fiber unknown.
    MockRunner.add_tmux_session("capture-live01")

    assert {:error, :not_found} =
             Poller.claim_session(poller, "tests/no-such-fiber", "capture-live01", [])

    # A fiber without an intrinsic id has no worker name to rename the session to.
    no_uid = "tests/claim-no-uid"
    MockRunner.set_fiber(no_uid, make_fiber(no_uid, %{"uid" => nil}))
    MockRunner.set_shuttle(no_uid, "enabled: true\nkind: oneshot\nhost: other-host\n")

    assert {:error, :uid_missing} =
             Poller.claim_session(poller, no_uid, "capture-live01", [])

    # First claim wins; a different session claiming the same fiber is refused.
    assert {:ok, %{session: canonical}} = Poller.claim_session(poller, id, "capture-live01", [])
    MockRunner.add_tmux_session("capture-live02")
    assert {:error, :already_running} = Poller.claim_session(poller, id, "capture-live02", [])

    # Idempotent retry: re-claiming with the original (now-renamed-away) name
    # or with the canonical name returns the registered session, not an error —
    # a lost claim response must be retryable with the same body.
    assert {:ok, %{session: ^canonical}} = Poller.claim_session(poller, id, "capture-live01", [])
    assert {:ok, %{session: ^canonical}} = Poller.claim_session(poller, id, canonical, [])
  end

  test "claim refuses closed fibers" do
    id = "tests/claim-closed"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "closed"}))
    MockRunner.set_shuttle(id, oneshot_shuttle(), "closed")
    MockRunner.add_tmux_session("capture-closed1")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_closed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:error, :closed} = Poller.claim_session(poller, id, "capture-closed1", [])
  end

  test "claim refuses a fiber with no installed shuttle block" do
    id = "tests/claim-uninstalled"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "open"}))
    MockRunner.add_tmux_session("capture-uninstalled1")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_claim_uninstalled,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:error, :not_installed} =
             Poller.claim_session(poller, id, "capture-uninstalled1", session_uuid: "uuid-early")

    # Nothing registered, renamed, or stamped: a retry after install claims cleanly.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             (cmd == "tmux" and hd(args) == "rename-session") or
               (cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args))
           end)

    assert Shuttle.SessionLedger.read_since(0) == []

    MockRunner.set_shuttle(id, "enabled: true\nkind: oneshot\nhost: other-host\n", "open")

    assert {:ok, _} =
             Poller.claim_session(poller, id, "capture-uninstalled1", session_uuid: "uuid-early")

    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "shuttle" and match?(["-C", _store, "mark-runtime" | _], args) and
               "uuid-early" in args
           end)
  end

  # ── Capture (spawn-without-constitution) ──

  test "capture spawns a tmux session from a free-text prompt" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_capture,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    assert {:ok, %{session: "capture-" <> _ = session, agent_id: "claude-opus"}} =
             Poller.capture(poller, "build me a thing", work_dir: "/tmp")

    # Right tmux command: detached session under the capture name, rooted in
    # the requested project dir — the last free boundary before a real agent.
    assert Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "new-session" and
               Enum.at(args, 3) == session and Enum.at(args, 5) == "/tmp"
           end)

    # Pre-claim, the capture session is invisible to the shuttle-session
    # machinery (not `-shuttle`-suffixed): a poll does not adopt or kill it.
    sync_poll_cycle!(poller)

    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and hd(args) == "kill-session" and Enum.at(args, 2) =~ "capture-"
           end)
  end

  # `created_at` is an INSTANT and the store holds mixed offsets — thousands of
  # `+02:00` and `+01:00` values from Paris, a growing tail of `-07:00` from
  # Berkeley, plus `Z`, `-05:00`, `-04:00`, `+03:00`. Lexicographic string order
  # resolves inside the time field long before it reaches the offset suffix, so
  # it orders by local wall clock instead of by instant. These two cases both
  # fail against the string comparator.
  describe "sort_candidates orders by instant, not by wall clock" do
    test "a later instant written at a western offset still sorts later" do
      # 16:00Z, then 16:30Z. As strings, "09:30" sorts below "18:00".
      paris = %{"id" => "paris", "created_at" => "2026-07-27T18:00:00+02:00"}
      berkeley = %{"id" => "berkeley", "created_at" => "2026-07-27T09:30:00-07:00"}

      assert Poller.sort_candidates([berkeley, paris]) == [paris, berkeley]
      assert Poller.sort_candidates([paris, berkeley]) == [paris, berkeley]
    end

    test "the same instant at two offsets ties, and the tie breaks on id" do
      # Both are 16:00Z. Correct order is by id; the string comparator puts the
      # "09:00" row first no matter what its id is.
      alpha = %{"id" => "alpha", "created_at" => "2026-07-27T18:00:00+02:00"}
      zulu = %{"id" => "zulu", "created_at" => "2026-07-27T09:00:00-07:00"}

      assert Poller.sort_candidates([zulu, alpha]) == [alpha, zulu]
    end

    test "a Z value compares against an offset value on the same axis" do
      # 16:00Z, then 16:05Z. As strings, "09:05" sorts below "16:00".
      utc = %{"id" => "a", "created_at" => "2026-07-27T16:00:00Z"}
      offset = %{"id" => "b", "created_at" => "2026-07-27T09:05:00-07:00"}

      assert Poller.sort_candidates([offset, utc]) == [utc, offset]
    end

    test "a missing or unparseable created_at keeps its head position" do
      missing = %{"id" => "missing"}
      junk = %{"id" => "junk", "created_at" => "not-a-timestamp"}
      real = %{"id" => "real", "created_at" => "2020-01-01T00:00:00Z"}

      assert Poller.sort_candidates([real, junk, missing]) == [junk, missing, real]
    end
  end

  @tag :adaptive_discovery
  test "fast stores keep doing a full projection each poll" do
    id = "tests/discovery-fast"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "open"}))
    MockRunner.set_shuttle(id, "enabled: true\nhost: another-host\nkind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_fast,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    sync_poll_cycle!(poller)

    listings =
      Enum.filter(MockRunner.commands(), fn
        {"shuttle", args} -> "ls" in args and "--has-field" in args
        _ -> false
      end)

    assert length(listings) >= 3
    assert Enum.count(listings, fn {_cmd, args} -> "--ids-from" in args end) == 1
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :full
  end

  @tag :adaptive_discovery
  test "slow stores use ids-from hot sets and refresh returned rows" do
    original = "tests/discovery-hot-original"
    MockRunner.set_fiber(original, make_fiber(original, %{"status" => "open"}))
    MockRunner.set_shuttle(original, "enabled: true\nhost: another-host\nkind: oneshot\n", "open")
    MockRunner.set_ls_delay(15)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_hot,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 1,
        full_scan_min_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :hot

    sync_poll_cycle!(poller)

    assert Enum.any?(MockRunner.commands(), fn
             {"shuttle", args} -> "--ids-from" in args
             _ -> false
           end)

    known = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    assert Enum.any?(known, &(Map.get(&1, "id") == original))

    MockRunner.set_shuttle(
      original,
      "enabled: true\nhost: another-host\nkind: oneshot\n",
      "active"
    )

    sync_poll_cycle!(poller)
    refreshed = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    assert Enum.find(refreshed, &(Map.get(&1, "id") == original))["status"] == "active"

    :sys.replace_state(poller, fn state ->
      info = Map.fetch!(state.discovery, MockRunner.felt_root())

      %{
        state
        | discovery:
            Map.put(state.discovery, MockRunner.felt_root(), %{info | next_full_due_at: 0})
      }
    end)

    MockRunner.delete_fiber(original)
    sync_poll_cycle!(poller)
    settled = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    refute Enum.any?(settled, &(Map.get(&1, "id") == original))

    {_command, args} =
      Enum.find(Enum.reverse(MockRunner.commands()), fn {cmd, args} ->
        cmd == "shuttle" and "--ids-from" in args
      end)

    ids_path = Enum.at(args, Enum.find_index(args, &(&1 == "--ids-from")) + 1)
    refute File.exists?(ids_path)
  end

  @tag :adaptive_discovery
  test "a timed-out full scan enters hot mode and waits until its next due time" do
    id = "tests/discovery-timeout"
    MockRunner.set_fiber(id, make_fiber(id, %{"status" => "open"}))
    MockRunner.set_shuttle(id, "enabled: true\nhost: another-host\nkind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_timeout,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_timeout_ms: 50,
        full_scan_budget_ms: 1_000,
        full_scan_min_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    :sys.replace_state(poller, fn state ->
      slow = %{mode: :hot, last_full_duration_ms: 100, next_full_due_at: 0}
      %{state | discovery: Map.put(state.discovery, MockRunner.felt_root(), slow)}
    end)

    MockRunner.set_listing_timeout(true)
    sync_poll_cycle!(poller)

    info = :sys.get_state(poller, @state_timeout).discovery[MockRunner.felt_root()]
    assert info.mode == :hot
    assert is_integer(info.next_full_due_at)
    assert info.next_full_due_at > System.system_time(:millisecond)

    MockRunner.set_listing_timeout(false)
    commands_before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    hot_success = Enum.drop(MockRunner.commands(), commands_before)
    assert Enum.any?(hot_success, fn {cmd, args} -> cmd == "shuttle" and "--ids-from" in args end)

    refute Enum.any?(hot_success, fn {cmd, args} ->
             cmd == "shuttle" and "ls" in args and "--ids-from" not in args
           end)

    commands_before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    following = Enum.drop(MockRunner.commands(), commands_before)
    assert Enum.any?(following, fn {cmd, args} -> cmd == "shuttle" and "--ids-from" in args end)

    refute Enum.any?(following, fn {cmd, args} ->
             cmd == "shuttle" and "ls" in args and "--ids-from" not in args
           end)
  end

  @tag :adaptive_discovery
  test "a rename returned by uid replaces the retained address on a hot tick" do
    original = "tests/discovery-rename-old"
    renamed = "tests/discovery-rename-new"
    uid = Shuttle.Test.FiberUid.for(original)
    MockRunner.set_fiber(original, make_fiber(original, %{"uid" => uid}))
    MockRunner.set_shuttle(original, "kind: oneshot\n", "open")
    MockRunner.set_ls_delay(15)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_rename,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 1,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    MockRunner.set_fiber(renamed, make_fiber(renamed, %{"uid" => uid}))
    MockRunner.set_shuttle(renamed, "kind: oneshot\n", "open")
    MockRunner.set_ids_from_alias(original, renamed)
    MockRunner.delete_fiber(original)

    sync_poll_cycle!(poller)

    rows = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    assert Enum.any?(rows, &(&1["id"] == renamed and &1["uid"] == uid))
    refute Enum.any?(rows, &(&1["id"] == original))
  end

  @tag :adaptive_discovery
  test "a returned hot row owned by another store evicts its retained row" do
    id = "tests/discovery-moved"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")
    MockRunner.set_ls_delay(15)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_foreign,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_budget_ms: 1,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :hot
    moved = Map.put(MockRunner.fiber(id), "path", "/tmp/foreign/.felt/moved.md")
    MockRunner.set_fiber(id, moved)
    assert MockRunner.fiber(id)["path"] == "/tmp/foreign/.felt/moved.md"
    before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    cycle_commands = Enum.drop(MockRunner.commands(), before)

    assert Enum.any?(cycle_commands, fn {cmd, args} ->
             cmd == "shuttle" and "--ids-from" in args
           end)

    rows = :sys.get_state(poller, @state_timeout).last_known_listings[MockRunner.felt_root()]
    refute Enum.any?(rows, &(&1["id"] == id))
  end

  @tag :adaptive_discovery
  test "a non-timeout full-listing error leaves a fast store in full mode" do
    id = "tests/discovery-fast-error"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_fast_error,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    before = :sys.get_state(poller, @state_timeout).discovery[MockRunner.felt_root()]
    MockRunner.set_listing_error(2)
    sync_poll_cycle!(poller)

    info = :sys.get_state(poller, @state_timeout).discovery[MockRunner.felt_root()]
    assert info.mode == :full

    assert Map.get(info, :last_full_timed_out, false) ==
             Map.get(before, :last_full_timed_out, false)

    assert info.last_full_duration_ms == before.last_full_duration_ms
    assert info.next_full_due_at == before.next_full_due_at
  end

  @tag :adaptive_discovery
  test "live orphan reconciliation uses the current poll listing without a second discovery" do
    id = "tests/discovery-live-orphan"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_live_reconcile,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)
    MockRunner.add_tmux_session(Shuttle.Test.FiberUid.session(id))
    before = length(MockRunner.commands())
    sync_poll_cycle!(poller)
    cycle_commands = Enum.drop(MockRunner.commands(), before)

    assert Enum.count(cycle_commands, fn
             {"shuttle", args} -> "--has-field" in args
             _ -> false
           end) == 1

    assert Poller.worker_status(poller, id)
  end

  @tag :adaptive_discovery
  test "boot adoption seeds its full listing for the first poll" do
    id = "tests/discovery-boot-seed"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")
    MockRunner.add_tmux_session(Shuttle.Test.FiberUid.session(id))

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_boot_seed,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    shuttle_ls =
      Enum.filter(MockRunner.commands(), fn
        {"shuttle", args} -> "--has-field" in args
        _ -> false
      end)

    assert Enum.count(shuttle_ls, fn {_cmd, args} -> "--ids-from" not in args end) == 1
    assert Enum.count(shuttle_ls, fn {_cmd, args} -> "--ids-from" in args end) == 1
  end

  @tag :adaptive_discovery
  test "a timed-out boot listing starts slow mode with a full retry in the poll task" do
    id = "tests/discovery-boot-timeout"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, "kind: oneshot\n", "open")
    MockRunner.set_listing_timeout(true)

    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_boot_timeout,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        full_scan_timeout_ms: 100,
        full_scan_min_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    settle_poller!(poller)

    listings =
      Enum.filter(MockRunner.commands(), fn
        {"shuttle", args} -> "--has-field" in args
        _ -> false
      end)

    assert length(listings) >= 2
    refute Enum.any?(listings, fn {_cmd, args} -> "--ids-from" in args end)
    assert Poller.snapshot(poller).poll_health.discovery[MockRunner.felt_root()].mode == :hot
  end

  @tag :adaptive_discovery
  test "the watchdog bound follows stores added after init" do
    {:ok, poller} =
      start_poller!(
        name: :test_poller_discovery_watchdog_grows,
        runner: MockRunner,
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        stall_timeout_ms: 1,
        full_scan_timeout_ms: 50_000,
        felt_stores: ["/tmp/store-a"]
      )

    settle_poller!(poller)

    :sys.replace_state(poller, fn state ->
      %{state | felt_stores: ["/tmp/store-a", "/tmp/store-b"]}
    end)

    sync_poll_cycle!(poller)
    state = :sys.get_state(poller, @state_timeout)
    assert state.stall_timeout_ms == 3 * state.full_scan_timeout_ms * 2 + 1_000
  end

  defp notify_worker_exit(poller, fiber_id) do
    %{pid: watcher, session: session} = Poller.worker_status(poller, fiber_id)
    send(poller, {:worker_exited, fiber_id, watcher, session, :normal_exit})
  end

  # A worker's tmux session ends and its watcher reports the exit. The watcher
  # identity is read while the session is still live: once it is gone, a
  # watcher or poll cycle may observe that first and release the claim.
  defp end_worker_session(poller, fiber_id) do
    %{pid: watcher, session: session} = Poller.worker_status(poller, fiber_id)
    MockRunner.remove_tmux_session(session)
    send(poller, {:worker_exited, fiber_id, watcher, session, :normal_exit})
  end
end
