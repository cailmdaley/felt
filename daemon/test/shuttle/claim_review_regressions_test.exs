defmodule Shuttle.ClaimReviewRegressionsTest do
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

  defp scripts do
    for {"tmux", ["new-session" | _] = args} <- Runner.commands(),
        do: {Enum.at(args, 3), File.read!(List.last(args))}
  end

  # a launched worker claims without its conversation id ──
  test "a launched worker's claim that names only its pane releases its fiber" do
    poller = start()
    worker = launch!(poller, "tests/a")

    assert {:ok, _} =
             Poller.claim_session(poller, "tests/b", worker.session, tmux_pane: "%#{worker.pane}")

    a = Poller.worker_status(poller, "tests/a")
    b = Poller.worker_status(poller, "tests/b")

    assert a == nil, "A still tracked on the worker that now serves B"
    assert concluded?("tests/a")
    assert %{} = b
    Poller.kill_session(poller, "tests/a")
    assert signals() == []
  end

  test "after a pane-only claimer exits, the released fiber never resumes the conversation the claimed one took" do
    poller = start()
    worker = launch!(poller, "tests/a")
    write_transcript(worker.uuid)

    assert {:ok, _} =
             Poller.claim_session(poller, "tests/b", worker.session, tmux_pane: "%#{worker.pane}")

    Runner.remove_tmux_session(worker.session)
    assert wait_until(fn -> Poller.worker_status(poller, "tests/a") == nil end)
    assert wait_until(fn -> Poller.worker_status(poller, "tests/b") == nil end)
    poll(poller)

    result = Poller.dispatch_fiber(poller, "tests/a", [])

    a_script =
      case result do
        {:ok, s} -> scripts() |> Enum.filter(&(elem(&1, 0) == s)) |> List.last() |> elem(1)
        _ -> ""
      end

    refute a_script =~ "--resume '#{worker.uuid}'"
  end

  # the board's History "resume" of a closed fiber's conversation ──
  test "a History resume of a closed fiber's last conversation is not killed" do
    uuid = "6d688234-9445-4d16-93d3-6bef110ea700"

    Runner.put_shuttle_fields("tests/a", %{
      "dispatched_at" => "2026-10-20T00:00:00Z",
      "session_uuid" => uuid
    })

    Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "closed"))
    tmux = "resume-#{uuid}"
    Runner.add_tmux_session(tmux)
    Runner.set_panes(%{9500 => tmux})
    Runner.set_ps_result({"9500 1 bash -lc x\n9501 9500 claude --resume #{uuid}\n", 0})

    poller = start()
    poll(poller)

    assert signals() == []
  end

  test "a History resume of a paused fiber's conversation is neither adopted nor stopped" do
    uuid = "6d688234-9445-4d16-93d3-6bef110ea701"

    Runner.put_shuttle_fields("tests/a", %{
      "dispatched_at" => "2026-10-20T00:00:00Z",
      "session_uuid" => uuid
    })

    Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "open"))
    tmux = "resume-#{uuid}"
    Runner.add_tmux_session(tmux)
    Runner.set_panes(%{9600 => tmux})
    Runner.set_ps_result({"9600 1 bash -lc x\n9601 9600 claude --resume #{uuid}\n", 0})

    poller = start()
    poll(poller)
    Poller.kill_session(poller, "tests/a")
    assert signals() == []
  end

  # a pane-bound claimer is its pane's shell ──
  test "a claimed harness that exits frees its fiber, and that fiber's stop never reaches the pane's next claimer" do
    u1 = "6d688234-9445-4d16-93d3-6bef110ea702"
    u2 = "6d688234-9445-4d16-93d3-6bef110ea703"
    Runner.add_tmux_session("human")
    Runner.set_panes(%{9100 => "human"})
    Runner.set_ps_result({"9100 1 -zsh\n9101 9100 claude --model opus\n", 0})
    poller = start()

    assert {:ok, _} =
             Poller.claim_session(poller, "tests/b", "human",
               session_uuid: u1,
               tmux_pane: "%9100"
             )

    # The harness exits; the shell stays.
    Runner.set_ps_result({"9100 1 -zsh\n", 0})
    poll(poller)

    # A new harness in the same pane claims C by its conversation.
    Runner.set_ps_result({"9100 1 -zsh\n9102 9100 claude --session-id #{u2}\n", 0})

    assert {:ok, _} =
             Poller.claim_session(poller, "tests/c", "human",
               session_uuid: u2,
               tmux_pane: "%9100"
             )

    Poller.kill_session(poller, "tests/b")
    assert signals() == []
  end

  # a stop of a holder outside tmux climbs to the outermost own-uid ancestor ──
  test "a holder outside tmux is never signalled as a worker" do
    uuid = "6d688234-9445-4d16-93d3-6bef110ea704"

    Runner.put_shuttle_fields("tests/a", %{
      "dispatched_at" => "2026-10-20T00:00:00Z",
      "session_uuid" => uuid
    })

    Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "open"))

    Runner.set_ps_result(
      {"500 1 /lib/systemd/systemd --user\n600 500 /usr/libexec/gnome-terminal-server\n" <>
         "700 600 bash\n701 700 claude --resume #{uuid}\n", 0}
    )

    poller = start()
    poll(poller)
    Poller.kill_session(poller, "tests/a")
    refute Enum.any?(signals(), &match?({"kill", [_, "--", "-500" | _]}, &1))
  end

  # a claim right after /clear, before the poll follows the conversation ──
  test "a claim naming the post-/clear conversation releases the launching fiber" do
    poller = start()
    worker = launch!(poller, "tests/a")
    u2 = "6d688234-9445-4d16-93d3-6bef110ea705"
    key = {"claude", worker.pane, "start-#{worker.pane}"}

    binding = %{
      members: %{worker.uuid => key, u2 => key},
      processes: %{
        key => %{
          current: u2,
          members: MapSet.new([worker.uuid, u2]),
          at: System.system_time(:millisecond),
          retired: false,
          starts: []
        }
      }
    }

    Env.put_app_env(:session_bindings_source, fn -> binding end)

    assert {:ok, _} =
             Poller.claim_session(poller, "tests/b", worker.session,
               session_uuid: u2,
               tmux_pane: "%#{worker.pane}"
             )

    assert Poller.worker_status(poller, "tests/a") == nil
    assert concluded?("tests/a")
    poll(poller)
    Poller.kill_session(poller, "tests/a")
    assert signals() == []
  end

  # as P2, with the closed row listed the way production `shuttle ls
  # --json --any field:shuttle` lists it 
  test "with closed rows listed as in production, a History resume of a closed fiber is not killed" do
    uuid = "6d688234-9445-4d16-93d3-6bef110ea706"

    Runner.put_shuttle_fields("tests/a", %{
      "dispatched_at" => "2026-10-20T00:00:00Z",
      "session_uuid" => uuid
    })

    Runner.set_fiber("tests/a", Map.put(Runner.fiber("tests/a"), "status", "closed"))
    tmux = "resume-#{uuid}"
    Runner.add_tmux_session(tmux)
    Runner.set_panes(%{9700 => tmux})
    Runner.set_ps_result({"9700 1 bash -lc x\n9701 9700 claude --resume #{uuid}\n", 0})

    poller = start()
    state = :sys.get_state(poller, @state_timeout)
    [store] = Map.keys(state.last_known_listings)
    row = Runner.fiber("tests/a")

    state = %{
      state
      | last_known_listings: Map.update!(state.last_known_listings, store, &[row | &1])
    }

    _ =
      Shuttle.Poller.SessionReconciliation.reconcile_orphaned_sessions(
        state,
        Shuttle.WorkerProcess.scan(Runner),
        true
      )

    assert signals() == []
  end
end
