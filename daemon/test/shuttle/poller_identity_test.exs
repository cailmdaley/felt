defmodule Shuttle.PollerIdentityTest do
  # The Poller: worker identity capture, successors and resume fallback.
  use Shuttle.Test.PollerCase, async: true

  test "fresh dispatch replaces a predecessor before binding persistence runs" do
    id = "tests/fresh-binding"
    now = System.system_time(:millisecond)

    events = [
      %{
        "sessionId" => "old",
        "type" => "session_start",
        "timestamp" => now,
        "harness" => "claude-code",
        "receiverPid" => 10,
        "receiverBirth" => "a"
      },
      %{
        "sessionId" => "cleared",
        "type" => "session_start",
        "timestamp" => now + 1,
        "harness" => "claude-code",
        "receiverPid" => 10,
        "receiverBirth" => "a"
      }
    ]

    binding =
      Enum.reduce(
        events,
        Shuttle.SessionBinding.new(),
        &Shuttle.SessionBinding.apply_event(&2, &1, now)
      )

    Env.put_app_env(:session_bindings_source, fn -> binding end)

    Env.put_app_env(:waiting_phases_source, fn ->
      %{"cleared" => %{phase: "waiting", last_event_at: now}}
    end)

    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nruntime:\n  session_uuid: old\n  dispatched_at: 2020-01-01T00:00:00Z\n  handed_off_at: 2021-01-01T00:00:00Z\n"
    )

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    assert {:ok, %{fibers: [%{runtime: runtime}]}} = Poller.cached_fiber_documents(poller)
    assert runtime.session_uuid not in [nil, "old", "cleared"]
    refute Map.has_key?(runtime, :phase)

    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) ==
             runtime.session_uuid
  end

  for {cli, agent, project} <- [
        {"pi", "pi-luna", :absolute},
        {"pi", "pi-luna", :tilde},
        {"pi", "pi-luna", :empty},
        {"pi", "pi-luna", :old},
        {"codex", "codex", :absolute},
        {"codex", "codex", :tilde},
        {"codex", "codex", :empty},
        {"codex", "codex", :old}
      ] do
    @tag :pr53_identity
    @tag :timing
    test "restart retries #{cli} identity capture with #{project} project path after a visible timeout" do
      cli = unquote(cli)
      id = "tests/recover-#{cli}"
      root = MockRunner.felt_root()
      Env.put_env("SHUTTLE_PI_SESSIONS_DIR", Path.join(root, "pi-sessions"))
      Env.put_env("SHUTTLE_CODEX_SESSIONS_DIR", Path.join(root, "codex-sessions"))
      Env.put_app_env(:session_capture_timeout_ms, 25)
      Env.put_app_env(:session_capture_poll_ms, 5)
      Env.put_app_env(:session_capture_retry_ms, 100)

      dispatched_at =
        DateTime.add(
          DateTime.utc_now(),
          if(unquote(project) == :old, do: -4 * 86400, else: 0),
          :second
        )

      boundary = DateTime.to_iso8601(dispatched_at)
      Env.put_env("HOME", Path.dirname(root))

      project_dir =
        case unquote(project) do
          path when path in [:absolute, :old] -> root
          :tilde -> "~/#{Path.basename(root)}"
          :empty -> "\"\""
        end

      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "kind: oneshot\nagent: #{unquote(agent)}\nrole: gardener\nproject_dir: #{project_dir}\nruntime:\n  dispatched_at: #{boundary}\n"
      )

      MockRunner.add_tmux_session(FiberUid.session(id))

      Env.put_app_env(:waiting_phases_source, fn ->
        %{FiberUid.session(id) => %{phase: "working", last_event_at: 1}}
      end)

      opts = [
        runner: IdentityRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [root]
      ]

      {:ok, first} = start_poller!(opts)
      settle_poller!(first)
      assert {:ok, %{fibers: [%{runtime: pending}]}} = Poller.cached_fiber_documents(first)
      assert pending.identity_pending
      assert pending.phase in ["identity_pending", "identity_failed"]
      assert pending.session_uuid == nil

      assert_eventually(fn ->
        assert {:ok, %{fibers: [%{runtime: %{phase: "identity_failed", identity_error: error}}]}} =
                 Poller.cached_fiber_documents(first)

        assert error =~ "timed out"

        assert [%{identity_pending: true, phase: "identity_failed"}] =
                 Poller.snapshot(first).eligible
      end)

      GenServer.stop(first)
      # Another restart must retry, even though the previous daemon exhausted capture.
      {:ok, poller} = start_poller!(opts)
      settle_poller!(poller)

      assert_eventually(fn ->
        assert {:ok, %{fibers: [%{runtime: %{phase: "identity_failed"}}]}} =
                 Poller.cached_fiber_documents(poller)
      end)

      [{_, worker}] = Map.to_list(:sys.get_state(poller).running)
      assert worker.role == "gardener"

      # Identity retries must retain the office observed at adoption, even if
      # the constitution is reassigned before its transcript becomes visible.
      MockRunner.set_shuttle(
        id,
        "kind: oneshot\nagent: #{unquote(agent)}\nrole: reviewer\nproject_dir: #{project_dir}\nruntime:\n  dispatched_at: #{boundary}\n"
      )

      uuid = "recovered-#{cli}"
      header = %{"id" => uuid, "cwd" => root, "timestamp" => boundary}

      {path, wrap_header} =
        case cli do
          "pi" ->
            {Path.join(Shuttle.HarnessPaths.pi_sessions_dir(root), "session.jsonl"),
             &Map.put(&1, "type", "session")}

          "codex" ->
            day = dispatched_at |> DateTime.to_date() |> Calendar.strftime("%Y/%m/%d")

            {Path.join([root, "codex-sessions", day, "rollout-session.jsonl"]),
             &%{"type" => "session_meta", "payload" => &1}}
        end

      event = wrap_header.(header)

      File.mkdir_p!(Path.dirname(path))

      if unquote(project) == :old do
        for {label, candidate, prompt} <- [
              {"wrong-cwd", Map.put(header, "cwd", Path.join(root, "other")), id},
              {"too-early",
               Map.put(
                 header,
                 "timestamp",
                 DateTime.to_iso8601(DateTime.add(dispatched_at, -60, :second))
               ), id},
              {"wrong-fiber", header, "another-fiber"}
            ] do
          candidate = Map.put(candidate, "id", label)

          File.write!(
            Path.join(Path.dirname(path), "rollout-zzzz-#{label}.jsonl"),
            Jason.encode!(wrap_header.(candidate)) <>
              "\n" <> Jason.encode!(%{"text" => "Fiber: #{prompt}"}) <> "\n"
          )
        end
      end

      File.write!(
        path,
        Jason.encode!(event) <> "\n" <> Jason.encode!(%{"text" => "Fiber: #{id}"}) <> "\n"
      )

      # The timeout's scheduled retry must find the late transcript without a manual retry.
      assert_eventually(fn -> assert Poller.session_uuid(poller, id) == uuid end)
      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == uuid
      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == boundary
      assert get_in(MockRunner.fiber(id), ["shuttle", "role"]) == "reviewer"

      assert [%{"role" => "gardener"}] =
               Enum.filter(Shuttle.SessionLedger.read_since(0), &(&1["session"] == uuid))

      assert {:ok, %{fibers: [%{runtime: recovered}]}} = Poller.cached_fiber_documents(poller)
      refute recovered.identity_pending
      refute Map.has_key?(recovered, :identity_error)
      refute recovered[:phase] == "working"
      # A timeout/callback from an earlier attempt cannot unbind acquired identity.
      send(poller, {:identity_capture_failed, id, worker.identity_token, "late timeout"})
      send(poller, {:captured_session, id, worker.identity_token, "stale", [felt_store: root]})
      assert Poller.session_uuid(poller, id) == uuid
    end
  end

  @tag :pr53_identity
  test "existing-worker claim repairs missing identity without moving dispatch boundary" do
    id = "tests/claim-missing-identity"
    root = MockRunner.felt_root()
    boundary = "2026-10-10T12:00:00Z"
    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nagent: pi-luna\nrole: gardener\nproject_dir: #{root}\nruntime:\n  dispatched_at: #{boundary}\n"
    )

    MockRunner.add_tmux_session(FiberUid.session(id))

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [root]
      )

    settle_poller!(poller)

    [{_, pending_worker}] = Map.to_list(:sys.get_state(poller).running)
    assert pending_worker.role == "gardener"

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nagent: pi-luna\nrole: reviewer\nproject_dir: #{root}\nruntime:\n  dispatched_at: #{boundary}\n"
    )

    Poller.refresh_document(poller, id)

    assert {:ok, _} =
             Poller.claim_session(poller, id, FiberUid.session(id), session_uuid: "claimed-uuid")

    assert Poller.session_uuid(poller, id) == "claimed-uuid"
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "claimed-uuid"
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == boundary

    assert {:ok, _} =
             Poller.claim_session(poller, id, FiberUid.session(id), session_uuid: "different")

    send(poller, {:fallback_started, id, pending_worker.identity_token, [felt_store: root]})
    assert Poller.session_uuid(poller, id) == "claimed-uuid"

    assert [%{"role" => "gardener", "kind" => "claim"}] =
             Enum.filter(Shuttle.SessionLedger.read_since(0), &(&1["session"] == "claimed-uuid"))
  end

  @tag :pr53_successor
  test "adopted CLI persists successor into owning store and rejoins after evidence removal and restart" do
    id = "tests/adopted-successor"
    root = MockRunner.felt_root()
    primary = Path.join(root, "other-store")
    File.mkdir_p!(Path.join(primary, ".felt"))
    boundary = "2026-10-10T12:00:00Z"
    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nagent: pi-luna\nruntime:\n  dispatched_at: #{boundary}\n  session_uuid: A\n"
    )

    MockRunner.add_tmux_session(FiberUid.session(id))
    Env.put_app_env(:session_bindings_source, fn -> Shuttle.SessionBinding.new() end)

    Env.put_app_env(:waiting_phases_source, fn ->
      %{
        "A" => %{phase: "working", last_event_at: 1},
        "B" => %{phase: "waiting", last_event_at: 2}
      }
    end)

    opts = [
      runner: MockRunner,
      own_host_id: "test-host",
      poll_interval_ms: 60_000,
      felt_stores: [primary, root]
    ]

    {:ok, poller} = start_poller!(opts)
    settle_poller!(poller)

    assert {:ok, %{fibers: [%{runtime: %{session_uuid: "A", phase: "working"}}]}} =
             Poller.cached_fiber_documents(poller)

    # This is an adopted worker, not a worker whose dispatch supplied felt_store.
    refute Enum.any?(MockRunner.commands(), fn {cmd, args} ->
             cmd == "tmux" and match?(["new-session" | _], args)
           end)

    now = System.system_time(:millisecond)

    binding =
      Enum.reduce(
        [
          %{
            "sessionId" => "A",
            "type" => "stop",
            "timestamp" => now,
            "harness" => "pi",
            "receiverPid" => 123,
            "receiverBirth" => "receiver"
          },
          %{
            "sessionId" => "B",
            "type" => "session_start",
            "timestamp" => now + 1,
            "harness" => "pi",
            "receiverPid" => 123,
            "receiverBirth" => "receiver"
          }
        ],
        Shuttle.SessionBinding.new(),
        &Shuttle.SessionBinding.apply_event(&2, &1, now)
      )

    Env.put_app_env(:session_bindings_source, fn -> binding end)
    sync_poll_cycle!(poller)
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "B"
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == boundary

    successor_writes =
      for {"shuttle", ["-C", store, "mark-runtime", ^id | flags]} <- MockRunner.commands(),
          ["--session", "B"] in Enum.chunk_every(flags, 2, 1, :discard),
          do: store

    assert [^root] = successor_writes
    [{_, adopted}] = Map.to_list(:sys.get_state(poller).running)
    assert adopted.felt_store == root
    # Re-adoption keeps the worker's durable dispatch time, not the boot time.
    assert DateTime.to_iso8601(adopted.started_at) == boundary

    assert Enum.any?(
             Shuttle.SessionLedger.read_since(0),
             &(&1["session"] == "B" and &1["kind"] == "resume")
           )

    assert {:ok, %{fibers: [%{runtime: %{session_uuid: "B", phase: "waiting"}}]}} =
             Poller.cached_fiber_documents(poller)

    GenServer.stop(poller)
    # Neither binding projection nor retained anchor evidence knows A -> B anymore.
    Env.put_app_env(:session_bindings_source, fn -> Shuttle.SessionBinding.new() end)

    Env.put_app_env(:waiting_phases_source, fn ->
      %{"B" => %{phase: "waiting", last_event_at: 2}}
    end)

    {:ok, restarted} = start_poller!(opts)
    settle_poller!(restarted)
    assert Poller.session_uuid(restarted, id) == "B"

    assert {:ok, %{fibers: [%{runtime: %{session_uuid: "B", phase: "waiting"}}]}} =
             Poller.cached_fiber_documents(restarted)

    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "B"
  end

  test "poll tick persists successor without changing dispatch boundary" do
    id = "tests/persist-binding"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, oneshot_shuttle() <> "role: gardener\n")

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    original = get_in(MockRunner.fiber(id), ["shuttle", "runtime"])
    now = System.system_time(:millisecond)

    events = [
      %{
        "sessionId" => original["session_uuid"],
        "type" => "stop",
        "timestamp" => now,
        "harness" => "claude-code",
        "receiverPid" => 10,
        "receiverBirth" => "a"
      },
      %{
        "sessionId" => "successor",
        "type" => "session_start",
        "timestamp" => now + 1,
        "harness" => "claude-code",
        "receiverPid" => 10,
        "receiverBirth" => "a"
      }
    ]

    binding =
      Enum.reduce(
        events,
        Shuttle.SessionBinding.new(),
        &Shuttle.SessionBinding.apply_event(&2, &1, now)
      )

    Env.put_app_env(:session_bindings_source, fn -> binding end)

    MockRunner.set_shuttle(
      id,
      oneshot_shuttle() <>
        "role: reviewer\nruntime:\n  dispatched_at: #{original["dispatched_at"]}\n  session_uuid: #{original["session_uuid"]}\n"
    )

    Poller.refresh_document(poller, id)
    sync_poll_cycle!(poller)
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "successor"

    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) ==
             original["dispatched_at"]

    assert {:ok, %{fibers: [%{runtime: %{session_uuid: "successor"}}]}} =
             Poller.cached_fiber_documents(poller)

    assert [%{"role" => "gardener", "kind" => "resume"}] =
             Enum.filter(Shuttle.SessionLedger.read_since(0), &(&1["session"] == "successor"))
  end

  test "fallback becomes identity-pending, capture initializes once, and stale capture cannot overwrite" do
    id = "tests/capture-binding"
    MockRunner.set_fiber(id, make_fiber(id))
    MockRunner.set_shuttle(id, oneshot_shuttle())

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [MockRunner.felt_root()]
      )

    sync_poll_cycle!(poller)
    state = :sys.get_state(poller)
    [{_key, worker}] = Map.to_list(state.running)
    opts = [felt_store: MockRunner.felt_root(), tmux: worker.session, harness: "pi"]
    stale_uuid = get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"])
    now = System.system_time(:millisecond)

    binding =
      Enum.reduce(
        [
          %{
            "sessionId" => stale_uuid,
            "type" => "session_start",
            "timestamp" => now,
            "harness" => "pi",
            "receiverPid" => 3,
            "receiverBirth" => "a"
          },
          %{
            "sessionId" => "stale-successor",
            "type" => "session_start",
            "timestamp" => now + 1,
            "harness" => "pi",
            "receiverPid" => 3,
            "receiverBirth" => "a"
          }
        ],
        Shuttle.SessionBinding.new(),
        &Shuttle.SessionBinding.apply_event(&2, &1, now)
      )

    Env.put_app_env(:session_bindings_source, fn -> binding end)

    Env.put_app_env(:waiting_phases_source, fn ->
      %{
        stale_uuid => %{phase: "waiting", last_event_at: now},
        "stale-successor" => %{phase: "waiting", last_event_at: now + 1}
      }
    end)

    MockRunner.set_show_missing(true)
    send(poller, {:fallback_started, id, worker.identity_token, opts})
    :sys.get_state(poller, @state_timeout)
    assert {:ok, %{fibers: [%{runtime: pending}]}} = Poller.cached_fiber_documents(poller)
    assert pending.session_uuid == nil
    assert pending.identity_pending
    assert pending.phase == "identity_pending"
    assert Poller.session_uuid(poller, id) == nil
    sync_poll_cycle!(poller)
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == ""
    send(poller, {:captured_session, id, worker.identity_token, "captured", opts})
    :sys.get_state(poller, @state_timeout)
    assert Poller.session_uuid(poller, id) == "captured"
    send(poller, {:captured_session, id, worker.identity_token, "stale", opts})
    send(poller, {:captured_session, id, make_ref(), "wrong-launch", opts})
    :sys.get_state(poller, @state_timeout)
    assert Poller.session_uuid(poller, id) == "captured"
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "captured"
  end

  for failure <- [
        :restart_before_fallback,
        :fallback_while_down,
        :clear_write_failure,
        :succession_before_fallback
      ] do
    @tag pr53_fallback_succession: failure == :succession_before_fallback
    @tag fallback_failure: failure
    @tag :pr53_fallback_recovery
    @tag :timing
    test "resume fallback recovers after #{failure}", %{fallback_failure: failure} do
      id = "tests/fallback-#{failure}"
      root = MockRunner.felt_root()
      Env.put_env("SHUTTLE_PI_SESSIONS_DIR", Path.join(root, "pi-sessions"))
      Env.put_app_env(:session_capture_timeout_ms, 25)
      Env.put_app_env(:session_capture_poll_ms, 5)
      Env.put_app_env(:session_capture_retry_ms, 100)
      MockRunner.set_fiber(id, make_fiber(id))

      MockRunner.set_shuttle(
        id,
        "kind: oneshot\nagent: pi-luna\nruntime:\n  session_uuid: predecessor\n  dispatched_at: 2020-01-01T00:00:00Z\n",
        "open"
      )

      opts = [
        runner: IdentityRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [root]
      ]

      {:ok, first} = start_poller!(opts)
      settle_poller!(first)

      assert {:ok, session} =
               Poller.dispatch_fiber(first, id, force: true, resume_mode: "previous")

      boundary = get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"])

      {"tmux", args} =
        Enum.find(MockRunner.commands(), fn {cmd, args} ->
          cmd == "tmux" and match?(["new-session", "-d", "-s", ^session | _], args)
        end)

      assert [_, signal] = Regex.run(~r/\|\| \{ touch '([^']+)';/, File.read!(List.last(args)))

      if failure == :succession_before_fallback do
        now = System.system_time(:millisecond)

        binding =
          Enum.reduce(
            [
              %{
                "sessionId" => "predecessor",
                "type" => "stop",
                "timestamp" => now,
                "harness" => "pi",
                "receiverPid" => 123,
                "receiverBirth" => "receiver"
              },
              %{
                "sessionId" => "successor",
                "type" => "session_start",
                "timestamp" => now + 1,
                "harness" => "pi",
                "receiverPid" => 123,
                "receiverBirth" => "receiver"
              }
            ],
            Shuttle.SessionBinding.new(),
            &Shuttle.SessionBinding.apply_event(&2, &1, now)
          )

        Env.put_app_env(:session_bindings_source, fn -> binding end)
        sync_poll_cycle!(first)
        assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "successor"
      end

      poller =
        if failure in [
             :restart_before_fallback,
             :fallback_while_down,
             :succession_before_fallback
           ] do
          GenServer.stop(first)
          if failure == :fallback_while_down, do: File.touch!(signal)
          {:ok, restarted} = start_poller!(opts)
          settle_poller!(restarted)

          if failure == :restart_before_fallback,
            do: assert(Poller.session_uuid(restarted, id) == "predecessor")

          restarted
        else
          Env.put_app_env(:identity_clear_fail, true)
          first
        end

      File.touch!(signal)

      assert_eventually(fn ->
        assert Poller.session_uuid(poller, id) == nil

        assert {:ok, %{fibers: [%{runtime: %{phase: "identity_failed", identity_pending: true}}]}} =
                 Poller.cached_fiber_documents(poller)
      end)

      if failure == :clear_write_failure do
        assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) ==
                 "predecessor"

        Env.put_app_env(:identity_clear_fail, false)
      end

      sessions = Shuttle.HarnessPaths.pi_sessions_dir(root)
      File.mkdir_p!(sessions)

      header = %{
        "type" => "session",
        "id" => "fresh-fallback",
        "cwd" => root,
        "timestamp" => boundary
      }

      File.write!(
        Path.join(sessions, "fallback.jsonl"),
        Jason.encode!(header) <> "\nFiber: #{id}\n"
      )

      assert_eventually(fn -> assert Poller.session_uuid(poller, id) == "fresh-fallback" end)

      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) ==
               "fresh-fallback"

      assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) == boundary
      GenServer.stop(poller)
      {:ok, last} = start_poller!(opts)
      settle_poller!(last)
      assert Poller.session_uuid(last, id) == "fresh-fallback"
    end
  end

  test "failed Pi resume signal clears identity and captures the fresh fallback" do
    id = "tests/pi-fallback"
    root = MockRunner.felt_root()
    Env.put_env("SHUTTLE_PI_SESSIONS_DIR", Path.join(root, "pi-sessions"))
    MockRunner.set_fiber(id, make_fiber(id))

    MockRunner.set_shuttle(
      id,
      "kind: oneshot\nagent: pi-luna\nruntime:\n  session_uuid: resume-target\n  dispatched_at: 2020-01-01T00:00:00Z\n",
      "open"
    )

    {:ok, poller} =
      start_poller!(
        runner: MockRunner,
        own_host_id: "test-host",
        poll_interval_ms: 60_000,
        felt_stores: [root]
      )

    sync_poll_cycle!(poller)

    assert {:ok, session} =
             Poller.dispatch_fiber(poller, id, force: true, resume_mode: "previous")

    {"tmux", spawn_args} =
      Enum.find(MockRunner.commands(), fn {command, args} ->
        command == "tmux" and match?(["new-session", "-d", "-s", ^session | _], args)
      end)

    script = File.read!(List.last(spawn_args))
    assert [_, signal] = Regex.run(~r/\|\| \{ touch '([^']+)';/, script)
    assert {:ok, %{mode: mode}} = File.stat(Path.dirname(signal))
    assert Bitwise.band(mode, 0o777) == 0o700
    assert wait_until(fn -> Poller.session_uuid(poller, id) == "resume-target" end)
    File.touch!(signal)
    assert wait_until(fn -> Poller.session_uuid(poller, id) == nil end)
    assert {:ok, %{fibers: [%{runtime: pending}]}} = Poller.cached_fiber_documents(poller)
    assert pending.identity_pending
    assert pending.phase == "identity_pending"
    sessions = Shuttle.HarnessPaths.pi_sessions_dir(root)
    File.mkdir_p!(sessions)

    header = %{
      "type" => "session",
      "id" => "fallback-uuid",
      "cwd" => root,
      "timestamp" => DateTime.to_iso8601(DateTime.utc_now())
    }

    File.write!(
      Path.join(sessions, "fallback.jsonl"),
      Jason.encode!(header) <> "\nFiber: #{id}\nFiber: pi-fallback\n"
    )

    assert wait_until(fn -> Poller.session_uuid(poller, id) == "fallback-uuid" end)
    assert get_in(MockRunner.fiber(id), ["shuttle", "runtime", "session_uuid"]) == "fallback-uuid"

    # The launch-scoped signal survives daemon death; a captured UUID no longer matches its predecessor.
    assert File.exists?(signal)
  end
end
