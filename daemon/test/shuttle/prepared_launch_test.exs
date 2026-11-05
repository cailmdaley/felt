defmodule Shuttle.PreparedLaunchTest do
  use ExUnit.Case, async: true
  import Shuttle.Test.PollerHelpers
  alias Shuttle.Test.{Env, FeltStoreRunner}
  alias Shuttle.{Dispatcher, Poller, Terminal}

  defmodule Runner do
    def cmd("tmux", ["new-session" | _] = args, opts) do
      # The terminal runs a safe foreground process instead of a model harness.
      script =
        case Shuttle.Env.app(:prepared_effect_root) do
          nil ->
            "trap 'rm -f \"$0\"' EXIT\nsleep 300\n"

          root ->
            """
            trap 'rm -f "$0"' EXIT
            while [ ! -f '#{root}/effect-go' ]; do sleep .02; done
            printf 'effect\\n' >> '#{root}/effects'
            """
        end

      File.write!(List.last(args), script)
      send(Shuttle.Env.app(:prepared_owner), :prepared_create)
      result = tmux(args, opts)
      if Shuttle.Env.app(:prepared_fault) == :crash, do: throw(:launch_crash)
      result
    end

    def cmd("tmux", args, opts), do: tmux(args, opts)

    def cmd("ps", args, opts) do
      {output, status} = Shuttle.Runner.Default.cmd("ps", args, opts)
      prefix = Path.join(System.tmp_dir!(), "shuttle-run-")

      {output
       |> String.split("\n")
       |> Enum.filter(&String.contains?(&1, prefix))
       |> Enum.join("\n"), status}
    end

    def cmd("shuttle", args, opts) do
      if "mark-runtime" in args and Shuttle.Env.app(:prepared_fault) == :marker_failure do
        {"fixture marker write refused", 1}
      else
        result = FeltStoreRunner.cmd("shuttle", args, opts)

        if "mark-runtime" in args,
          do: send(Shuttle.Env.app(:prepared_owner), :prepared_marker_written)

        case {Shuttle.Env.app(:prepared_occurrences), result, "ls" in args or "show" in args} do
          {%{} = occurrences, {json, 0}, true} ->
            fibers = Jason.decode!(json)

            resolve = fn fiber ->
              if get_in(fiber, ["shuttle", "kind"]) == "standing",
                do:
                  put_in(
                    fiber,
                    ["shuttle", "resolved"],
                    Map.merge(get_in(fiber, ["shuttle", "resolved"]) || %{}, occurrences)
                  ),
                else: fiber
            end

            {Jason.encode!(
               if(is_list(fibers), do: Enum.map(fibers, resolve), else: resolve.(fibers))
             ), 0}

          _ ->
            result
        end
      end
    end

    def cmd(command, args, opts), do: FeltStoreRunner.cmd(command, args, opts)

    defp tmux(args, opts) do
      Shuttle.Runner.Default.cmd(
        "tmux",
        ["-S", Shuttle.Env.app(:prepared_socket), "-f", "/dev/null" | args],
        opts
      )
    end
  end

  setup do
    FeltStoreRunner.start!()
    root = FeltStoreRunner.felt_root()
    socket = Path.join(System.tmp_dir!(), "prepared-#{System.unique_integer([:positive])}.sock")
    Env.put_env("SHUTTLE_STORES", root)
    Env.put_env("SHUTTLE_DATA_DIR", Path.join(root, "data"))
    Env.put_env("SHUTTLE_SESSIONS_FILE", Path.join(root, "sessions.jsonl"))

    if System.find_executable("tmux"),
      do:
        System.cmd("tmux", [
          "-S",
          socket,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "sentinel",
          "sleep 300"
        ])

    Env.put_app_env(:prepared_socket, socket)
    Env.put_app_env(:prepared_owner, self())
    Env.put_app_env(:terminal_backend, Terminal.Tmux)

    on_exit(fn ->
      System.cmd("tmux", ["-S", socket, "kill-server"], stderr_to_stdout: true)
      File.rm_rf(root)
    end)

    %{root: root}
  end

  @tag :launch_record
  @tag skip: is_nil(System.find_executable("tmux"))
  test "an unobserved unmirrored scheduled execution cannot silently repeat", %{root: root} do
    id = "prepared-unobserved"
    FeltStoreRunner.set_fiber(id, make_fiber(id))

    FeltStoreRunner.set_shuttle(
      id,
      "kind: standing\nhost: test-host\nagent: claude-sonnet\nschedule:\n  expr: '* * * * *'\n  tz: UTC\n"
    )

    now = DateTime.utc_now()

    occurrences = %{
      "prev_due" => DateTime.to_iso8601(DateTime.add(now, -60)),
      "next_due" => DateTime.to_iso8601(DateTime.add(now, 60))
    }

    FeltStoreRunner.put_shuttle_fields(id, %{"resolved" => occurrences})
    Env.put_app_env(:prepared_occurrences, occurrences)

    Env.put_app_env(:prepared_effect_root, root)
    Env.put_app_env(:prepared_fault, :crash)

    assert catch_throw(
             Dispatcher.dispatch(id,
               runner: Runner,
               felt_store: root,
               prompt_context: {:standing_run, "scheduled-unrecorded"}
             )
           ) == :launch_crash

    assert_received :prepared_create
    session = Shuttle.Test.FiberUid.session(id)

    assert {:ok, %{"dispatch" => facts, "script" => script}} =
             Terminal.LaunchAttempts.get(session)

    assert Terminal.status(Runner, session) == :alive
    File.touch!(Path.join(root, "effect-go"))
    eventually(fn -> Terminal.status(Runner, session) == :gone and not File.exists?(script) end)
    assert File.read!(Path.join(root, "effects")) == "effect\n"
    refute get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"])
    Env.put_app_env(:prepared_fault, nil)

    assert Poller.StandingRoles.standing_role_due?(FeltStoreRunner.fiber(id))
    opts = [runner: Runner, felt_stores: [root], poll_interval_ms: 600_000, boot_quarantine: true]
    {:ok, poller} = start_poller!(opts)
    await_boot_cycle!(poller)
    assert_unresolved(poller, id, session, facts, root)
    before = :sys.get_state(poller).poll_cycles
    send(poller, :run_poll_cycle)
    eventually(fn -> :sys.get_state(poller).poll_cycles > before end)
    assert_unresolved(poller, id, session, facts, root)
    GenServer.stop(poller)
    {:ok, restarted} = start_poller!(opts)
    await_boot_cycle!(restarted)
    assert_unresolved(restarted, id, session, facts, root)

    for opts <- [[force: true], [force: true, resume_mode: "fresh"]] do
      assert {:error, {:launch_reserved, _}} = Poller.dispatch_fiber(restarted, id, opts)
    end

    refute_received :prepared_create
    assert File.read!(Path.join(root, "effects")) == "effect\n"
  end

  for conclusion <- [:review, :human_rearm, :accepted_close, :occurrence_rearm, :newer_run] do
    @tag :launch_record
    @tag skip: is_nil(System.find_executable("tmux"))
    test "recovered ad-hoc observed exit respects #{conclusion}", %{root: root} do
      id = "prepared-adhoc"
      FeltStoreRunner.set_fiber(id, make_fiber(id))

      FeltStoreRunner.set_shuttle(
        id,
        "kind: standing\nhost: test-host\nagent: claude-sonnet\nschedule:\n  expr: '0 0 * * *'\n  tz: UTC\n"
      )

      FeltStoreRunner.put_shuttle_fields(id, %{
        "dispatched_at" => "2026-01-01T00:00:00Z",
        "run_id" => "adhoc-predecessor"
      })

      Env.put_app_env(:prepared_effect_root, root)
      Env.put_app_env(:prepared_fault, :marker_failure)
      Env.put_app_env(:session_capture_retry_ms, 600_000)

      assert {:ok, session} =
               Dispatcher.dispatch(id,
                 runner: Runner,
                 felt_store: root,
                 prompt_context: {:standing_run, "adhoc-prepared", :ad_hoc},
                 force: true
               )

      assert {:ok, %{"dispatch" => facts}} = Terminal.LaunchAttempts.get(session)

      {:ok, poller} =
        start_poller!(
          runner: Runner,
          felt_stores: [root],
          poll_interval_ms: 600_000,
          heartbeat_interval_ms: 600_000
        )

      await_boot_cycle!(poller)
      [{_, worker}] = Map.to_list(:sys.get_state(poller).running)

      assert get_in(worker.run_observation, ["shuttle", "runtime", "dispatched_at"]) ==
               facts["dispatched_at"]

      assert get_in(worker.run_observation, ["shuttle", "runtime", "run_id"]) == "adhoc-prepared"
      assert worker.run_observation["uid"] == FeltStoreRunner.fiber(id)["uid"]
      assert worker.dispatch_mirror_pending
      Env.put_app_env(:prepared_fault, nil)
      send(poller, {:retry_prepared_dispatch, id, session})
      assert_receive :prepared_marker_written
      [{_, worker}] = Map.to_list(:sys.get_state(poller).running)
      refute worker[:dispatch_mirror_pending]

      assert get_in(worker.run_observation, ["shuttle", "runtime", "dispatched_at"]) ==
               facts["dispatched_at"]

      case unquote(conclusion) do
        :review ->
          :ok

        :human_rearm ->
          FeltStoreRunner.put_shuttle_fields(id, %{
            "handed_off_at" => "2099-01-01T00:00:00Z",
            "thread_exit_verb" => "rearmed"
          })

        :accepted_close ->
          FeltStoreRunner.put_shuttle_fields(id, %{
            "handed_off_at" => "2099-01-01T00:00:00Z",
            "thread_exit_verb" => "tempered"
          })

        :occurrence_rearm ->
          FeltStoreRunner.put_shuttle_fields(id, %{
            "handed_off_at" => facts["dispatched_at"],
            "thread_exit_verb" => "rearmed"
          })

        :newer_run ->
          FeltStoreRunner.put_shuttle_fields(id, %{
            "dispatched_at" => "2099-01-01T00:00:00Z",
            "run_id" => "adhoc-successor"
          })
      end

      before_exit = File.read!(FeltStoreRunner.fiber(id)["path"])
      monitor = Process.monitor(worker.pid)
      File.touch!(Path.join(root, "effect-go"))
      eventually(fn -> Terminal.status(Runner, session) == :gone end)
      for _ <- 1..3, do: send(worker.pid, :heartbeat)
      assert_receive {:DOWN, ^monitor, :process, _, :normal}
      eventually(fn -> :sys.get_state(poller).running == %{} end)

      if unquote(conclusion) == :review do
        assert FeltStoreRunner.fiber(id)["status"] == "closed"
        refute FeltStoreRunner.fiber(id)["tempered"]
      else
        assert File.read!(FeltStoreRunner.fiber(id)["path"]) == before_exit
      end
    end
  end

  defp assert_unresolved(poller, id, session, facts, root) do
    eventually(fn ->
      state = :sys.get_state(poller)
      map_size(state.dispatch_failures) > 0 or map_size(state.running) > 0
    end)

    assert :sys.get_state(poller).running == %{}
    assert {:ok, %{"dispatch" => ^facts}} = Terminal.LaunchAttempts.get(session)
    fiber = FeltStoreRunner.fiber(id)
    assert fiber["status"] == "active"
    refute get_in(fiber, ["shuttle", "runtime", "dispatched_at"])
    refute get_in(fiber, ["shuttle", "runtime", "handed_off_at"])
    assert File.read!(Path.join(root, "effects")) == "effect\n"
    eventually(fn -> Poller.snapshot(poller).blocked != [] end)
    assert [%{fiber_id: ^id, reason: reason}] = Poller.snapshot(poller).blocked
    assert reason =~ "--release-launch-reservation"
    assert reason =~ "may already have run and exited"
  end

  defp eventually(predicate, attempts \\ 3_000)

  defp eventually(predicate, attempts) when attempts > 0 do
    if predicate.(),
      do: :ok,
      else:
        (
          Process.sleep(10)
          eventually(predicate, attempts - 1)
        )
  end

  defp eventually(predicate, 0), do: assert(predicate.())

  @tag skip: is_nil(System.find_executable("tmux"))
  test "a live Poller retries a failed dispatch mirror without a restart", %{root: root} do
    id = "prepared-live-retry"
    FeltStoreRunner.set_fiber(id, make_fiber(id))

    FeltStoreRunner.set_shuttle(
      id,
      "kind: oneshot\nhost: test-host\nagent: claude-sonnet\nproject_dir: #{root}\n",
      "open"
    )

    Env.put_app_env(:session_capture_retry_ms, 60_000)
    {:ok, poller} = start_poller!(runner: Runner, felt_stores: [root])
    await_boot_cycle!(poller)
    Env.put_app_env(:prepared_fault, :marker_failure)
    assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true)
    assert {:ok, %{"dispatch" => facts}} = Terminal.LaunchAttempts.get(session)
    Env.put_app_env(:prepared_fault, nil)
    [{_, worker}] = Map.to_list(:sys.get_state(poller).running)
    send(poller, {:retry_identity, id, worker.identity_token})
    assert_receive :prepared_marker_written
    :sys.get_state(poller)
    assert Poller.session_uuid(poller, id) == facts["session_uuid"]

    assert get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) ==
             facts["dispatched_at"]
  end

  @tag skip: is_nil(System.find_executable("tmux"))
  test "a mirrored launch retains its intent until the successor receiver is durable", %{
    root: root
  } do
    id = "prepared-stale-receiver"
    FeltStoreRunner.set_fiber(id, make_fiber(id))

    FeltStoreRunner.set_shuttle(
      id,
      "kind: oneshot\nhost: test-host\nagent: claude-sonnet\n",
      "active"
    )

    session = Shuttle.Test.FiberUid.session(id)
    key = root <> ":" <> Shuttle.Test.FiberUid.for(id)
    address = Shuttle.Messaging.address("test-host", "claude", "old-uuid")

    assert {:ok, _} =
             Shuttle.CLI.run(
               ["context-mailbox", "receiver", key, session <> ":old-uuid", address],
               env: [{"SHUTTLE_HOST", "test-host"}]
             )

    assert {:ok, ^session} = Dispatcher.dispatch(id, runner: Runner, felt_store: root)
    assert {:ok, %{"dispatch" => facts}} = Terminal.LaunchAttempts.get(session)
    {:ok, poller} = start_poller!(runner: Runner, felt_stores: [root])
    await_boot_cycle!(poller)
    assert Poller.session_uuid(poller, id) == facts["session_uuid"]
    assert {:ok, attempt} = Terminal.LaunchAttempts.get(session)
    refute attempt["dispatch"]
  end

  @tag skip: is_nil(System.find_executable("tmux"))
  test "a failed recovery mirror holds prepared identity instead of a predecessor receiver", %{
    root: root
  } do
    id = "prepared-recovery-retry"
    FeltStoreRunner.set_fiber(id, make_fiber(id))

    FeltStoreRunner.set_shuttle(
      id,
      "kind: oneshot\nhost: test-host\nagent: claude-sonnet\n",
      "active"
    )

    session = Shuttle.Test.FiberUid.session(id)
    key = root <> ":" <> Shuttle.Test.FiberUid.for(id)
    address = Shuttle.Messaging.address("test-host", "claude", "old-uuid")

    assert {:ok, _} =
             Shuttle.CLI.run(
               ["context-mailbox", "receiver", key, session <> ":old-uuid", address],
               env: [{"SHUTTLE_HOST", "test-host"}]
             )

    Env.put_app_env(:prepared_fault, :marker_failure)
    assert {:ok, ^session} = Dispatcher.dispatch(id, runner: Runner, felt_store: root)
    assert {:ok, %{"dispatch" => facts}} = Terminal.LaunchAttempts.get(session)
    {:ok, poller} = start_poller!(runner: Runner, felt_stores: [root])
    await_boot_cycle!(poller)
    assert Poller.session_uuid(poller, id) == facts["session_uuid"]
    Env.put_app_env(:prepared_fault, nil)
    send(poller, {:retry_prepared_dispatch, id, session})
    assert_receive :prepared_marker_written
    :sys.get_state(poller)

    assert get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) ==
             facts["dispatched_at"]
  end

  @tag skip: is_nil(System.find_executable("tmux"))
  test "an execution that exits before adoption cannot project prepared metadata", %{root: root} do
    id = "prepared-exited"
    FeltStoreRunner.set_fiber(id, make_fiber(id))

    FeltStoreRunner.set_shuttle(
      id,
      "kind: oneshot\nhost: test-host\nagent: claude-sonnet\n",
      "active"
    )

    Env.put_app_env(:prepared_fault, :crash)
    assert catch_throw(Dispatcher.dispatch(id, runner: Runner, felt_store: root)) == :launch_crash
    session = Shuttle.Test.FiberUid.session(id)
    assert {"", 0} = Terminal.stop(Runner, session)
    assert :none = Terminal.LaunchAttempts.prepared(session, Runner)
    refute get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"])
  end

  for fault <- [:crash, :marker_failure] do
    @tag skip: is_nil(System.find_executable("tmux"))
    test "private tmux survives #{fault} and adoption recovers its prepared dispatch", %{
      root: root
    } do
      id = "prepared-real"
      FeltStoreRunner.set_fiber(id, make_fiber(id))

      FeltStoreRunner.set_shuttle(
        id,
        "kind: oneshot\nhost: test-host\nagent: claude-sonnet\nproject_dir: #{root}\n",
        "active"
      )

      Env.put_app_env(:prepared_fault, unquote(fault))

      if unquote(fault) == :crash do
        assert catch_throw(Dispatcher.dispatch(id, runner: Runner, felt_store: root)) ==
                 :launch_crash
      else
        assert {:ok, _} = Dispatcher.dispatch(id, runner: Runner, felt_store: root)
      end

      session = Shuttle.Test.FiberUid.session(id)
      assert {:ok, %{"dispatch" => facts}} = Terminal.LaunchAttempts.get(session)
      assert :alive = Terminal.status(Runner, session)
      Env.put_app_env(:prepared_fault, nil)
      {:ok, poller} = start_poller!(runner: Runner, felt_stores: [root])
      await_boot_cycle!(poller)
      assert Poller.session_uuid(poller, id) == facts["session_uuid"]

      assert get_in(FeltStoreRunner.fiber(id), ["shuttle", "runtime", "dispatched_at"]) ==
               facts["dispatched_at"]

      assert {:ok, attempt} = Terminal.LaunchAttempts.get(session)
      refute attempt["dispatch"]
    end
  end
end
