defmodule Shuttle.PollerStopTest do
  # The Poller: kill, rest and New-session cuts of live workers.
  use Shuttle.Test.PollerCase, async: true

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

  # rest goes through the Poller like resume: the --local write
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
    assert {"tmux", ["kill-session", "-t", "=" <> session]} in MockRunner.commands()
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
    assert {"tmux", ["kill-session", "-t", "=" <> session]} in MockRunner.commands()
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
    assert {"tmux", ["kill-session", "-t", "=" <> session]} in MockRunner.commands()
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

    assert Shuttle.Terminal.present?(MockRunner, first_session)

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
        {"tmux", ["kill-session", "-t", target]} -> target == "=" <> first_session
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

    # Only a confirmed stop authorizes a clean-exit marker and replacement.
    assert kill_idx < marker_idx
    assert marker_idx < new_idx

    # The fiber is live again under a fresh session (same canonical name).
    assert Shuttle.Terminal.present?(MockRunner, second_session)
  end

  for backend <- [Shuttle.Terminal.Tmux, Shuttle.Terminal.Rex] do
    @tag backend: backend
    test "New session preserves the handoff marker and tracking when #{inspect(backend)} cannot stop",
         %{backend: backend} do
      Env.put_app_env(:terminal_backend, backend)

      if backend == Shuttle.Terminal.Rex do
        Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
        Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      end

      id = "tests/cut-stop-failed"
      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
        "active"
      )

      {:ok, poller} =
        start_poller!(
          runner: Shuttle.Test.PollerCase.PhantomRunner,
          own_host_id: "test-host",
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true, ad_hoc: true)
      before = get_in(MockRunner.fiber(id), ["shuttle", "runtime", "handed_off_at"])
      %{pid: watcher} = Poller.worker_status(poller, id)

      if backend == Shuttle.Terminal.Rex,
        do: Shuttle.Test.FakeRex.reply("session.close_window", {"request timed out", :timeout}),
        else: MockRunner.set_kill_session_failure(true)

      assert {:error, :already_running} =
               Poller.dispatch_fiber(poller, id, force: true, ad_hoc: true, resume_mode: "fresh")

      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "handed_off_at"]) == before
      assert %{pid: ^watcher, session: ^session} = Poller.worker_status(poller, id)
      assert Process.alive?(watcher)
      assert Shuttle.Terminal.status(Shuttle.Test.PollerCase.PhantomRunner, session) == :alive
    end

    @tag backend: backend
    @tag :review_cut_marker
    test "a failed cut marker write after #{inspect(backend)} stops refuses replacement without crashing",
         %{backend: backend} do
      Env.put_app_env(:terminal_backend, backend)

      if backend == Shuttle.Terminal.Rex do
        Env.put_app_env(:fake_rex, start_supervised!(Shuttle.Test.FakeRex))
        Env.put_env("SHUTTLE_REX_BIN", "/bin/echo")
      end

      id = "tests/cut-marker-failed"
      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
        "active"
      )

      runner = Shuttle.Test.PollerCase.PhantomRunner

      {:ok, poller} =
        start_poller!(
          runner: runner,
          own_host_id: "test-host",
          poll_interval_ms: 60_000,
          max_concurrent_workers: 0,
          felt_stores: [MockRunner.felt_root()]
        )

      assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true, ad_hoc: true)
      %{pid: watcher} = Poller.worker_status(poller, id)
      Env.put_app_env(:phantom_runtime_write_fails, true)

      assert {:error, {:handoff_failed, reason}} =
               Poller.dispatch_fiber(poller, id, force: true, ad_hoc: true, resume_mode: "fresh")

      assert reason =~ "runtime write failed"
      assert Process.alive?(poller)
      refute Process.alive?(watcher)
      assert Poller.worker_status(poller, id) == nil
      assert :gone = Shuttle.Terminal.status(runner, session)

      if backend == Shuttle.Terminal.Rex do
        assert Enum.count(Shuttle.Test.FakeRex.calls(), fn {_, args, _} ->
                 "session.create" in args
               end) == 1
      else
        assert length(new_session_scripts()) == 1
      end
    end
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

    assert Shuttle.Terminal.present?(MockRunner, session)
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
    assert Shuttle.Terminal.present?(MockRunner, session)
  end

  test "Resume with a message on a live session types it into the conversation as the human's turn" do
    fiber_id = "tests/resume-paste"
    uid = "01JZ00000000000000000000RP"

    MockRunner.set_fiber(fiber_id, make_fiber(fiber_id, %{"uid" => uid, "status" => "active"}))

    MockRunner.set_shuttle(
      fiber_id,
      "kind: oneshot\nagent: claude-sonnet\nhost: test-host\n",
      "active"
    )

    {:ok, poller} =
      start_poller!(
        name: :test_poller_resume_paste,
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        max_concurrent_workers: 0,
        felt_stores: [MockRunner.felt_root()]
      )

    Shuttle.Test.Env.put_app_env(:paste_submit_delay_ms, 0)

    assert {:error, :no_live_worker} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               existing_only: true,
               resume_mode: "previous",
               user_message: "Review"
             )

    refute Enum.any?(MockRunner.commands(), fn
             {"tmux", ["new-session" | _]} -> true
             {"shuttle", [verb | _]} -> verb in ["reopen", "install"]
             _ -> false
           end)

    assert {:ok, session} = Poller.dispatch_fiber(poller, fiber_id, force: true, ad_hoc: true)
    before = length(MockRunner.commands())

    assert {:ok, ^session} =
             Poller.dispatch_fiber(poller, fiber_id,
               force: true,
               ad_hoc: true,
               resume_mode: "previous",
               user_message: "line one\nline two",
               existing_only: true
             )

    commands = MockRunner.commands() |> Enum.drop(before)

    assert Enum.any?(commands, &match?({"tmux", ["load-buffer" | _]}, &1))
    assert {"tmux", ["send-keys", "-t", "=" <> session <> ":", "Enter"]} in commands

    assert Enum.any?(commands, fn
             {"tmux", ["paste-buffer", "-p", "-d", "-b", _, "-t", target]} ->
               target == "=" <> session <> ":"

             _ ->
               false
           end)

    refute Enum.any?(commands, &match?({"tmux", ["kill-session" | _]}, &1))
    refute Enum.any?(commands, &match?({"tmux", ["new-session" | _]}, &1))
  end
end
