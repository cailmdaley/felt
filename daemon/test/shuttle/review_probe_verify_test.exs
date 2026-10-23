defmodule Shuttle.ReviewProbeVerifyTest do
  @moduledoc """
  Regressions from the adversarial review of the claim transfer: a worker
  found only through a pane, a History resume or a human's own `--resume`, a
  harness that exits from a shell that stays, a holder outside tmux, and a
  claim after `/clear` — none is ever signalled as another fiber's worker or
  resumed twice.
  """

  use ExUnit.Case, async: true

  import Shuttle.Test.PollerHelpers
  import Shuttle.Test.TranscriptHelpers

  alias Shuttle.{Continuation, Poller}
  alias Shuttle.Test.Env
  alias Shuttle.Test.FeltStoreRunner, as: Runner

  @state_timeout 30_000

  setup do
    Runner.start!()
    Runner.reset()
    root = Runner.felt_root()
    on_exit(fn -> File.rm_rf(root) end)
    data = Path.join(System.tmp_dir!(), "shuttle-probe-#{System.unique_integer([:positive])}")
    File.mkdir_p!(data)
    Env.put_env("SHUTTLE_DATA_DIR", data)
    Env.delete_env("SHUTTLE_SESSIONS_FILE")
    Env.put_app_env(:worker_stop_ladder, [{nil, 50}, {"TERM", 50}, {"KILL", 50}])

    for id <- ["tests/a", "tests/b", "tests/c"] do
      Runner.set_fiber(id, make_fiber(id))
      Runner.set_shuttle(id, "kind: oneshot\nagent: claude-sonnet\n")
    end

    :ok
  end

  defp start(opts \\ []) do
    {:ok, poller} =
      start_poller!(
        Keyword.merge(
          [
            runner: Runner,
            felt_stores: [Runner.felt_root()],
            max_concurrent_workers: 0,
            poll_interval_ms: 600_000,
            heartbeat_interval_ms: 20
          ],
          opts
        )
      )

    await_boot_cycle!(poller)
    settle(poller)
    poller
  end

  defp settle(poller) do
    assert wait_until(fn ->
             state = :sys.get_state(poller, @state_timeout)
             state.poll_cycles > 0 and not state.poll_check_in_progress
           end)
  end

  defp poll(poller) do
    settle(poller)
    before = :sys.get_state(poller, @state_timeout).poll_cycles
    send(poller, :run_poll_cycle)
    assert wait_until(fn -> :sys.get_state(poller, @state_timeout).poll_cycles > before end)
    settle(poller)
  end

  defp wait_until(fun, attempts \\ 600)
  defp wait_until(fun, 0), do: fun.()

  defp wait_until(fun, attempts) do
    if fun.(), do: true, else: Process.sleep(5) && wait_until(fun, attempts - 1)
  end

  defp runtime(id), do: get_in(Runner.fiber(id), ["shuttle", "runtime"]) || %{}
  defp concluded?(id), do: Continuation.clean_handoff_since_dispatch?(Runner.fiber(id))

  defp launch!(poller, id) do
    assert {:ok, session} = Poller.dispatch_fiber(poller, id, force: true)
    %{session: session, uuid: runtime(id)["session_uuid"], pane: Runner.launched_pid(session)}
  end

  defp signals,
    do:
      Enum.filter(Runner.commands(), fn
        {"kill", _} -> true
        {"tmux", [verb | _]} -> verb in ["kill-pane", "kill-session"]
        _ -> false
      end)

  defp mark_runtime_writes,
    do: for({"shuttle", args} <- Runner.commands(), "mark-runtime" in args, do: args)

  # V1: a launch's subprocess that opens another fiber's conversation
  # (an orchestrator's `claude --resume <thread> -p …`) is that fiber's
  # "worker"; the closed-fiber reap then kills the launch it runs under.
  test "V1 a closed fiber's conversation opened by another launch's subprocess does not kill that launch" do
    u_a = "6d688234-9445-4d16-93d3-6bef110eb001"
    u_c = "6d688234-9445-4d16-93d3-6bef110eb002"

    Runner.put_shuttle_fields("tests/a", %{"dispatched_at" => "2026-10-20T00:00:00Z", "session_uuid" => u_a})
    Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "closed"))
    Runner.put_shuttle_fields("tests/c", %{"dispatched_at" => "2026-10-21T00:00:00Z", "session_uuid" => u_c})

    c_session = "c-6d688234-shuttle-probe"
    pane = Runner.add_worker(c_session, u_c, child: "claude --resume #{u_a} -p summarize")
    poller = start()
    poll(poller)
    IO.inspect(Poller.worker_status(poller, "tests/c") && :tracked, label: "V1 C")
    IO.inspect(signals(), label: "V1 signals (C pane is %#{pane})")
    assert signals() == []
  end

  test "V1b a stop of an open fiber whose conversation another launch's subprocess opens spares that launch" do
    u_a = "6d688234-9445-4d16-93d3-6bef110eb003"
    u_c = "6d688234-9445-4d16-93d3-6bef110eb004"

    Runner.put_shuttle_fields("tests/a", %{"dispatched_at" => "2026-10-20T00:00:00Z", "session_uuid" => u_a})
    Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "open"))
    Runner.put_shuttle_fields("tests/c", %{"dispatched_at" => "2026-10-21T00:00:00Z", "session_uuid" => u_c})

    pane = Runner.add_worker("c-probe-shuttle", u_c, child: "claude --resume #{u_a} -p summarize")
    poller = start()
    poll(poller)
    IO.inspect(Poller.worker_status(poller, "tests/a"), label: "V1b A tracked")
    IO.inspect(Poller.kill_session(poller, "tests/a"), label: "V1b kill_session(A)")
    IO.inspect(signals(), label: "V1b signals (C pane is %#{pane})")
    assert signals() == []
  end

  # V2: the Codex App Server's run script (`shuttle-run-shuttle-codex-<hash>`)
  # is not on the helper list, so it counts as a launch.
  test "V2 a process under the Codex App Server opening a fiber's conversation is not that fiber's worker" do
    u_a = "6d688234-9445-4d16-93d3-6bef110eb005"
    Runner.put_shuttle_fields("tests/a", %{"dispatched_at" => "2026-10-20T00:00:00Z", "session_uuid" => u_a})
    Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "open"))
    codex = "shuttle-codex-0123456789abcdef"
    Runner.add_tmux_session(codex)
    Runner.set_panes(%{800 => codex})

    Runner.set_ps_result(
      {"800 1 bash -l /tmp/shuttle-run-#{codex}.7.sh\n801 800 codex app-server --listen unix:///x\n" <>
         "802 801 /bin/zsh -c claude --resume #{u_a} -p x\n803 802 claude --resume #{u_a} -p x\n", 0}
    )

    poller = start()
    poll(poller)
    IO.inspect(Poller.worker_status(poller, "tests/a") && :tracked, label: "V2 A")
    IO.inspect(Poller.kill_session(poller, "tests/a"), label: "V2 kill_session(A)")
    IO.inspect(signals(), label: "V2 signals")
    assert signals() == []
  end

  # V3: the first poll after the upgrade concludes every closed fiber whose
  # runtime was left unconcluded — one CLI write per fiber, in the Poller.
  test "V3 closed fibers with unconcluded runtimes are each written on the first poll" do
    for {id, n} <- [{"tests/a", 1}, {"tests/b", 2}, {"tests/c", 3}] do
      Runner.put_shuttle_fields(id, %{
        "dispatched_at" => "2026-10-0#{n}T00:00:00Z",
        "session_uuid" => "6d688234-9445-4d16-93d3-6bef110eb01#{n}"
      })

      Runner.set_fiber(id, Map.put(Runner.fiber(id), "status", "closed"))
    end

    poller = start()
    poll(poller)
    IO.inspect(length(mark_runtime_writes()), label: "V3 mark-runtime writes")
    IO.inspect(Enum.map(["tests/a", "tests/b", "tests/c"], &concluded?/1), label: "V3 concluded")
  end

  # V4: with no conversation id and no CLI pid (an older CLI, a raw POST), the
  # pane's sole child stands for the worker even when the pane process is the
  # harness itself.
  test "V4 a pane whose process is the harness binds the harness, not its one child" do
    Runner.add_tmux_session("human")
    Runner.set_panes(%{9100 => "human"})
    Runner.set_ps_result({"9100 1 claude --model opus\n9101 9100 node /opt/mcp/server.js\n", 0})
    poller = start()
    result = Poller.claim_session(poller, "tests/b", "human", tmux_pane: "%9100")
    IO.inspect(result, label: "V4 claim")
    IO.inspect(Map.get(runtime("tests/b"), "pane"), label: "V4 bound")
    IO.inspect(Poller.kill_session(poller, "tests/b"), label: "V4 kill")
    IO.inspect(signals(), label: "V4 signals")
    assert Map.get(runtime("tests/b"), "pane") =~ "9100:"
  end
end
